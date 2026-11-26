import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, DeleteObjectsCommand, GetBucketAclCommand,
  HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutBucketAclCommand, PutObjectCommand,
  type HeadObjectCommandOutput, type S3Client,
} from '@aws-sdk/client-s3';
import type pg from 'pg';
import { z } from 'zod';
import {
  RollikeyError, assertRunId, completeAction, evaluateBulk, noteActionError, recordAction, type SnapshotRow,
} from './ledger.js';

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const bucketSchema = z.string().regex(BUCKET, 'invalid bucket name');
const keySchema = z.string().min(1).max(1024);

export const s3PutRequestSchema = z.object({
  runId: z.string(),
  bucket: bucketSchema.optional(),
  key: keySchema,
  body: z.string().max(5_000_000),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  contentType: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export const s3DeleteRequestSchema = z
  .object({
    runId: z.string(),
    bucket: bucketSchema.optional(),
    keys: z.array(keySchema).min(1).max(5000).optional(),
    prefix: z.string().min(1).max(1024).optional(),
  })
  .refine((r) => Boolean(r.keys) !== Boolean(r.prefix), { message: 'Provide exactly one of keys or prefix' });
export const s3AclRequestSchema = z.object({
  runId: z.string(),
  bucket: bucketSchema.optional(),
  acl: z.enum(['private', 'public-read', 'public-read-write', 'authenticated-read']),
});
export type S3PutRequest = z.input<typeof s3PutRequestSchema>;
export type S3DeleteRequest = z.input<typeof s3DeleteRequestSchema>;
export type S3AclRequest = z.input<typeof s3AclRequestSchema>;

export interface ObjectHead {
  contentType?: string;
  contentLength: number;
  etag: string;
  metadata: Record<string, string>;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
}
export interface VaultedObject { key: string; existed: boolean; head?: ObjectHead; vaultKey?: string }

export type S3Result =
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; bucket: string; objects: number; keys: string[]; etag?: string; amountCents: 0 }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; reason: string; amountCents: 0 };

export interface S3ProxyDeps {
  pool: pg.Pool;
  s3: S3Client;
  defaultBucket: string;
  vaultBucket: string;
  maxBulkItems: number;
}

const toHead = (o: HeadObjectCommandOutput): ObjectHead => ({
  ...(o.ContentType ? { contentType: o.ContentType } : {}),
  contentLength: Number(o.ContentLength ?? 0),
  etag: String(o.ETag ?? '').replace(/"/g, ''),
  metadata: o.Metadata ?? {},
  ...(o.CacheControl ? { cacheControl: o.CacheControl } : {}),
  ...(o.ContentDisposition ? { contentDisposition: o.ContentDisposition } : {}),
  ...(o.ContentEncoding ? { contentEncoding: o.ContentEncoding } : {}),
  ...(o.ContentLanguage ? { contentLanguage: o.ContentLanguage } : {}),
});
const isMissing = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x.name === 'NotFound' || x.name === 'NoSuchKey' || x.$metadata?.httpStatusCode === 404;
};
const encodeCopySource = (bucket: string, key: string) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** AWS S3 connector: vault-backed snapshots, bulk-delete / public-ACL gate, LIFO restore. */
export class S3Proxy {
  constructor(private readonly deps: S3ProxyDeps) {}

  private bucketOf(b?: string): string {
    const bucket = b ?? this.deps.defaultBucket;
    if (bucket === this.deps.vaultBucket) throw new RollikeyError('protected_bucket', `Bucket "${bucket}" is the Rollikey recovery vault and cannot be mutated by agents`);
    return bucket;
  }

  async ensureBuckets(): Promise<void> {
    for (const b of [this.deps.defaultBucket, this.deps.vaultBucket]) {
      try { await this.deps.s3.send(new HeadBucketCommand({ Bucket: b })); }
      catch { await this.deps.s3.send(new CreateBucketCommand({ Bucket: b })).catch((e) => { if (!/BucketAlready/.test(String(e?.name))) throw e; }); }
    }
  }

