import type pg from 'pg';
import { config } from '../config.js';
import { RollikeyError, assertRunId, type SnapshotRow } from '../engine/ledger.js';
import { TableCatalog, quoteIdent } from '../engine/postgres.js';

type Row = Record<string, unknown>;

export interface ShadowStep {
  seq: number;
  actionType: SnapshotRow['action_type'];
  target: string;
  /** What the shadow sandbox did with this recorded step. */
  outcome: 'simulated' | 'skipped_blocked' | 'shadow_error' | 'skipped_no_state';
  note?: string;
  rows?: { id: unknown; before: Row | null; after: Row | null; changed: Record<string, [unknown, unknown]> }[];
  /** For updates: whether the shadow result equals the after_state the live run recorded. */
  matchesLiveAfterState?: boolean;
  /** Human-readable simulated effects for S3 / GitHub / Slack steps. */
  lines?: string[];
  stripe?: { chargeId: string; refundedBeforeCents: number; refundedAfterCents: number; amountCents: number };
  error?: string;
}

export interface ShadowReport {
  runId: string;
  generatedAt: string;
  isolation: {
    mode: 'temp-tables-in-rolled-back-transaction';
    liveRowsTouched: 0;
    stripeApiCalls: 0;
    s3Writes: 0;
    githubApiCalls: 0;
    slackPosts: 0;
    emailsSent: 0;
    liveFingerprintBefore: string;
    liveFingerprintAfter: string;
    liveUnchanged: boolean;
  };
  forward: ShadowStep[];
  revert: ShadowStep[];
  /** True when LIFO revert inside the shadow restored the exact cloned Before State. */
  identicalAfterRevert: boolean;
}

const MAX_ROWS_SHOWN = 20;

type Anyobj = Record<string, any>;
/** Simulated (never executed) effect of a non-Postgres, non-Stripe step, derived purely from the saved snapshot. */
function simulateConnector(s: SnapshotRow, phase: 'forward' | 'revert'): { lines: string[]; rows?: ShadowStep['rows'] } {
  const before = (s.before_state ?? {}) as Anyobj;
  const req = (s.request ?? {}) as Anyobj;
  const fwd = phase === 'forward';
  if (s.action_type === 's3.put' || s.action_type === 's3.delete') {
    const lines = ((before.objects ?? []) as Anyobj[]).map((o) => {
      const size = o.head?.contentLength;
      if (s.action_type === 's3.delete') return fwd ? `delete s3://${before.bucket}/${o.key} (${size ?? '?'} B vaulted)` : `restore s3://${before.bucket}/${o.key} from vault (${size ?? '?'} B, etag ${String(o.head?.etag ?? '').slice(0, 8)})`;
      return o.existed
        ? (fwd ? `overwrite s3://${before.bucket}/${o.key} (prior ${size} B + metadata vaulted)` : `restore prior ${size} B + metadata of ${o.key} from vault`)
        : (fwd ? `create s3://${before.bucket}/${o.key}` : `remove newly created ${o.key}`);
    });
    return { lines: lines.length ? lines : ['no objects'] };
  }
  if (s.action_type === 's3.acl') return { lines: [fwd ? `set bucket ACL to ${req.acl}` : 'nothing to undo'] };
  if (s.action_type === 'github.branch_delete') {
    return { lines: ((before.branches ?? []) as Anyobj[]).map((b) => fwd ? `delete branch ${b.name} (head ${String(b.sha).slice(0, 7)} saved)` : `recreate branch ${b.name} at ${String(b.sha).slice(0, 7)}`) };
  }
  if (s.action_type === 'github.issue_update' || s.action_type === 'github.pr_update') {
    const patch = (req.patch ?? {}) as Anyobj;
    const items = (before.items ?? []) as Anyobj[];
    const rows = items.slice(0, MAX_ROWS_SHOWN).map((it) => {
      const after = fwd ? { ...it, ...patch } : it;
      const from = fwd ? it : { ...it, ...patch };
      return { id: it.number, before: from, after, changed: diffRow(from, after) };
    });
    return { lines: [`${fwd ? 'apply patch to' : 'restore'} ${items.length} ${before.kind === 'pull' ? 'pull request(s)' : 'issue(s)'} in ${before.repo}`], rows };
  }
  if (s.action_type === 'slack.post') {
    const after = (s.after_state ?? {}) as Anyobj;
    return { lines: [fwd
      ? (after.mode === 'airlock' ? `post to #${req.channel} would be HELD in the 60s airlock (${(after.reasons ?? []).join('; ')})` : `post to #${req.channel} would be delivered immediately`)
      : (after.mode === 'airlock' ? 'cancel the held message before delivery' : 'delete the posted message')] };
  }
  return { lines: ['no simulation available'] };
}

const stable = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function diffRow(before: Row | null, after: Row | null): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (stable(before?.[k]) !== stable(after?.[k])) out[k] = [before?.[k] ?? null, after?.[k] ?? null];
  }
  return out;
}

