/**
 * Integration tests for the Phase 2B connectors against the local Docker stack
 * (Postgres, Redis, MinIO) plus the offline GitHub sandbox and Slack sink.
 *   docker compose up -d && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createRollikey, type Rollikey } from '../src/engine/index.js';
import { evaluateBulk } from '../src/engine/ledger.js';
import { migrate } from '../src/scripts/migrate.js';

let sp: Rollikey;
const rid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const bucket = () => sp.config.s3.defaultBucket;
const text = async (key: string) => (await (await sp.infra.s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }))).Body!.transformToString());
const head = async (key: string) => sp.infra.s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
const exists = async (key: string) => head(key).then(() => true, () => false);
const seed = (key: string, body: string, extra: Record<string, unknown> = {}) =>
  sp.infra.s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ...extra }));

before(async () => {
  assert.ok(!sp?.github.live, 'tests must never run against live GitHub');
  sp = createRollikey({ log: () => {} });
  await migrate(sp.infra.pool);
  await sp.init();
  assert.equal(sp.github.live, false, 'tests must use the offline GitHub sandbox');
  assert.equal(sp.slack.backend, 'sink', 'tests must use the local Slack sink');
});
after(() => sp.close());

describe('bulk gate helper', () => {
  it('blocks strictly above the limit', () => {
    assert.equal(evaluateBulk(10, 10, 'objects'), null);
    assert.match(evaluateBulk(11, 10, 'objects')!, /affects 11 objects \(limit 10/);
  });
});

describe('S3 connector', () => {
  it('overwrite + new object: revert restores exact bytes/metadata (LIFO) and removes the new object', async () => {
    const runId = rid('s3');
    const key = `t/${runId}/config.json`;
    const fresh = `t/${runId}/new.txt`;
    const original = JSON.stringify({ v: 1, note: 'ünïcode ✓' });
    await seed(key, original, { ContentType: 'application/json', Metadata: { owner: 'ops', rev: '7' }, CacheControl: 'max-age=60' });
    const before = await head(key);

    const a = await sp.putObject({ runId, key, body: '{"v":2}', contentType: 'text/plain', metadata: { owner: 'agent' } });
    const b = await sp.putObject({ runId, key: fresh, body: 'hello' });
    assert.equal(a.status, 'applied'); assert.equal(b.status, 'applied');
    assert.equal(await text(key), '{"v":2}');
    assert.ok(await exists(fresh));

    const report = await sp.revert(runId);
    assert.ok(report.complete);
    assert.deepEqual(report.steps.map((s) => s.seq), [2, 1], 'LIFO order');
    assert.equal(await text(key), original);
    const after = await head(key);
    assert.equal(after.ETag, before.ETag);
    assert.equal(after.ContentType, 'application/json');
    assert.deepEqual(after.Metadata, { owner: 'ops', rev: '7' });
    assert.equal(after.CacheControl, 'max-age=60');
    assert.equal(await exists(fresh), false, 'newly created object removed');
    assert.equal((await sp.revert(runId)).steps.length, 0, 'idempotent');
    await sp.infra.s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  });

  it('snapshots and restores binary bytes after delete', async () => {
    const runId = rid('s3bin');
    const key = `t/${runId}/blob.bin`;
    const bytes = Buffer.from([0, 255, 1, 254, 128, 7, 0, 0, 42]);
    await seed(key, bytes, { ContentType: 'application/octet-stream' });
    const r = await sp.deleteObjects({ runId, keys: [key] });
    assert.equal(r.status, 'applied');
    assert.equal(await exists(key), false);
    assert.ok((await sp.revert(runId)).complete);
    const got = Buffer.from(await (await sp.infra.s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }))).Body!.transformToByteArray());
    assert.ok(got.equals(bytes));
    await sp.infra.s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  });

  it('blocks bulk deletion (>10 objects) and deletes nothing', async () => {
    const runId = rid('s3bulk');
    const prefix = `t/${runId}/`;
    for (let i = 0; i < 12; i++) await seed(`${prefix}o${i}`, `x${i}`);
    const r = await sp.deleteObjects({ runId, prefix });
    assert.equal(r.status, 'blocked');
    assert.match((r as { reason: string }).reason, /12 objects/);
    for (let i = 0; i < 12; i++) assert.ok(await exists(`${prefix}o${i}`));
    const ok = await sp.deleteObjects({ runId, keys: Array.from({ length: 10 }, (_, i) => `${prefix}o${i}`) });
    assert.equal(ok.status, 'applied', 'exactly 10 is allowed');
    assert.ok((await sp.revert(runId)).complete);
    for (let i = 0; i < 12; i++) { assert.ok(await exists(`${prefix}o${i}`)); await sp.infra.s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: `${prefix}o${i}` })); }
  });

  it('blocks public bucket ACLs, allows private, and protects the vault bucket', async () => {
    const runId = rid('s3acl');
    for (const acl of ['public-read', 'public-read-write', 'authenticated-read'] as const) {
      const r = await sp.setBucketAcl({ runId, acl });
      assert.equal(r.status, 'blocked', acl);
    }
    assert.equal((await sp.setBucketAcl({ runId, acl: 'private' })).status, 'applied');
    await assert.rejects(() => sp.putObject({ runId, bucket: sp.config.s3.vaultBucket, key: 'x', body: 'y' }), /recovery vault/);
    assert.ok((await sp.revert(runId)).complete);
  });
});

describe('GitHub connector (offline sandbox)', () => {
  const nums = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

  it('edits/closes an issue and revert restores prior fields', async () => {
    const runId = rid('gh');
    const repo = sp.config.github.defaultRepo;
    const before = await sp.github.readItem(repo, 3, 'issue');
    const r = await sp.updateIssues({ runId, numbers: [3], patch: { title: 'CHAOS retitled', state: 'closed', labels: ['wontfix'] } });
    assert.equal(r.status, 'applied');
    const mid = await sp.github.readItem(repo, 3, 'issue');
    assert.equal(mid.state, 'closed'); assert.equal(mid.title, 'CHAOS retitled');
    assert.ok((await sp.revert(runId)).complete);
    assert.deepEqual(await sp.github.readItem(repo, 3, 'issue'), before);
  });

  it('edits a PR and revert restores it', async () => {
    const runId = rid('ghpr');
    const repo = sp.config.github.defaultRepo;
    const before = await sp.github.readItem(repo, 13, 'pull');
    assert.equal((await sp.updatePulls({ runId, numbers: [13], patch: { title: 'hijacked', state: 'closed' } })).status, 'applied');
    assert.ok((await sp.revert(runId)).complete);
    assert.deepEqual(await sp.github.readItem(repo, 13, 'pull'), before);
  });

  it('blocks bulk mutations (>10 items) without touching anything', async () => {
    const runId = rid('ghbulk');
    const repo = sp.config.github.defaultRepo;
    const snapshot = await Promise.all(nums(11).map((n) => sp.github.readItem(repo, n, 'issue')));
    const r = await sp.updateIssues({ runId, numbers: nums(11), patch: { state: 'closed' } });
    assert.equal(r.status, 'blocked');
    assert.deepEqual(await Promise.all(nums(11).map((n) => sp.github.readItem(repo, n, 'issue'))), snapshot);
  });

  it('blocks deleting protected branches (main/master)', async () => {
    const runId = rid('ghprot');
    const r = await sp.deleteBranches({ runId, branches: ['main'] });
    assert.equal(r.status, 'blocked');
    assert.match((r as { reason: string }).reason, /Protected-branch gate/);
    assert.ok(await sp.github.readBranch(sp.config.github.defaultRepo, 'main'));
    const mixed = await sp.deleteBranches({ runId, branches: ['develop', 'main'] });
    assert.equal(mixed.status, 'blocked');
    assert.ok(await sp.github.readBranch(sp.config.github.defaultRepo, 'develop'), 'nothing deleted when any branch is protected');
  });

  it('deleting a branch is reverted by recreating the ref at the saved SHA', async () => {
    const runId = rid('ghbr');
    const repo = sp.config.github.defaultRepo;
    const name = `feature/test-${Date.now()}`;
    const sha = 'a'.repeat(40);
    await sp.github.createBranch(repo, name, sha);
    assert.equal((await sp.deleteBranches({ runId, branches: [name] })).status, 'applied');
    assert.equal(await sp.github.readBranch(repo, name), null);
    const rep = await sp.revert(runId);
    assert.ok(rep.complete);
    assert.equal((await sp.github.readBranch(repo, name))?.sha, sha);
    await sp.github.rawDeleteBranch(repo, name);
  });
});

describe('Slack connector (local sink)', () => {
  const sink = (runId: string) => sp.infra.pool.query('SELECT * FROM rollikey_slack_sink WHERE run_id = $1', [runId]).then((r) => r.rows);

  it('airlocks @channel posts and revert cancels them before delivery', async () => {
    const runId = rid('sl');
    const r = await sp.slackPost({ runId, channel: '#general', text: 'Heads up <!channel> deploying now' });
    assert.equal(r.status, 'held');
    assert.deepEqual((await sink(runId)).length, 0, 'nothing delivered while held');
    const rep = await sp.revert(runId);
    assert.ok(rep.complete);
    assert.equal(rep.slack.cancelled.length, 1);
    assert.equal(await sp.slack.releaseDue(), 0);
    assert.equal((await sink(runId)).length, 0);
    assert.equal((await sp.slack.listRun(runId))[0]!.status, 'cancelled');
  });

  it('airlocks external channels; plain internal posts go straight to the sink and are deleted on revert', async () => {
    const runId = rid('slx');
    assert.equal((await sp.slackPost({ runId, channel: 'ext-acme', text: 'hello partner' })).status, 'held');
    const direct = await sp.slackPost({ runId, channel: 'eng', text: 'normal message' });
    assert.equal(direct.status, 'applied');
    assert.equal((await sink(runId)).filter((m) => !m.deleted).length, 1);
    assert.ok((await sp.revert(runId)).complete);
    assert.equal((await sink(runId)).filter((m) => !m.deleted).length, 0);
  });

  it('release-early then revert compensates by deleting the posted message', async () => {
    const runId = rid('slrel');
    const r = await sp.slackPost({ runId, channel: 'general', text: '@here quick note' });
    assert.equal(r.status, 'held');
    assert.equal(await sp.slack.releaseNow((r as { id: string }).id), 'released');
    assert.equal((await sink(runId)).filter((m) => !m.deleted).length, 1);
    const rep = await sp.revert(runId);
    assert.ok(rep.complete);
    assert.equal(rep.slack.alreadySent.length, 1);
    assert.equal((await sink(runId)).filter((m) => !m.deleted).length, 0);
    assert.match(JSON.stringify(rep.steps[0]!.compensation), /deleted after release/);
  });

  it('blocks channel archiving and spam spikes (>10 messages)', async () => {
    const runId = rid('slspam');
    assert.equal((await sp.slackArchive({ runId, channel: 'general' })).status, 'blocked');
    for (let i = 0; i < 10; i++) assert.equal((await sp.slackPost({ runId, channel: 'eng', text: `m${i}` })).status, 'applied');
    const eleventh = await sp.slackPost({ runId, channel: 'eng', text: 'm10' });
    assert.equal(eleventh.status, 'blocked');
    assert.equal((await sink(runId)).length, 10);
    assert.ok((await sp.revert(runId)).complete);
    assert.equal((await sink(runId)).filter((m) => !m.deleted).length, 0);
  });
});

describe('cross-connector LIFO revert', () => {
  it('reverses Postgres, S3, GitHub, Slack and Email actions in strict reverse order', async () => {
    const runId = rid('mix');
    const key = `t/${runId}/f.txt`;
    const repo = sp.config.github.defaultRepo;
    await seed(key, 'v1');
    const pgBefore = (await sp.infra.pool.query('SELECT to_jsonb(c) AS r FROM customers c WHERE id = 7')).rows[0]?.r;
    assert.ok(pgBefore, 'run npm run db:seed first');
    const ghBefore = await sp.github.readItem(repo, 5, 'issue');

    assert.equal((await sp.updateRows({ runId, table: 'customers', where: { id: 7 }, set: { status: 'suspended' } })).status, 'applied');
    assert.equal((await sp.putObject({ runId, key, body: 'v2' })).status, 'applied');
    assert.equal((await sp.updateIssues({ runId, numbers: [5], patch: { state: 'closed' } })).status, 'applied');
    assert.equal((await sp.slackPost({ runId, channel: 'general', text: '<!here> done' })).status, 'held');
    await sp.sendEmail({ runId, to: 'x@example.test', subject: `[${runId}] hi`, text: 'hi' });

    const rep = await sp.revert(runId);
    assert.ok(rep.complete);
    assert.deepEqual(rep.steps.map((s) => s.actionType), ['slack.post', 'github.issue_update', 's3.put', 'pg.update']);
    assert.equal(rep.emails.cancelled.length, 1);
    assert.equal(rep.slack.cancelled.length, 1);
    assert.equal(await text(key), 'v1');
    assert.deepEqual(await sp.github.readItem(repo, 5, 'issue'), ghBefore);
    assert.deepEqual((await sp.infra.pool.query('SELECT to_jsonb(c) AS r FROM customers c WHERE id = 7')).rows[0]?.r, pgBefore);
    await sp.infra.s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  });
});
