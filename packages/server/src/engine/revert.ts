import type pg from 'pg';
import type { Airlock } from './airlock.js';
import type { S3Proxy } from './s3.js';
import type { GitHubProxy } from './github.js';
import type { SlackProxy } from './slack.js';
import { assertRunId, runLockKey, type SnapshotRow } from './ledger.js';
import type { PostgresProxy } from './postgres.js';
import type { StripeProxy } from './stripe.js';

export interface RevertStep {
  seq: number;
  snapshotId: string;
  actionType: SnapshotRow['action_type'];
  target: string;
  status: 'reverted' | 'revert_failed';
  compensation?: Record<string, unknown>;
  error?: string;
}

export interface RevertReport {
  runId: string;
  /** true when every applied action in the run has been compensated. */
  complete: boolean;
  emails: { cancelled: string[]; alreadySent: string[] };
  slack: { cancelled: string[]; alreadySent: string[] };
  steps: RevertStep[];
  /** seqs still un-reverted because LIFO halted at the first failure. */
  remaining: number[];
}

export interface RevertDeps {
  pool: pg.Pool;
  airlock: Airlock;
  postgres: PostgresProxy;
  stripe: StripeProxy;
  s3: S3Proxy;
  github: GitHubProxy;
  slack: SlackProxy;
}

/**
 * Deterministic LIFO revert:
 *   1. cancel every still-held airlock email of the run (stop outbound first);
 *   2. walk the ledger in strict reverse `seq` order, applying each action's
 *      compensating inverse.
 * Halts at the first failure so later inverses never run on top of an
 * un-reverted earlier state. Idempotent and resumable: call it again after
 * fixing the cause and it continues from where it stopped.
 */
export async function revertRun(deps: RevertDeps, runId: string): Promise<RevertReport> {
  assertRunId(runId);
  const client = await deps.pool.connect();
  try {
    // Session-level lock: blocks new mutations in this run for the whole revert.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [runLockKey(runId)]);

    // Stop everything outbound first: held emails and held Slack posts.
    const emails = await deps.airlock.cancelRun(runId);
    const slack = await deps.slack.cancelRun(runId);

    const { rows: snaps } = await client.query<SnapshotRow>(
      `SELECT * FROM rollikey_snapshots
        WHERE run_id = $1 AND status IN ('applied', 'pending', 'revert_failed')
        ORDER BY seq DESC`,
      [runId],
    );

    const steps: RevertStep[] = [];
    let haltedAt = -1;
    for (const [i, snap] of snaps.entries()) {
      const base = { seq: snap.seq, snapshotId: snap.id, actionType: snap.action_type, target: snap.target };
      try {
        let compensation: Record<string, unknown>;
        if (snap.action_type.startsWith('stripe.')) {
          compensation = await deps.stripe.compensate(snap);
          await markReverted(client, snap.id, compensation);
        } else if (snap.action_type.startsWith('s3.')) {
          compensation = await deps.s3.restore(snap);
          await markReverted(client, snap.id, compensation);
        } else if (snap.action_type.startsWith('github.')) {
          compensation = await deps.github.restore(snap);
          await markReverted(client, snap.id, compensation);
        } else if (snap.action_type === 'slack.post') {
          compensation = await deps.slack.compensate(snap);
          await markReverted(client, snap.id, compensation);
        } else {
          await client.query('BEGIN');
          compensation = await deps.postgres.restore(client, snap);
          await markReverted(client, snap.id, compensation);
          await client.query('COMMIT');
        }
        steps.push({ ...base, status: 'reverted', compensation });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const error = (err as Error).message;
        await client.query(`UPDATE rollikey_snapshots SET status = 'revert_failed', error = $2 WHERE id = $1`, [snap.id, error]);
        steps.push({ ...base, status: 'revert_failed', error });
        haltedAt = i;
        break;
      }
    }

    const remaining = haltedAt < 0 ? [] : snaps.slice(haltedAt).map((s) => s.seq);
    return { runId, complete: haltedAt < 0, emails, slack, steps, remaining };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [runLockKey(runId)]).catch(() => {});
    client.release();
  }
}

async function markReverted(client: pg.PoolClient, id: string, compensation: unknown): Promise<void> {
  await client.query(
    `UPDATE rollikey_snapshots SET status = 'reverted', reverted_at = now(), compensation = $2, error = NULL WHERE id = $1`,
    [id, JSON.stringify(compensation)],
  );
}
