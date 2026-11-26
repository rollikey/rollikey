import type pg from 'pg';

export type ActionType =
  | 'pg.update' | 'pg.delete' | 'stripe.refund' | 'stripe.authorize_hold'
  | 's3.put' | 's3.delete' | 's3.acl'
  | 'github.issue_update' | 'github.pr_update' | 'github.branch_delete'
  | 'slack.post' | 'slack.archive';
export type SnapshotStatus = 'pending' | 'applied' | 'blocked' | 'failed' | 'reverted' | 'revert_failed';

export interface SnapshotRow {
  id: string;
  run_id: string;
  seq: number;
  action_type: ActionType;
  target: string;
  status: SnapshotStatus;
  request: unknown;
  before_state: unknown;
  after_state: unknown | null;
  rows_affected: number | null;
  amount_cents: string | null;
  block_reason: string | null;
  error: string | null;
  compensation: unknown | null;
  created_at: Date;
  reverted_at: Date | null;
}

export interface NewSnapshot {
  runId: string;
  seq: number;
  actionType: ActionType;
  target: string;
  status: SnapshotStatus;
  request: unknown;
  beforeState: unknown;
  afterState?: unknown;
  rowsAffected?: number;
  amountCents?: number;
  blockReason?: string;
}

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function runLockKey(runId: string): string {
  return `rollikey:run:${runId}`;
}

/**
 * Serialises every mutation (and revert) within one run, so per-run `seq` is
 * gap-free and LIFO order is exactly the order the calls were applied in.
 * Must be called inside a transaction.
 */
export async function lockRunXact(client: pg.PoolClient, runId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [runLockKey(runId)]);
}

export async function nextSeq(client: pg.PoolClient, runId: string): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM rollikey_snapshots WHERE run_id = $1',
    [runId],
  );
  return rows[0]!.seq;
}

export async function insertSnapshot(client: pg.PoolClient | pg.Pool, s: NewSnapshot): Promise<SnapshotRow> {
  const { rows } = await client.query<SnapshotRow>(
    `INSERT INTO rollikey_snapshots
       (run_id, seq, action_type, target, status, request, before_state, after_state,
        rows_affected, amount_cents, block_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      s.runId,
      s.seq,
      s.actionType,
      s.target,
      s.status,
      JSON.stringify(s.request),
      JSON.stringify(s.beforeState),
      s.afterState === undefined ? null : JSON.stringify(s.afterState),
      s.rowsAffected ?? null,
      s.amountCents ?? null,
      s.blockReason ?? null,
    ],
  );
  return rows[0]!;
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RollikeyError('invalid_run_id', `runId must match ${RUN_ID_PATTERN}`);
  }
}

export class RollikeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RollikeyError';
  }
}

/**
 * Connector write-ahead pattern: commit a ledger row (seq reserved under the run lock)
 * BEFORE the external side effect, so a crash mid-call still leaves a revertable record.
 */
export async function recordAction(pool: pg.Pool, s: Omit<NewSnapshot, 'seq'>): Promise<SnapshotRow> {
  assertRunId(s.runId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockRunXact(client, s.runId);
    const seq = await nextSeq(client, s.runId);
    const row = await insertSnapshot(client, { ...s, seq });
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function completeAction(pool: pg.Pool, id: string, afterState: unknown): Promise<void> {
  await pool.query(`UPDATE rollikey_snapshots SET status = 'applied', after_state = $2, error = NULL WHERE id = $1`, [id, JSON.stringify(afterState)]);
}

/** Leave the row 'pending' (outcome unknown / partial) so revert() still compensates it. */
export async function noteActionError(pool: pg.Pool, id: string, message: string, afterState?: unknown): Promise<void> {
  await pool.query(`UPDATE rollikey_snapshots SET error = $2, after_state = COALESCE($3::jsonb, after_state) WHERE id = $1`, [
    id, message, afterState === undefined ? null : JSON.stringify(afterState),
  ]);
}

export function evaluateBulk(count: number, limit: number, noun: string): string | null {
  return count > limit ? `Blast-radius gate: affects ${count} ${noun} (limit ${limit} per call)` : null;
}
