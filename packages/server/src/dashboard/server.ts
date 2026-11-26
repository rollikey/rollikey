import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rollikey } from '../engine/index.js';
import { RUN_ID_PATTERN, RollikeyError, type SnapshotRow } from '../engine/ledger.js';
import type { AirlockRow } from '../engine/airlock.js';
import { DrillManager, type DrillMode } from './drill.js';
import { ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { SlackQueueRow } from '../engine/slack.js';
import { shadowReplay } from './shadow.js';
import { DisasterDemo } from '../demo/disaster.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = existsSync(resolve(here, 'public')) ? resolve(here, 'public') : resolve(here, '../../src/dashboard/public');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RunStatus = 'active' | 'failed' | 'reverted' | 'blocked' | 'completed';

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'error') {
    super(message);
  }
}

export interface DashboardOptions {
  sp: Rollikey;
  port: number;
  host?: string;
}

/** Pilot CTA target. Only http(s)/mailto links are allowed; anything else falls back to the README section. */
function safePilotUrl(raw: string | undefined): string {
  const fallback = 'https://github.com/rollikey/rollikey#hosted-cloud--design-partner-pilot';
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href.replace(/"/g, '%22') : fallback;
  } catch {
    return fallback;
  }
}

export function createDashboard({ sp, port, host = '127.0.0.1' }: DashboardOptions): { server: Server; drills: DrillManager } {
  const pool = sp.infra.pool;
  const drills = new DrillManager(sp);
  /** ~1.7x => about a 50 s recording; set DEMO_SPEED=1 for a faster ~30 s run. */
  const demoSpeed = Number(process.env.DEMO_SPEED ?? 1.7);
  const demo = new DisasterDemo(sp, (m) => console.log(`[demo] ${m}`));
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  // Hosted deploys: comma-separated public hostnames (e.g. my-pilot.up.railway.app). Origins may be https there.
  const extraHosts = (process.env.DASHBOARD_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  for (const h of extraHosts) allowedHosts.add(h);
  const pilotUrl = safePilotUrl(process.env.ROLLIKEY_PILOT_URL);
  const renderPage = (file: string) => readFileSync(resolve(publicDir, file), 'utf8').replaceAll('{{PILOT_URL}}', pilotUrl);
  const mailpitUrl = `http://${sp.config.smtp.host}:8025`;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64_000) throw new HttpError(413, 'Body too large');
      chunks.push(c as Buffer);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  const runIdParam = (raw: string) => {
    const id = decodeURIComponent(raw);
    if (!RUN_ID_PATTERN.test(id)) throw new HttpError(400, 'Invalid run id');
    return id;
  };

  // ---- derived views ---------------------------------------------------------------------------
  function deriveStatus(c: { applied: number; blocked: number; reverted: number; failed: number; pending: number; held: number }, crashedUnreverted: boolean): RunStatus {
    if (c.failed > 0) return 'failed';
    if (crashedUnreverted) return 'failed';
    if (c.held > 0) return 'active';
    if (c.reverted > 0 && c.applied === 0 && c.pending === 0) return 'reverted';
    if (c.pending > 0) return 'active';
    if (c.applied === 0 && c.blocked > 0) return 'blocked';
    return 'completed';
  }

  async function listRuns() {
    const { rows } = await pool.query(`
      WITH s AS (
        SELECT run_id,
               count(*)::int AS steps,
               count(*) FILTER (WHERE status = 'applied')::int AS applied,
               count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
               count(*) FILTER (WHERE status = 'reverted')::int AS reverted,
               count(*) FILTER (WHERE status IN ('failed', 'revert_failed'))::int AS failed,
               count(*) FILTER (WHERE status = 'pending')::int AS pending,
               min(created_at) AS started_at,
               max(GREATEST(created_at, reverted_at)) AS last_at
          FROM rollikey_snapshots GROUP BY run_id),
      a AS (
        SELECT run_id,
               count(*)::int AS emails,
               count(*) FILTER (WHERE status = 'held')::int AS held,
               count(*) FILTER (WHERE status = 'released')::int AS released,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
               min(created_at) AS started_at,
               max(GREATEST(created_at, cancelled_at, released_at)) AS last_at
          FROM (SELECT run_id, status, created_at, cancelled_at, released_at FROM rollikey_airlock_queue
                UNION ALL
                SELECT run_id, status, created_at, cancelled_at, released_at FROM rollikey_slack_queue) q
         GROUP BY run_id)
      SELECT COALESCE(s.run_id, a.run_id) AS run_id,
             COALESCE(s.steps, 0) AS steps, COALESCE(s.applied, 0) AS applied, COALESCE(s.blocked, 0) AS blocked,
             COALESCE(s.reverted, 0) AS reverted, COALESCE(s.failed, 0) AS failed, COALESCE(s.pending, 0) AS pending,
             COALESCE(a.emails, 0) AS emails, COALESCE(a.held, 0) AS held,
             COALESCE(a.released, 0) AS released, COALESCE(a.cancelled, 0) AS cancelled,
             LEAST(s.started_at, a.started_at) AS started_at,
             GREATEST(s.last_at, a.last_at) AS last_at
        FROM s FULL JOIN a ON a.run_id = s.run_id
       ORDER BY GREATEST(s.last_at, a.last_at) DESC NULLS LAST
       LIMIT 60`);
    return rows.map((r) => {
      const drill = drills.byRun.get(r.run_id);
      const crashedUnreverted = Boolean(drill?.crashed) && r.reverted === 0 && r.applied > 0;
      const status = deriveStatus(r, crashedUnreverted);
      return { ...r, status, isDrill: Boolean(drill), drillStatus: drill?.status ?? null };
    });
  }

  const kindOf = (a: string) => (a.startsWith('stripe') ? 'stripe' : a.startsWith('s3.') ? 's3' : a.startsWith('github.') ? 'github' : a.startsWith('slack.') ? 'slack' : 'postgres');
  const queueView = (q?: SlackQueueRow) => q ? { id: q.id, status: q.status, reason: q.reason, releaseAt: q.release_at, releasedAt: q.released_at, cancelledAt: q.cancelled_at } : null;
  const gateOf = (s: SnapshotRow) => (s.status === 'blocked' ? 'blocked' : 'approved');

  async function runDetail(runId: string) {
    const { rows: snaps } = await pool.query<SnapshotRow>('SELECT * FROM rollikey_snapshots WHERE run_id = $1 ORDER BY seq', [runId]);
    const { rows: emails } = await pool.query<AirlockRow>('SELECT * FROM rollikey_airlock_queue WHERE run_id = $1 ORDER BY created_at', [runId]);
    const slackQueue = await sp.slack.listRun(runId);
    const slackById = new Map(slackQueue.map((q) => [q.id, q]));
    if (snaps.length === 0 && emails.length === 0 && slackQueue.length === 0) throw new HttpError(404, `Run "${runId}" not found`);
    const drill = drills.byRun.get(runId);
    const steps = [
      ...snaps.map((s) => ({
        kind: kindOf(s.action_type),
        id: s.id,
        seq: s.seq,
        at: s.created_at,
        action: s.action_type,
        target: s.target,
        gate: gateOf(s),
        status: s.status,
        blockReason: s.block_reason,
        rowsAffected: s.rows_affected,
        amountCents: s.amount_cents === null ? null : Number(s.amount_cents),
        request: s.request,
        beforeState: s.before_state,
        afterState: s.after_state,
        compensation: s.compensation,
        error: s.error,
        revertedAt: s.reverted_at,
        ...(s.action_type === 'slack.post' ? { queue: queueView(slackById.get((s.after_state as { queueId?: string } | null)?.queueId ?? '')) } : {}),
      })),
      ...emails.map((e) => ({
        kind: 'email',
        id: e.id,
        seq: null,
        at: e.created_at,
        action: 'email.send',
        target: e.to_addresses.join(', '),
        gate: 'airlock',
        status: e.status,
        subject: e.subject,
        body: e.text_body ?? e.html_body,
        releaseAt: e.release_at,
        releasedAt: e.released_at,
        cancelledAt: e.cancelled_at,
        error: e.error,
      })),
    ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const counts = {
      applied: snaps.filter((s) => s.status === 'applied').length,
      blocked: snaps.filter((s) => s.status === 'blocked').length,
      reverted: snaps.filter((s) => s.status === 'reverted').length,
      failed: snaps.filter((s) => s.status === 'failed' || s.status === 'revert_failed').length,
      pending: snaps.filter((s) => s.status === 'pending').length,
      held: emails.filter((e) => e.status === 'held').length + slackQueue.filter((q) => q.status === 'held').length,
    };
    const crashedUnreverted = Boolean(drill?.crashed) && counts.reverted === 0 && counts.applied > 0;
    return {
      runId,
      status: deriveStatus(counts, crashedUnreverted),
      counts,
      steps,
      drill: drill ? { id: drill.id, mode: drill.mode, status: drill.status, crashed: drill.crashed, events: drill.events } : null,
      now: new Date().toISOString(),
    };
  }

  async function airlockView() {
    const { rows } = await pool.query<AirlockRow>(
      `SELECT * FROM rollikey_airlock_queue
        WHERE status IN ('held', 'releasing') OR created_at > now() - interval '30 minutes'
        ORDER BY (status = 'held') DESC, release_at ASC LIMIT 40`,
    );
    const { rows: slackRows } = await pool.query<SlackQueueRow>(
      `SELECT * FROM rollikey_slack_queue
        WHERE status IN ('held', 'releasing') OR created_at > now() - interval '30 minutes'
        ORDER BY (status = 'held') DESC, release_at ASC LIMIT 40`,
    );
    const slackItems = slackRows.map((q) => ({
      id: q.id, runId: q.run_id, channel: 'slack', status: q.status, from: 'rollikey-bot', to: [`#${q.channel}`],
      subject: q.text, body: `Why airlocked: ${q.reason}`, createdAt: q.created_at, releaseAt: q.release_at,
      releasedAt: q.released_at, cancelledAt: q.cancelled_at, error: q.error,
    }));
    return {
      now: new Date().toISOString(),
      holdSeconds: sp.config.airlock.holdSeconds,
      emails: [...rows.map((e) => ({
        channel: 'email',
        id: e.id,
        runId: e.run_id,
        status: e.status,
        from: e.from_address,
        to: e.to_addresses,
        subject: e.subject,
        body: e.text_body ?? e.html_body,
        createdAt: e.created_at,
        releaseAt: e.release_at,
        releasedAt: e.released_at,
        cancelledAt: e.cancelled_at,
        error: e.error,
      })), ...slackItems].sort((a, b) => (a.status === 'held' ? 0 : 1) - (b.status === 'held' ? 0 : 1) || +new Date(a.releaseAt) - +new Date(b.releaseAt)),
    };
  }

  async function sandboxView() {
    const bucket = sp.config.s3.defaultBucket;
    const objects = await sp.infra.s3
      .send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 200 }))
      .then((r) => (r.Contents ?? []).sort((a, b) => +(b.LastModified ?? 0) - +(a.LastModified ?? 0)).slice(0, 12).map((o) => ({ key: o.Key, size: o.Size, modified: o.LastModified })))
      .catch(() => []);
    const { rows: branches } = await pool.query(`SELECT name, sha, protected FROM sandbox_gh_branches WHERE repo = $1 ORDER BY name`, [sp.config.github.defaultRepo]).catch(() => ({ rows: [] }));
    const { rows: items } = await pool.query(`SELECT number, kind, title, state FROM sandbox_gh_items WHERE repo = $1 AND (state = 'closed' OR title LIKE 'CHAOS%') ORDER BY updated_at DESC LIMIT 8`, [sp.config.github.defaultRepo]).catch(() => ({ rows: [] }));
    return {
      s3: { bucket, objects },
      github: { repo: sp.config.github.defaultRepo, live: sp.github.live, branches, changedItems: items },
      slack: { backend: sp.slack.backend, inbox: await sp.slack.listSink(15) },
    };
  }

  async function health() {
    const timed = async <T>(fn: () => Promise<T>): Promise<{ ok: boolean; detail?: string }> => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    };
    const [postgres, redis, mailpit, stripe, minio] = await Promise.all([
      timed(() => pool.query('SELECT 1')),
      timed(() => sp.infra.redis.ping()),
      timed(async () => {
        const r = await fetch(`${mailpitUrl}/api/v1/info`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
      sp.infra.stripe ? timed(() => sp.infra.stripe!.balance.retrieve()) : Promise.resolve({ ok: false, detail: 'STRIPE_SECRET_KEY not set' }),
      timed(() => sp.infra.s3.send(new HeadBucketCommand({ Bucket: sp.config.s3.defaultBucket }))),
    ]);
    return {
      postgres, redis, mailpit, stripe, minio,
      github: { mode: sp.github.live ? 'live' : 'sandbox' }, slack: { backend: sp.slack.backend },
      mailpitUrl: `http://localhost:8025`,
      stripeMode: sp.infra.stripe ? 'test' : null,
      holdSeconds: sp.config.airlock.holdSeconds,
      gate: sp.config.gate,
      geminiAvailable: drills.geminiAvailable(),
      scriptedAvailable: Boolean(sp.infra.stripe),
      fiveToolAvailable: Boolean(sp.infra.stripe) && !sp.github.live && sp.slack.backend === 'sink',
    };
  }

  // ---- request router --------------------------------------------------------------------------
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // DNS-rebinding / drive-by protection: only our own origin may talk to this server.
    if (!allowedHosts.has(String(req.headers.host))) throw new HttpError(403, 'Forbidden host');
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && ![...allowedHosts].some((h) => origin === `http://${h}` || origin === `https://${h}`)) throw new HttpError(403, 'Forbidden origin');
      if (req.headers['x-rollikey-ui'] !== '1') throw new HttpError(403, 'Missing X-Rollikey-UI header');
    }

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage('index.html'));
      return;
    }
    if (method === 'GET' && (path === '/demo' || path === '/demo/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage('demo.html'));
      return;
    }
    if (method === 'GET' && (path === '/rollikey-logo.svg' || path === '/favicon.svg' || path === '/favicon.ico')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      res.end(readFileSync(resolve(publicDir, path === '/rollikey-logo.svg' ? 'rollikey-logo.svg' : 'favicon.svg')));
      return;
    }
    if (method === 'GET' && path === '/api/demo') return json(res, 200, demo.snapshot());
    if (method === 'POST' && path === '/api/demo/run') {
      if (demo.running) throw new HttpError(409, 'A demo run is already in progress', 'demo_running');
      return json(res, 202, { id: demo.start({ speed: demoSpeed }) });
    }
    if (method === 'GET' && path === '/api/health') return json(res, 200, await health());
    if (method === 'GET' && path === '/api/runs') return json(res, 200, { now: new Date().toISOString(), runs: await listRuns() });
    if (method === 'GET' && path === '/api/sandbox') return json(res, 200, await sandboxView());
    if (method === 'GET' && path === '/api/airlock') return json(res, 200, await airlockView());
    if (method === 'GET' && path === '/api/drill') {
      const d = drills.latest;
      return json(res, 200, { drill: d ?? null, active: Boolean(drills.active) });
    }

    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)$/.exec(path))) return json(res, 200, await runDetail(runIdParam(m[1]!)));

    if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/revert$/.exec(path))) {
      const runId = runIdParam(m[1]!);
      const report = await sp.revert(runId);
      return json(res, 200, report);
    }
    if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/replay$/.exec(path))) {
      return json(res, 200, await shadowReplay(pool, runIdParam(m[1]!)));
    }
    if (method === 'POST' && (m = /^\/api\/airlock\/([^/]+)\/release$/.exec(path))) {
      const id = m[1]!;
      if (!UUID.test(id)) throw new HttpError(400, 'Invalid email id');
      let result = await sp.airlock.releaseNow(id);
      if (result === 'not_held') result = await sp.slack.releaseNow(id);
      if (result === 'not_held') throw new HttpError(409, 'Email is no longer held (already released, cancelled or reverted)', 'not_held');
      if (result === 'send_failed') throw new HttpError(502, 'SMTP send failed; message returned to the airlock queue', 'send_failed');
      return json(res, 200, { status: 'released', id });
    }
    if (method === 'POST' && path === '/api/drill/stop') return json(res, 200, { stopped: drills.stop() });
    if (method === 'POST' && path === '/api/drill') {
      const body = await readBody(req);
      const mode: DrillMode = body.mode === '5tool' ? '5tool' : body.mode === 'scripted' ? 'scripted' : 'gemini';
      try {
        const d = drills.start(mode);
        return json(res, 202, { drill: d });
      } catch (e) {
        throw new HttpError(409, (e as Error).message, 'drill_unavailable');
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message, code: err.code });
      if (err instanceof RollikeyError) return json(res, 400, { error: err.message, code: err.code });
      console.error('[dashboard] error:', err);
      return json(res, 500, { error: (err as Error).message });
    });
  });
  server.listen(port, host);
  return { server, drills };
}