async function fingerprint(pool: pg.Pool, tables: Map<string, unknown[]>): Promise<string> {
  const parts: string[] = [];
  for (const [table, ids] of tables) {
    const { rows } = await pool.query<{ fp: string }>(
      `SELECT COALESCE(md5(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id)), 'empty') AS fp
         FROM ${quoteIdent(table)} AS t WHERE t.id = ANY($1)`,
      [ids],
    );
    parts.push(`${table}:${rows[0]!.fp}`);
  }
  return parts.join('|') || 'no-postgres-steps';
}

/**
 * Shadow-State Replay. Clones the run's saved Before-State snapshots into TEMP
 * tables inside a transaction that is always rolled back, replays the recorded
 * actions forward and then runs a LIFO revert, all against the clone. Live
 * customer rows are never written (proved by a before/after fingerprint) and
 * Stripe is never called (refunds are simulated from the saved Stripe object).
 */
export async function shadowReplay(pool: pg.Pool, runId: string): Promise<ShadowReport> {
  assertRunId(runId);
  const { rows: snaps } = await pool.query<SnapshotRow>(
    'SELECT * FROM rollikey_snapshots WHERE run_id = $1 ORDER BY seq',
    [runId],
  );
  if (snaps.length === 0) throw new RollikeyError('run_not_found', `No ledger entries for run "${runId}"`);

  const catalog = new TableCatalog(pool, config.protectedTablePrefixes);
  const pgSnaps = snaps.filter((s) => s.action_type.startsWith('pg.') && s.status !== 'blocked' && Array.isArray(s.before_state));
  const idsByTable = new Map<string, unknown[]>();
  for (const s of pgSnaps) {
    const ids = idsByTable.get(s.target) ?? [];
    for (const r of s.before_state as Row[]) ids.push(r.id);
    idsByTable.set(s.target, ids);
  }
  const fpBefore = await fingerprint(pool, idsByTable);

  const forward: ShadowStep[] = [];
  const revert: ShadowStep[] = [];
  let identical = true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const temp = new Map<string, string>();
    const initial = new Map<string, Map<string, Row>>(); // table -> id -> original before row
    const colsOf = new Map<string, Set<string>>();
    let n = 0;
    for (const table of idsByTable.keys()) {
      const cols = await catalog.columns(table);
      colsOf.set(table, cols);
      const name = `shadow_${n++}`;
      temp.set(table, name);
      await client.query(`CREATE TEMP TABLE ${name} (LIKE ${quoteIdent(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
      initial.set(table, new Map());
    }
    // Seed: the earliest recorded before-state of each row is the pristine state.
    for (const s of pgSnaps) {
      const t = temp.get(s.target)!;
      for (const row of s.before_state as Row[]) {
        const seen = initial.get(s.target)!;
        if (seen.has(String(row.id))) continue;
        seen.set(String(row.id), row);
        await client.query(
          `INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1::jsonb)`,
          [JSON.stringify(row)],
        );
      }
    }

    const readRows = async (table: string, ids: unknown[]): Promise<Map<string, Row>> => {
      const { rows } = await client.query<{ row: Row }>(
        `SELECT to_jsonb(t) AS row FROM ${temp.get(table)} AS t WHERE t.id = ANY($1)`,
        [ids],
      );
      return new Map(rows.map((r) => [String(r.row.id), r.row]));
    };

    // ---- forward replay (seq order) ----
    for (const s of snaps) {
      const base = { seq: s.seq, actionType: s.action_type, target: s.target };
      if (s.status === 'blocked') {
        forward.push({ ...base, outcome: 'skipped_blocked', note: `Gate blocked this in the live run: ${s.block_reason ?? 'blast radius exceeded'}. Nothing executed, nothing to replay.` });
        continue;
      }
      if (/^(s3|github|slack)\./.test(s.action_type)) {
        const sim = simulateConnector(s, 'forward');
        forward.push({ ...base, outcome: 'simulated', note: 'Simulated from the saved snapshot. No call was made to S3, GitHub or Slack.', lines: sim.lines, ...(sim.rows ? { rows: sim.rows } : {}) });
        continue;
      }
      if (s.action_type === 'stripe.refund') {
        const charge = (s.before_state as { charge?: { id: string; amount_refunded: number } } | null)?.charge;
        if (!charge) { forward.push({ ...base, outcome: 'skipped_no_state' }); continue; }
        const amount = Number(s.amount_cents ?? 0);
        forward.push({
          ...base,
          outcome: 'simulated',
          note: 'Simulated against the saved Stripe object. No Stripe API call was made.',
          stripe: { chargeId: charge.id, refundedBeforeCents: charge.amount_refunded, refundedAfterCents: charge.amount_refunded + amount, amountCents: amount },
        });
        continue;
      }
      if (!Array.isArray(s.before_state)) { forward.push({ ...base, outcome: 'skipped_no_state' }); continue; }
      const before = s.before_state as Row[];
      const ids = before.map((r) => r.id);
      const cols = colsOf.get(s.target)!;
      const req = s.request as { set?: Record<string, unknown> };
      await client.query('SAVEPOINT step');
      try {
        const current = await readRows(s.target, ids);
        let afterRows: Row[] = [];
        if (s.action_type === 'pg.update') {
          const params: unknown[] = [ids];
          const assigns = Object.entries(req.set ?? {}).map(([k, v]) => {
            if (!cols.has(k) || k === 'id') throw new RollikeyError('unknown_column', `Column "${k}" is not replayable`);
            params.push(v);
            return `${quoteIdent(k)} = $${params.length}`;
          });
          if (assigns.length === 0) throw new RollikeyError('empty_set', 'Recorded update has no columns');
          const res = await client.query<{ row: Row }>(
            `UPDATE ${temp.get(s.target)} AS t SET ${assigns.join(', ')} WHERE t.id = ANY($1) RETURNING to_jsonb(t) AS row`,
            params,
          );
          afterRows = res.rows.map((r) => r.row);
        } else {
          await client.query(`DELETE FROM ${temp.get(s.target)} AS t WHERE t.id = ANY($1)`, [ids]);
        }
        const afterById = new Map(afterRows.map((r) => [String(r.id), r]));
        const rows = ids.slice(0, MAX_ROWS_SHOWN).map((id) => {
          const b = current.get(String(id)) ?? null;
          const a = afterById.get(String(id)) ?? null;
          return { id, before: b, after: a, changed: diffRow(b, a) };
        });
        const recorded = new Map(((s.after_state ?? []) as Row[]).map((r) => [String(r.id), r]));
        forward.push({
          ...base,
          outcome: 'simulated',
          rows,
          ...(s.action_type === 'pg.update'
            ? { matchesLiveAfterState: afterRows.length === recorded.size && afterRows.every((r) => stable(r) === stable(recorded.get(String(r.id)))) }
            : {}),
        });
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT step');
        forward.push({ ...base, outcome: 'shadow_error', error: (err as Error).message, note: 'This step would fail against the cloned state (e.g. a constraint violation).' });
      }
      await client.query('RELEASE SAVEPOINT step');
    }

    // ---- LIFO revert, still inside the shadow ----
    for (const s of [...snaps].reverse()) {
      const base = { seq: s.seq, actionType: s.action_type, target: s.target };
      if (s.status === 'blocked') continue;
      if (/^(s3|github|slack)\./.test(s.action_type)) {
        const sim = simulateConnector(s, 'revert');
        revert.push({ ...base, outcome: 'simulated', lines: sim.lines });
        continue;
      }
      if (s.action_type === 'stripe.refund') {
        const amount = Number(s.amount_cents ?? 0);
        const charge = (s.before_state as { charge?: { id: string; amount_refunded: number } } | null)?.charge;
        if (!charge) continue;
        revert.push({
          ...base,
          outcome: 'simulated',
          note: 'Would cancel the refund, or re-charge the customer off-session. Simulated only.',
          stripe: { chargeId: charge.id, refundedBeforeCents: charge.amount_refunded + amount, refundedAfterCents: charge.amount_refunded, amountCents: amount },
        });
        continue;
      }
      if (!Array.isArray(s.before_state)) continue;
      const t = temp.get(s.target)!;
      const cols = [...colsOf.get(s.target)!];
      for (const row of s.before_state as Row[]) {
        const rowCols = Object.keys(row).filter((c) => cols.includes(c));
        const nonId = rowCols.filter((c) => c !== 'id');
        const exists = (await client.query(`SELECT 1 FROM ${t} WHERE id = $1`, [row.id])).rowCount;
        if (!exists) {
          await client.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1::jsonb)`, [JSON.stringify(row)]);
        } else if (nonId.length) {
          await client.query(
            `UPDATE ${t} AS x SET ${nonId.map((c) => `${quoteIdent(c)} = r.${quoteIdent(c)}`).join(', ')}
               FROM jsonb_populate_record(NULL::${t}, $1::jsonb) AS r WHERE x.id = r.id`,
            [JSON.stringify(row)],
          );
        }
      }
      revert.push({ ...base, outcome: 'simulated', note: `Restored ${(s.before_state as Row[]).length} row(s) from the Before-State snapshot.` });
    }

    for (const [table, originals] of initial) {
      const finalRows = await readRows(table, [...originals.keys()].map((k) => originals.get(k)!.id));
      for (const [id, orig] of originals) {
        if (stable(finalRows.get(id)) !== stable(orig)) identical = false;
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  const fpAfter = await fingerprint(pool, idsByTable);
  return {
    runId,
    generatedAt: new Date().toISOString(),
    isolation: {
      mode: 'temp-tables-in-rolled-back-transaction',
      liveRowsTouched: 0,
      stripeApiCalls: 0,
      s3Writes: 0,
      githubApiCalls: 0,
      slackPosts: 0,
      emailsSent: 0,
      liveFingerprintBefore: fpBefore,
      liveFingerprintAfter: fpAfter,
      liveUnchanged: fpBefore === fpAfter,
    },
    forward,
    revert,
    identicalAfterRevert: identical,
  };
}
