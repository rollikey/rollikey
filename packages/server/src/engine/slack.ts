import type pg from 'pg';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { RollikeyError, assertRunId, completeAction, evaluateBulk, noteActionError, recordAction, type SnapshotRow } from './ledger.js';

export const slackPostSchema = z.object({
  runId: z.string(),
  channel: z.string().regex(/^#?[A-Za-z0-9._-]{1,80}$/, 'invalid channel'),
  text: z.string().min(1).max(4000),
  threadTs: z.string().optional(),
});
export const slackArchiveSchema = z.object({ runId: z.string(), channel: z.string().regex(/^#?[A-Za-z0-9._-]{1,80}$/) });
export type SlackPostRequest = z.input<typeof slackPostSchema>;
export type SlackArchiveRequest = z.input<typeof slackArchiveSchema>;

export type SlackResult =
  | { status: 'held'; runId: string; seq: number; snapshotId: string; id: string; channel: string; releaseAt: Date; reasons: string[]; amountCents: 0 }
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; channel: string; ts: string; backend: SlackBackendName; amountCents: 0 }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; reason: string; amountCents: 0 };

export type SlackBackendName = 'sink' | 'bot' | 'webhook';

export interface SlackQueueRow {
  id: string; run_id: string; status: 'held' | 'releasing' | 'released' | 'cancelled' | 'failed'; channel: string; text: string;
  thread_ts: string | null; reason: string; release_at: Date; attempts: number; message_ts: string | null; error: string | null;
  created_at: Date; released_at: Date | null; cancelled_at: Date | null;
}

export interface SlackDeps {
  pool: pg.Pool;
  redis: Redis;
  botToken: string;
  webhookUrl: string;
  externalPrefixes: readonly string[];
  holdSeconds: number;
  maxBulkItems: number;
  log?: (m: string) => void;
}

const BROADCAST = /<!(channel|here|everyone)(\|[^>]*)?>|(^|\s)@(channel|here|everyone)\b/i;
export const slackHoldKey = (id: string) => `rollikey:slack:hold:${id}`;
const MAX_ATTEMPTS = 5;

/** Slack connector: high-blast posts go through the 60s airlock; delivery to a local sink unless live creds exist. */
export class SlackProxy {
  constructor(private readonly deps: SlackDeps) {}

  get backend(): SlackBackendName { return this.deps.botToken ? 'bot' : this.deps.webhookUrl ? 'webhook' : 'sink'; }

  private norm(channel: string) { return channel.replace(/^#/, ''); }

  /** Why (if at all) a post needs the staging airlock. */
  classify(channel: string, text: string): string[] {
    const reasons: string[] = [];
    if (BROADCAST.test(text)) reasons.push('broadcast mention (@channel / @here / @everyone)');
    if (this.deps.externalPrefixes.some((p) => this.norm(channel).startsWith(p))) reasons.push(`external/shared channel "${this.norm(channel)}"`);
    if (this.backend === 'webhook') reasons.push('incoming webhook (message cannot be recalled once posted)');
    return reasons;
  }

  async post(input: SlackPostRequest): Promise<SlackResult> {
    const req = slackPostSchema.parse(input);
    assertRunId(req.runId);
    const channel = this.norm(req.channel);
    const { pool, redis } = this.deps;
    const { rows: cnt } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rollikey_snapshots WHERE run_id = $1 AND action_type = 'slack.post' AND status <> 'blocked'`, [req.runId]);
    const reason = evaluateBulk(cnt[0]!.n + 1, this.deps.maxBulkItems, 'Slack messages in this run (spam spike)');
    if (reason) {
      const snap = await recordAction(pool, { runId: req.runId, actionType: 'slack.post', target: `#${channel}`, status: 'blocked', request: req, beforeState: { channel }, rowsAffected: 1, amountCents: 0, blockReason: reason });
      return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
    }
    const reasons = this.classify(channel, req.text);
    const snap = await recordAction(pool, { runId: req.runId, actionType: 'slack.post', target: `#${channel}`, status: 'pending', request: req, beforeState: { channel, existed: false }, rowsAffected: 1, amountCents: 0 });
    const base = { runId: req.runId, seq: snap.seq, snapshotId: snap.id, channel, amountCents: 0 as const };
    try {
      if (reasons.length) {
        const { rows } = await pool.query<SlackQueueRow>(
          `INSERT INTO rollikey_slack_queue (run_id, status, channel, text, thread_ts, reason, release_at)
           VALUES ($1, 'held', $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING *`,
          [req.runId, channel, req.text, req.threadTs ?? null, reasons.join('; '), this.deps.holdSeconds]);
        const row = rows[0]!;
        await redis.set(slackHoldKey(row.id), req.runId, 'EX', this.deps.holdSeconds);
        await completeAction(pool, snap.id, { mode: 'airlock', queueId: row.id, channel, releaseAt: row.release_at, reasons });
        return { status: 'held', ...base, id: row.id, releaseAt: row.release_at, reasons };
      }
      const ts = await this.deliver({ channel, text: req.text, threadTs: req.threadTs, runId: req.runId });
      await completeAction(pool, snap.id, { mode: 'direct', channel, ts, backend: this.backend });
      return { status: 'applied', ...base, ts, backend: this.backend };
    } catch (err) {
      await noteActionError(pool, snap.id, (err as Error).message);
      throw err;
    }
  }

  /** Channel archiving is never allowed through the proxy: always blocked, always recorded. */
  async archiveChannel(input: SlackArchiveRequest): Promise<SlackResult> {
    const req = slackArchiveSchema.parse(input);
    assertRunId(req.runId);
    const channel = this.norm(req.channel);
    const reason = `Destructive-action gate: archiving channel "#${channel}" is not permitted for agents`;
    const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType: 'slack.archive', target: `#${channel}`, status: 'blocked', request: req, beforeState: { channel }, rowsAffected: 1, amountCents: 0, blockReason: reason });
    return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
  }

  // ---- delivery backends -----------------------------------------------------------------------
  private async deliver(m: { channel: string; text: string; threadTs?: string | undefined; runId: string }): Promise<string> {
    const { botToken, webhookUrl, pool } = this.deps;
    if (botToken) {
      const r = await this.slackApi('chat.postMessage', { channel: m.channel, text: m.text, ...(m.threadTs ? { thread_ts: m.threadTs } : {}) });
      return String(r.ts);
    }
    if (webhookUrl) {
      const res = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: m.text, channel: m.channel }) });
      if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
      return `webhook:${Date.now()}`;
    }
    const { rows } = await pool.query<{ ts: string }>(
      `INSERT INTO rollikey_slack_sink (ts, channel, text, thread_ts, run_id)
       VALUES (to_char(extract(epoch FROM clock_timestamp()), 'FM9999999999.000000') || nextval('rollikey_slack_sink_id_seq')::text, $1, $2, $3, $4) RETURNING ts`,
      [m.channel, m.text, m.threadTs ?? null, m.runId]);
    return rows[0]!.ts;
  }

  private async slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.deps.botToken}` }, body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!j.ok) throw new Error(`Slack ${method} failed: ${j.error ?? res.status}`);
    return j;
  }

  private async retract(channel: string, ts: string): Promise<Record<string, unknown>> {
    if (this.deps.botToken) {
      await this.slackApi('chat.delete', { channel, ts });
      return { type: 'slack_message_deleted', channel, ts };
    }
    if (this.deps.webhookUrl || ts.startsWith('webhook:')) {
      throw new RollikeyError('not_compensable', `Message posted via incoming webhook cannot be deleted; remove it from #${channel} manually`);
    }
    await this.deps.pool.query(`UPDATE rollikey_slack_sink SET deleted = true WHERE ts = $1`, [ts]);
    return { type: 'slack_message_deleted', channel, ts, backend: 'sink' };
  }

  // ---- airlock -----------------------------------------------------------------------------------
  async cancelRun(runId: string): Promise<{ cancelled: string[]; alreadySent: string[] }> {
    const { pool, redis } = this.deps;
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE rollikey_slack_queue SET status = 'cancelled', cancelled_at = now() WHERE run_id = $1 AND status = 'held' RETURNING id`, [runId]);
    const cancelled = rows.map((r) => r.id);
    if (cancelled.length) await redis.del(...cancelled.map(slackHoldKey));
    const { rows: sent } = await pool.query<{ id: string }>(
      `SELECT id FROM rollikey_slack_queue WHERE run_id = $1 AND status IN ('releasing', 'released') ORDER BY created_at`, [runId]);
    return { cancelled, alreadySent: sent.map((r) => r.id) };
  }

  private async deliverQueued(id: string): Promise<boolean> {
    const { pool } = this.deps;
    const { rows } = await pool.query<SlackQueueRow>(
      `UPDATE rollikey_slack_queue SET status = 'releasing', attempts = attempts + 1 WHERE id = $1 AND status = 'held' RETURNING *`, [id]);
    const msg = rows[0];
    if (!msg) return false;
    try {
      const ts = await this.deliver({ channel: msg.channel, text: msg.text, threadTs: msg.thread_ts ?? undefined, runId: msg.run_id });
      await pool.query(`UPDATE rollikey_slack_queue SET status = 'released', released_at = now(), message_ts = $2, error = NULL WHERE id = $1`, [id, ts]);
      this.deps.log?.(`slack airlock: released ${id} (run ${msg.run_id}) to #${msg.channel}`);
      return true;
    } catch (err) {
      const giveUp = msg.attempts >= MAX_ATTEMPTS;
      await pool.query(`UPDATE rollikey_slack_queue SET status = $2, error = $3, release_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [id, giveUp ? 'failed' : 'held', (err as Error).message, 10 * msg.attempts]);
      return false;
    }
  }

  async releaseDue(limit = 25): Promise<number> {
    const { pool, redis } = this.deps;
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM rollikey_slack_queue WHERE status = 'held' AND release_at <= now() ORDER BY release_at LIMIT $1`, [limit]);
    let n = 0;
    for (const { id } of rows) {
      if (await redis.exists(slackHoldKey(id))) continue;
      if (await this.deliverQueued(id)) n++;
    }
    return n;
  }

  async releaseNow(id: string): Promise<'released' | 'not_held' | 'send_failed'> {
    const { rows } = await this.deps.pool.query(`SELECT 1 FROM rollikey_slack_queue WHERE id = $1 AND status = 'held'`, [id]);
    if (!rows.length) return 'not_held';
    await this.deps.redis.del(slackHoldKey(id));
    return (await this.deliverQueued(id)) ? 'released' : 'send_failed';
  }

  async listRun(runId: string): Promise<SlackQueueRow[]> {
    return (await this.deps.pool.query<SlackQueueRow>('SELECT * FROM rollikey_slack_queue WHERE run_id = $1 ORDER BY created_at', [runId])).rows;
  }

  async listSink(limit = 30) {
    return (await this.deps.pool.query(
      `SELECT ts, channel, text, run_id, deleted, created_at FROM rollikey_slack_sink ORDER BY id DESC LIMIT $1`, [limit])).rows;
  }

  // ---- inverse used by revert() ----------------------------------------------------------------
  async compensate(snap: SnapshotRow): Promise<Record<string, unknown>> {
    const after = (snap.after_state ?? null) as { mode?: string; queueId?: string; channel?: string; ts?: string } | null;
    if (!after) return { type: 'noop', note: 'Slack post was never issued' };
    if (after.mode === 'direct') return this.retract(after.channel!, after.ts!);
    const { rows } = await this.deps.pool.query<SlackQueueRow>('SELECT * FROM rollikey_slack_queue WHERE id = $1', [after.queueId]);
    const q = rows[0];
    if (!q) return { type: 'noop', note: 'Queue entry missing' };
    if (q.status === 'held') {
      await this.deps.pool.query(`UPDATE rollikey_slack_queue SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'held'`, [q.id]);
      await this.deps.redis.del(slackHoldKey(q.id));
      return { type: 'slack_airlock_cancelled', queueId: q.id };
    }
    if (q.status === 'cancelled' || q.status === 'failed') return { type: 'slack_airlock_cancelled', queueId: q.id, note: `Message never left the airlock (${q.status})` };
    if (q.status === 'releasing') throw new RollikeyError('in_flight', 'Slack message is being released right now; retry the revert in a moment');
    return { ...(await this.retract(q.channel, q.message_ts!)), queueId: q.id, note: 'Already posted; deleted after release' };
  }
}
