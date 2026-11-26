import type pg from 'pg';
import { z } from 'zod';
import { evaluateGate, type GateLimits } from './gate.js';
import {
  assertRunId,
  insertSnapshot,
  lockRunXact,
  nextSeq,
  RollikeyError,
  type SnapshotRow,
} from './ledger.js';

// ---------------------------------------------------------------------------
// Request schemas (shared with the MCP layer)
// ---------------------------------------------------------------------------

export const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;

export const filterSchema = z.object({
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'like', 'ilike', 'is_null', 'not_null']),
  value: z.union([scalarSchema, z.array(scalarSchema)]).optional(),
});

/** Column -> literal (equality) or {op, value}. All conditions are AND-ed. */
export const whereSchema = z.record(z.string(), z.union([scalarSchema, filterSchema]));
export const setSchema = z.record(z.string(), scalarSchema);

export const updateRequestSchema = z.object({
  runId: z.string(),
  table: z.string(),
  where: whereSchema,
  set: setSchema,
});
export const deleteRequestSchema = z.object({
  runId: z.string(),
  table: z.string(),
  where: whereSchema,
});

export type UpdateRequest = z.infer<typeof updateRequestSchema>;
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;
export type Where = z.infer<typeof whereSchema>;

export type MutationResult =
  | {
      status: 'applied';
      runId: string;
      seq: number;
      snapshotId: string;
      rowsAffected: number;
      amountCents: number;
      rows: Record<string, unknown>[];
    }
  | {
      status: 'blocked';
      runId: string;
      seq: number;
      snapshotId: string;
      rowsMatched: number;
      amountCents: number;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Table catalog: identifiers are only ever taken from information_schema.
// ---------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export class TableCatalog {
  private cache = new Map<string, Set<string>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly protectedPrefixes: readonly string[],
  ) {}

  async columns(table: string): Promise<Set<string>> {
    if (!IDENT.test(table)) throw new RollikeyError('invalid_table', `Invalid table name "${table}"`);
    if (this.protectedPrefixes.some((p) => table.startsWith(p))) {
      throw new RollikeyError('protected_table', `Table "${table}" is protected and cannot be mutated by agents`);
    }
    const cached = this.cache.get(table);
    if (cached) return cached;
    const { rows } = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    if (rows.length === 0) throw new RollikeyError('unknown_table', `Unknown table "${table}"`);
    const cols = new Set(rows.map((r) => r.column_name));
    if (!cols.has('id')) {
      throw new RollikeyError('no_primary_key', `Table "${table}" needs an "id" column to be snapshot-restorable`);
    }
    this.cache.set(table, cols);
    return cols;
  }
}

function assertColumn(cols: Set<string>, col: string, table: string): void {
  if (!cols.has(col)) throw new RollikeyError('unknown_column', `Unknown column "${col}" on "${table}"`);
}

