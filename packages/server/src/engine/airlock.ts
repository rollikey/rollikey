import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Transporter } from 'nodemailer';
import { z } from 'zod';
import { assertRunId } from './ledger.js';

export const emailRequestSchema = z
  .object({
    runId: z.string(),
    to: z.union([z.email(), z.array(z.email()).min(1).max(50)]),
    subject: z.string().min(1).max(998),
    text: z.string().optional(),
    html: z.string().optional(),
    from: z.email().optional(),
  })
  .refine((r) => r.text !== undefined || r.html !== undefined, { message: 'Provide text and/or html' });
export type EmailRequest = z.infer<typeof emailRequestSchema>;

export interface AirlockRow {
  id: string;
  run_id: string;
  status: 'held' | 'releasing' | 'released' | 'cancelled' | 'failed';
  from_address: string;
  to_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  release_at: Date;
  attempts: number;
  smtp_message_id: string | null;
  error: string | null;
  created_at: Date;
  released_at: Date | null;
  cancelled_at: Date | null;
}

export interface AirlockDeps {
  pool: pg.Pool;
  redis: Redis;
  mailer: Transporter;
  holdSeconds: number;
  defaultFrom: string;
  log?: (msg: string) => void;
}

const MAX_ATTEMPTS = 5;
export const holdKey = (id: string) => `rollikey:airlock:hold:${id}`;

/**
 * 60-second staging airlock. Every outbound email is written to
 * rollikey_airlock_queue and pinned by a Redis key with a TTL. The worker only
 * releases a message to SMTP once BOTH the Redis hold has expired and the
 * durable release_at has passed, so a Redis flush can't release mail early.
 */
export class Airlock {
  constructor(private readonly deps: AirlockDeps) {}

  async enqueue(req: EmailRequest): Promise<{ status: 'held'; id: string; runId: string; releaseAt: Date }> {
    assertRunId(req.runId);
    const { pool, redis, holdSeconds } = this.deps;
    const to = Array.isArray(req.to) ? req.to : [req.to];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<AirlockRow>(
        `INSERT INTO rollikey_airlock_queue
           (run_id, status, from_address, to_addresses, subject, text_body, html_body, release_at)
         VALUES ($1, 'held', $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         RETURNING *`,
        [req.runId, req.from ?? this.deps.defaultFrom, to, req.subject, req.text ?? null, req.html ?? null, holdSeconds],
      );
      const row = rows[0]!;
      await redis.set(holdKey(row.id), req.runId, 'EX', holdSeconds);
      await client.query('COMMIT');
      return { status: 'held', id: row.id, runId: row.run_id, releaseAt: row.release_at };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Cancel every still-held email of a run. Already-released mail cannot be recalled and is reported. */
  async cancelRun(runId: string): Promise<{ cancelled: string[]; alreadySent: string[] }> {
    const { pool, redis } = this.deps;
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE rollikey_airlock_queue SET status = 'cancelled', cancelled_at = now()
        WHERE run_id = $1 AND status = 'held' RETURNING id`,
      [runId],
    );
    const cancelled = rows.map((r) => r.id);
    if (cancelled.length) await redis.del(...cancelled.map(holdKey));
    const { rows: sent } = await pool.query<{ id: string }>(
      `SELECT id FROM rollikey_airlock_queue WHERE run_id = $1 AND status IN ('releasing', 'released') ORDER BY created_at`,
      [runId],
    );
    return { cancelled, alreadySent: sent.map((r) => r.id) };
  }

  /** One worker pass: release every due message whose Redis hold has expired. */
  async releaseDue(limit = 25): Promise<number> {
    const { pool, redis } = this.deps;
    const { rows: due } = await pool.query<{ id: string }>(
      `SELECT id FROM rollikey_airlock_queue
        WHERE status = 'held' AND release_at <= now() ORDER BY release_at LIMIT $1`,
      [limit],
    );
    let released = 0;
    for (const { id } of due) {
      if (await redis.exists(holdKey(id))) continue; // hold still active (e.g. clock skew)
      if (await this.deliver(id)) released++;
    }
    return released;
  }

  /** Operator override: skip the remaining hold and send one held message now. */
  async releaseNow(id: string): Promise<'released' | 'not_held' | 'send_failed'> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM rollikey_airlock_queue WHERE id = $1 AND status = 'held'`,
      [id],
    );
    if (rows.length === 0) return 'not_held';
    await this.deps.redis.del(holdKey(id));
    const sent = await this.deliver(id);
    if (sent) return 'released';
    const { rows: after } = await this.deps.pool.query<{ status: string }>(
      `SELECT status FROM rollikey_airlock_queue WHERE id = $1`,
      [id],
    );
    return after[0]?.status === 'released' ? 'released' : after[0]?.status === 'cancelled' ? 'not_held' : 'send_failed';
  }

  /** Atomically claim one held message and hand it to SMTP. Returns true when it was sent. */
  private async deliver(id: string): Promise<boolean> {
    const { pool, mailer } = this.deps;
    // Atomic claim: a concurrent cancelRun() and this UPDATE cannot both win.
    const { rows } = await pool.query<AirlockRow>(
      `UPDATE rollikey_airlock_queue SET status = 'releasing', attempts = attempts + 1
        WHERE id = $1 AND status = 'held' RETURNING *`,
      [id],
    );
    const msg = rows[0];
    if (!msg) return false;
    try {
      const info = await mailer.sendMail({
        from: msg.from_address,
        to: msg.to_addresses,
        subject: msg.subject,
        ...(msg.text_body !== null ? { text: msg.text_body } : {}),
        ...(msg.html_body !== null ? { html: msg.html_body } : {}),
        headers: { 'X-Rollikey-Run-Id': msg.run_id, 'X-Rollikey-Airlock-Id': msg.id },
      });
      await pool.query(
        `UPDATE rollikey_airlock_queue SET status = 'released', released_at = now(), smtp_message_id = $2, error = NULL
          WHERE id = $1`,
        [msg.id, info.messageId ?? null],
      );
      this.deps.log?.(`airlock: released ${msg.id} (run ${msg.run_id}) to ${msg.to_addresses.join(', ')}`);
      return true;
    } catch (err) {
      const giveUp = msg.attempts >= MAX_ATTEMPTS;
      await pool.query(
        `UPDATE rollikey_airlock_queue
            SET status = $2, error = $3, release_at = now() + make_interval(secs => $4)
          WHERE id = $1`,
        [msg.id, giveUp ? 'failed' : 'held', (err as Error).message, 10 * msg.attempts],
      );
      this.deps.log?.(`airlock: send failed for ${msg.id}: ${(err as Error).message}`);
      return false;
    }
  }

  startWorker(intervalMs = 1000): { stop(): Promise<void> } {
    let stopped = false;
    let running: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) return;
      running = running
        .then(() => this.releaseDue())
        .catch((err) => this.deps.log?.(`airlock worker error: ${(err as Error).message}`));
    }, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearInterval(timer);
        await running;
      },
    };
  }

  async listRun(runId: string): Promise<AirlockRow[]> {
    const { rows } = await this.deps.pool.query<AirlockRow>(
      'SELECT * FROM rollikey_airlock_queue WHERE run_id = $1 ORDER BY created_at',
      [runId],
    );
    return rows;
  }
}