  private async head(bucket: string, key: string): Promise<ObjectHead | null> {
    try { return toHead(await this.deps.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))); }
    catch (e) { if (isMissing(e)) return null; throw e; }
  }

  /** Copy the live object (bytes + metadata, server-side) into the vault. */
  private async vault(runId: string, bucket: string, key: string): Promise<VaultedObject> {
    const head = await this.head(bucket, key);
    if (!head) return { key, existed: false };
    const vaultKey = `${runId}/${randomUUID()}/${key}`;
    await this.deps.s3.send(new CopyObjectCommand({
      Bucket: this.deps.vaultBucket, Key: vaultKey, CopySource: encodeCopySource(bucket, key), MetadataDirective: 'COPY',
    }));
    return { key, existed: true, head, vaultKey };
  }

  async putObject(input: S3PutRequest): Promise<S3Result> {
    const req = s3PutRequestSchema.parse(input);
    assertRunId(req.runId);
    const bucket = this.bucketOf(req.bucket);
    const v = await this.vault(req.runId, bucket, req.key);
    const snap = await recordAction(this.deps.pool, {
      runId: req.runId, actionType: 's3.put', target: `s3://${bucket}/${req.key}`, status: 'pending',
      request: { ...req, body: req.body.length > 2000 ? `${req.body.slice(0, 2000)}…[${req.body.length} chars]` : req.body },
      beforeState: { bucket, objects: [v] }, rowsAffected: 1, amountCents: 0,
    });
    const base = { runId: req.runId, seq: snap.seq, snapshotId: snap.id, amountCents: 0 as const };
    try {
      const out = await this.deps.s3.send(new PutObjectCommand({
        Bucket: bucket, Key: req.key, Body: Buffer.from(req.body, req.encoding === 'base64' ? 'base64' : 'utf8'),
        ...(req.contentType ? { ContentType: req.contentType } : {}), ...(req.metadata ? { Metadata: req.metadata } : {}),
      }));
      const etag = String(out.ETag ?? '').replace(/"/g, '');
      await completeAction(this.deps.pool, snap.id, { bucket, key: req.key, etag });
      return { status: 'applied', ...base, bucket, objects: 1, keys: [req.key], etag };
    } catch (err) {
      await noteActionError(this.deps.pool, snap.id, (err as Error).message);
      throw err;
    }
  }

  async deleteObjects(input: S3DeleteRequest): Promise<S3Result> {
    const req = s3DeleteRequestSchema.parse(input);
    assertRunId(req.runId);
    const bucket = this.bucketOf(req.bucket);
    const limit = this.deps.maxBulkItems;
    let keys: string[];
    if (req.keys) keys = [...new Set(req.keys)];
    else {
      keys = [];
      let token: string | undefined;
      do {
        const page = await this.deps.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: req.prefix, ContinuationToken: token }));
        keys.push(...(page.Contents ?? []).map((o) => o.Key!));
        token = page.NextContinuationToken;
      } while (token && keys.length <= limit);
    }
    const reason = evaluateBulk(keys.length, limit, 'objects');
    const target = `s3://${bucket}/${req.keys ? `[${keys.length} keys]` : `${req.prefix}*`}`;
    if (reason) {
      const snap = await recordAction(this.deps.pool, {
        runId: req.runId, actionType: 's3.delete', target, status: 'blocked', request: req, beforeState: { bucket, objects: [] },
        rowsAffected: keys.length, amountCents: 0, blockReason: reason,
      });
      return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
    }
    const objects: VaultedObject[] = [];
    for (const key of keys) objects.push(await this.vault(req.runId, bucket, key));
    const existing = objects.filter((o) => o.existed);
    const snap = await recordAction(this.deps.pool, {
      runId: req.runId, actionType: 's3.delete', target, status: 'pending', request: req, beforeState: { bucket, objects },
      rowsAffected: existing.length, amountCents: 0,
    });
    try {
      if (existing.length) {
        const out = await this.deps.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: existing.map((o) => ({ Key: o.key })), Quiet: true } }));
        if (out.Errors?.length) throw new Error(`S3 delete errors: ${out.Errors.map((e) => `${e.Key}: ${e.Message}`).join('; ')}`);
      }
      await completeAction(this.deps.pool, snap.id, { bucket, deleted: existing.map((o) => o.key) });
      return { status: 'applied', runId: req.runId, seq: snap.seq, snapshotId: snap.id, bucket, objects: existing.length, keys: existing.map((o) => o.key), amountCents: 0 };
    } catch (err) {
      await noteActionError(this.deps.pool, snap.id, (err as Error).message);
      throw err;
    }
  }

  async setBucketAcl(input: S3AclRequest): Promise<S3Result> {
    const req = s3AclRequestSchema.parse(input);
    assertRunId(req.runId);
    const bucket = this.bucketOf(req.bucket);
    const isPublic = req.acl !== 'private';
    const grants = await this.deps.s3.send(new GetBucketAclCommand({ Bucket: bucket })).catch(() => null);
    const before = { bucket, owner: grants?.Owner ?? null, grants: grants?.Grants ?? [], objects: [] };
    if (isPublic) {
      const reason = `Public-exposure gate: setting bucket ACL "${req.acl}" would make "${bucket}" publicly accessible`;
      const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType: 's3.acl', target: `s3://${bucket}`, status: 'blocked', request: req, beforeState: before, rowsAffected: 1, amountCents: 0, blockReason: reason });
      return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
    }
    const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType: 's3.acl', target: `s3://${bucket}`, status: 'pending', request: req, beforeState: before, rowsAffected: 1, amountCents: 0 });
    try {
      await this.deps.s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: 'private' }));
      await completeAction(this.deps.pool, snap.id, { bucket, acl: 'private' });
      return { status: 'applied', runId: req.runId, seq: snap.seq, snapshotId: snap.id, bucket, objects: 0, keys: [], amountCents: 0 };
    } catch (err) {
      await noteActionError(this.deps.pool, snap.id, (err as Error).message);
      throw err;
    }
  }

  // ---- inverse used by revert() ----------------------------------------------------------------
  async restore(snap: SnapshotRow): Promise<Record<string, unknown>> {
    const { s3, vaultBucket } = this.deps;
    const before = snap.before_state as { bucket: string; objects: VaultedObject[] };
    const bucket = before.bucket;
    const after = (snap.after_state ?? {}) as { etag?: string };
    if (snap.action_type === 's3.acl') return { type: 'acl_noop', bucket, note: 'ACL was only ever set to private; nothing to undo' };
    const restored: string[] = [];
    const removed: string[] = [];
    const drifted: string[] = [];
    // LIFO inside the snapshot too.
    for (const obj of [...before.objects].reverse()) {
      if (snap.action_type === 's3.put') {
        const cur = await this.head(bucket, obj.key);
        if (cur && after.etag && cur.etag !== after.etag) drifted.push(obj.key);
      }
      if (!obj.existed) {
        // Newly created by the agent: remove it.
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.key }));
        removed.push(obj.key);
        continue;
      }
      await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: obj.key, CopySource: encodeCopySource(vaultBucket, obj.vaultKey!), MetadataDirective: 'COPY' }));
      const now = await this.head(bucket, obj.key);
      if (!now || now.etag !== obj.head!.etag || now.contentLength !== obj.head!.contentLength) {
        throw new RollikeyError('restore_mismatch', `Restored ${obj.key} does not match the vaulted original (etag ${now?.etag} vs ${obj.head!.etag})`);
      }
      restored.push(obj.key);
    }
    return { type: snap.action_type === 's3.put' ? 's3_put_reverted' : 's3_objects_restored', bucket, restored, removed, drifted };
  }
}