export function buildWhere(where: Where, cols: Set<string>, table: string, params: unknown[]): string {
  const parts: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (const [col, cond] of Object.entries(where)) {
    assertColumn(cols, col, table);
    const c = `t.${quoteIdent(col)}`;
    const f = cond !== null && typeof cond === 'object' ? cond : { op: 'eq' as const, value: cond };
    const needsScalar = () => {
      if (Array.isArray(f.value) || f.value === undefined) {
        throw new RollikeyError('invalid_filter', `Operator "${f.op}" on "${col}" needs a single value`);
      }
      return f.value;
    };
    const needsArray = () => {
      if (!Array.isArray(f.value)) throw new RollikeyError('invalid_filter', `Operator "${f.op}" on "${col}" needs an array`);
      return f.value;
    };
    switch (f.op) {
      case 'eq': {
        const v = needsScalar();
        parts.push(v === null ? `${c} IS NULL` : `${c} = ${p(v)}`);
        break;
      }
      case 'neq': {
        const v = needsScalar();
        parts.push(v === null ? `${c} IS NOT NULL` : `${c} IS DISTINCT FROM ${p(v)}`);
        break;
      }
      case 'lt': parts.push(`${c} < ${p(needsScalar())}`); break;
      case 'lte': parts.push(`${c} <= ${p(needsScalar())}`); break;
      case 'gt': parts.push(`${c} > ${p(needsScalar())}`); break;
      case 'gte': parts.push(`${c} >= ${p(needsScalar())}`); break;
      case 'like': parts.push(`${c} LIKE ${p(needsScalar())}`); break;
      case 'ilike': parts.push(`${c} ILIKE ${p(needsScalar())}`); break;
      case 'in': parts.push(`${c} = ANY(${p(needsArray())})`); break;
      case 'not_in': parts.push(`NOT (${c} = ANY(${p(needsArray())}))`); break;
      case 'is_null': parts.push(`${c} IS NULL`); break;
      case 'not_null': parts.push(`${c} IS NOT NULL`); break;
    }
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

// ---------------------------------------------------------------------------
// Pre-flight snapshot + gate + mutation, all in one transaction.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

export interface PostgresProxyDeps {
  pool: pg.Pool;
  catalog: TableCatalog;
  limits: GateLimits;
  monetaryColumns: readonly string[];
}

export class PostgresProxy {
  constructor(private readonly deps: PostgresProxyDeps) {}

  update(req: UpdateRequest): Promise<MutationResult> {
    return this.mutate('pg.update', req, req.set);
  }

  delete(req: DeleteRequest): Promise<MutationResult> {
    return this.mutate('pg.delete', req, undefined);
  }

  private async mutate(
    kind: 'pg.update' | 'pg.delete',
    req: { runId: string; table: string; where: Where },
    set: Record<string, Scalar> | undefined,
  ): Promise<MutationResult> {
    assertRunId(req.runId);
    const { pool, catalog, limits } = this.deps;
    const cols = await catalog.columns(req.table);
    const table = quoteIdent(req.table);

    if (set) {
      const keys = Object.keys(set);
      if (keys.length === 0) throw new RollikeyError('empty_set', 'update needs at least one column in "set"');
      for (const k of keys) {
        assertColumn(cols, k, req.table);
        if (k === 'id') throw new RollikeyError('immutable_column', 'Updating "id" is not allowed');
      }
    }

    const params: unknown[] = [];
    const whereSql = buildWhere(req.where, cols, req.table, params);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockRunXact(client, req.runId);
      const seq = await nextSeq(client, req.runId);

      // Lock at most maxRows+1 matching rows: enough to decide the gate without
      // loading a whole table, and the locked set is exactly what we mutate.
      const { rows: locked } = await client.query<{ row: Row }>(
        `SELECT to_jsonb(t) AS row FROM ${table} AS t
          WHERE ${whereSql} ORDER BY t.id LIMIT ${limits.maxRows + 1} FOR UPDATE`,
        params,
      );
      const before = locked.map((r) => r.row);

      let rowsMatched = before.length;
      let amountCents = this.moneyMoved(before, set);
      if (rowsMatched > limits.maxRows) {
        // Over the row limit anyway: report the true size of what was attempted.
        const aggParams = [...params];
        const moneyExprs = this.deps.monetaryColumns
          .filter((c) => cols.has(c) && (!set || c in set))
          .map((c) => {
            if (!set) return `COALESCE(sum(abs(t.${quoteIdent(c)})), 0)`;
            aggParams.push(set[c] ?? 0);
            return `COALESCE(sum(abs($${aggParams.length}::numeric - t.${quoteIdent(c)})), 0)`;
          });
        const { rows } = await client.query<{ n: string; money: string }>(
          `SELECT count(*) AS n, ${moneyExprs.length ? moneyExprs.join(' + ') : '0'} AS money
             FROM ${table} AS t WHERE ${whereSql}`,
          aggParams,
        );
        rowsMatched = Number(rows[0]!.n);
        amountCents = Number(rows[0]!.money);
      }
      const decision = evaluateGate({ rowsAffected: rowsMatched, amountCents }, limits);

      if (!decision.allowed) {
        const snap = await insertSnapshot(client, {
          runId: req.runId,
          seq,
          actionType: kind,
          target: req.table,
          status: 'blocked',
          request: req,
          beforeState: [],
          rowsAffected: rowsMatched,
          amountCents,
          blockReason: decision.reason,
        });
        await client.query('COMMIT');
        return { status: 'blocked', runId: req.runId, seq, snapshotId: snap.id, rowsMatched, amountCents, reason: decision.reason };
      }

      const ids = before.map((r) => r.id);
      let after: Row[] = [];
      if (ids.length > 0) {
        if (kind === 'pg.update') {
          const setParams: unknown[] = [ids];
          const assignments = Object.entries(set!).map(([k, v]) => {
            setParams.push(v);
            return `${quoteIdent(k)} = $${setParams.length}`;
          });
          const res = await client.query<{ row: Row }>(
            `UPDATE ${table} AS t SET ${assignments.join(', ')} WHERE t.id = ANY($1) RETURNING to_jsonb(t) AS row`,
            setParams,
          );
          after = res.rows.map((r) => r.row);
        } else {
          await client.query(`DELETE FROM ${table} AS t WHERE t.id = ANY($1)`, [ids]);
        }
      }

      const snap = await insertSnapshot(client, {
        runId: req.runId,
        seq,
        actionType: kind,
        target: req.table,
        status: 'applied',
        request: req,
        beforeState: before,
        afterState: kind === 'pg.update' ? after : [],
        rowsAffected: before.length,
        amountCents,
      });
      await client.query('COMMIT');
      return {
        status: 'applied',
        runId: req.runId,
        seq,
        snapshotId: snap.id,
        rowsAffected: before.length,
        amountCents,
        rows: kind === 'pg.update' ? after : before,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Total absolute change of monetary columns (updates) or monetary value removed (deletes). */
  private moneyMoved(before: Row[], set: Record<string, Scalar> | undefined): number {
    let total = 0;
    for (const col of this.deps.monetaryColumns) {
      for (const row of before) {
        const old = Number(row[col] ?? 0);
        if (set) {
          if (!(col in set)) continue;
          total += Math.abs(Number(set[col] ?? 0) - old);
        } else {
          total += Math.abs(old);
        }
      }
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Inverse operations used by revert(). Run inside the caller's transaction.
  // -------------------------------------------------------------------------

  async restore(client: pg.PoolClient, snap: SnapshotRow): Promise<Record<string, unknown>> {
    const tableName = snap.target;
    const cols = await this.deps.catalog.columns(tableName);
    const table = quoteIdent(tableName);
    const before = (snap.before_state ?? []) as Row[];
    const afterById = new Map(((snap.after_state ?? []) as Row[]).map((r) => [String(r.id), r]));
    const drifted: unknown[] = [];
    const restoredIds: unknown[] = [];

    for (const row of before) {
      const rowCols = Object.keys(row).filter((c) => cols.has(c));
      const nonId = rowCols.filter((c) => c !== 'id');
      const { rows: current } = await client.query<{ row: Row; matches_after: boolean | null }>(
        `SELECT to_jsonb(t) AS row, to_jsonb(t) = $2::jsonb AS matches_after
           FROM ${table} AS t WHERE t.id = $1 FOR UPDATE`,
        [row.id, JSON.stringify(afterById.get(String(row.id)) ?? null)],
      );

      if (snap.action_type === 'pg.update' && (current.length === 0 || current[0]!.matches_after === false)) {
        // Someone changed this row after the agent did; the snapshot still wins.
        drifted.push(row.id);
      }

      if (current.length === 0) {
        // Row is gone (deleted after an update, or the original delete): re-insert it verbatim.
        await client.query(
          `INSERT INTO ${table} (${rowCols.map(quoteIdent).join(', ')})
           SELECT ${rowCols.map((c) => `r.${quoteIdent(c)}`).join(', ')}
             FROM jsonb_populate_record(NULL::${table}, $1::jsonb) AS r`,
          [JSON.stringify(row)],
        );
      } else if (nonId.length > 0) {
        await client.query(
          `UPDATE ${table} AS t SET ${nonId.map((c) => `${quoteIdent(c)} = r.${quoteIdent(c)}`).join(', ')}
             FROM jsonb_populate_record(NULL::${table}, $1::jsonb) AS r
            WHERE t.id = r.id`,
          [JSON.stringify(row)],
        );
      }
      restoredIds.push(row.id);
    }

    return {
      type: snap.action_type === 'pg.update' ? 'rows_restored' : 'rows_reinserted',
      table: tableName,
      restoredIds,
      drifted,
    };
  }
}
