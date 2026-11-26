import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Rollikey } from '../engine/index.js';
import { runFiveToolDrill } from '../drill/five-tool.js';

export type DrillMode = 'gemini' | 'scripted' | '5tool';
export type DrillStatus = 'starting' | 'running' | 'crashed' | 'reverting' | 'done' | 'error';

export interface DrillEvent {
  t: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  msg: string;
}

export interface Drill {
  id: string;
  mode: DrillMode;
  runId: string | null;
  status: DrillStatus;
  crashed: boolean;
  startedAt: string;
  finishedAt: string | null;
  events: DrillEvent[];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CUSTOMER_ID = 42;
/** Pause (ms) so the airlock hold and the step-4 failure are visible before rollback. */
const PACE_MS = Number(process.env.DRILL_PACE_MS ?? 4000);
const CRASH_TO_REVERT_MS = Number(process.env.DRILL_PAUSE_BEFORE_REVERT_MS ?? 8000);

export class DrillManager {
  readonly drills = new Map<string, Drill>();
  /** runId -> drill, so the run list can flag a crashed-but-not-yet-reverted drill as failed. */
  readonly byRun = new Map<string, Drill>();
  private child: ChildProcess | null = null;

  constructor(private readonly sp: Rollikey) {}

  get active(): Drill | undefined {
    return [...this.drills.values()].find((d) => d.status !== 'done' && d.status !== 'error');
  }

  get latest(): Drill | undefined {
    return [...this.drills.values()].at(-1);
  }

  geminiAvailable(): boolean {
    return Boolean(process.env.LLM_API_KEY) && Boolean(this.sp.infra.stripe);
  }

  start(mode: DrillMode): Drill {
    if (this.active) throw new Error('A chaos drill is already running');
    if (!this.sp.infra.stripe) throw new Error('STRIPE_SECRET_KEY (test key) is required for the drill');
    if (mode === '5tool' && (this.sp.github.live || this.sp.slack.backend !== 'sink')) throw new Error('The 5-tool drill only runs on local sandboxes: unset GITHUB_TOKEN / SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL');
    if (mode === 'gemini' && !process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is not set; use the scripted agent mode');
    const drill: Drill = {
      id: `drill_${Date.now()}`,
      mode,
      runId: null,
      status: 'starting',
      crashed: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      events: [],
    };
    this.drills.set(drill.id, drill);
    for (const k of [...this.drills.keys()].slice(0, -10)) this.drills.delete(k);
    const run = mode === 'gemini' ? this.runGemini(drill) : mode === '5tool' ? this.runFiveTool(drill) : this.runScripted(drill);
    run.catch((err) => this.fail(drill, err));
    return drill;
  }

  /** Abort a running Gemini drill (the child is killed); scripted drills finish on their own. */
  stop(): boolean {
    if (!this.child) return false;
    const d = this.active;
    if (d) this.log(d, 'warn', 'Stopped by operator.');
    this.child.kill('SIGTERM');
    return true;
  }

  private log(d: Drill, level: DrillEvent['level'], msg: string) {
    d.events.push({ t: new Date().toISOString(), level, msg });
    if (d.events.length > 300) d.events.splice(0, d.events.length - 300);
  }

  private setRun(d: Drill, runId: string) {
    d.runId = runId;
    this.byRun.set(runId, d);
  }

  private fail(d: Drill, err: unknown) {
    this.log(d, 'error', `Drill aborted: ${(err as Error).message}`);
    d.status = 'error';
    d.finishedAt = new Date().toISOString();
  }

  // ---- real Gemini agent: reuse the SDK example as a child process --------------------------------
  private async runGemini(d: Drill) {
    const script = resolve(repoRoot, 'packages/sdk/examples/chaos-agent.ts');
    const tsx = resolve(repoRoot, 'node_modules/.bin/tsx');
    if (!existsSync(script) || !existsSync(tsx)) throw new Error('chaos-agent example or tsx binary not found');
    this.log(d, 'info', 'Launching Gemini Chaos Agent (packages/sdk/examples/chaos-agent.ts)…');
    d.status = 'running';
    const child = spawn(tsx, [script], {
      cwd: repoRoot,
      env: { ...process.env, CHAOS_PAUSE_MS: String(CRASH_TO_REVERT_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
        buf = buf.slice(i + 1);
        if (line.trim()) this.parseChaosLine(d, line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    await new Promise<void>((res) => {
      child.on('close', (code) => {
        if (d.status !== 'error') {
          this.log(d, code === 0 ? 'ok' : 'error', `Chaos agent process exited with code ${code}`);
          d.status = code === 0 ? 'done' : 'error';
          d.finishedAt = new Date().toISOString();
        }
        res();
      });
      child.on('error', (e) => { this.fail(d, e); res(); });
    });
    this.child = null;
  }

  private parseChaosLine(d: Drill, line: string) {
    const rid = /run id\s*:\s*(\S+)/.exec(line);
    if (rid) this.setRun(d, rid[1]!);
    if (line.startsWith('✖')) { d.crashed = true; d.status = 'crashed'; this.log(d, 'error', line); return; }
    if (line.includes('ROLLIKEY REVERT')) d.status = 'reverting';
    if (/^[═=]{4,}/.test(line)) { this.log(d, 'info', line.replace(/[═]+/g, '').trim()); return; }
    const level = /✓ PASS|PASSED/.test(line) ? 'ok' : /✗ FAIL|FAILED|✖/.test(line) ? 'error' : /^\s*\(gemini/.test(line) ? 'warn' : 'info';
    this.log(d, level, line);
  }

  // ---- 5-tool drill: Postgres + Stripe + S3 + GitHub + Slack/Email, crash on step 6 -------------
  private async runFiveTool(d: Drill) {
    d.status = 'running';
    const r = await runFiveToolDrill(this.sp, {
      paceMs: PACE_MS,
      pauseBeforeRevertMs: CRASH_TO_REVERT_MS,
      log: (level, msg) => this.log(d, level, msg),
      onRun: (runId) => this.setRun(d, runId),
      onCrash: () => { d.crashed = true; d.status = 'crashed'; },
      onReverting: () => { d.status = 'reverting'; },
    });
    d.status = r.passed ? 'done' : 'error';
    d.finishedAt = new Date().toISOString();
  }

  // ---- deterministic stand-in: same 4 steps, no LLM dependency -------------------------------------
  private async runScripted(d: Drill) {
    const { sp } = this;
    const stripe = sp.infra.stripe!;
    const runId = `drill_${Date.now()}`;
    this.setRun(d, runId);
    d.status = 'running';
    this.log(d, 'info', `Scripted chaos agent, run ${runId}. Creating a $1,000 Stripe test charge…`);
    const sc = await stripe.customers.create({ name: 'Chaos Drill Customer', description: runId });
    const pi = await stripe.paymentIntents.create({
      amount: 100_000,
      currency: 'usd',
      customer: sc.id,
      payment_method: 'pm_card_visa',
      setup_future_usage: 'off_session',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    this.log(d, 'ok', `Stripe test charge ready: ${pi.id}`);
    await sleep(PACE_MS / 2);

    this.log(d, 'info', 'Step 1/4 → rollikey_db_update customers#42 (plan=enterprise, status=suspended)');
    const r1 = await sp.updateRows({ runId, table: 'customers', where: { id: CUSTOMER_ID }, set: { plan: 'enterprise', status: 'suspended', name: 'Chaos Agent Was Here' } });
    this.log(d, r1.status === 'applied' ? 'ok' : 'warn', `  ← ${r1.status} (snapshot ${r1.snapshotId}, seq ${r1.seq})`);
    await sleep(PACE_MS);

    this.log(d, 'info', 'Step 2/4 → rollikey_stripe_refund $500.00');
    const r2 = await sp.refund({ runId, paymentIntentId: pi.id, amountCents: 50_000, reason: 'requested_by_customer' });
    this.log(d, r2.status === 'applied' ? 'ok' : 'warn', `  ← ${r2.status} (seq ${r2.seq})`);
    await sleep(PACE_MS);

    this.log(d, 'info', 'Step 3/4 → rollikey_send_email (enters 60s staging airlock)');
    const r3 = await sp.sendEmail({ runId, to: `customer${CUSTOMER_ID}@example.test`, subject: `[${runId}] Your refund and plan update are confirmed`, text: 'Your refund of $500.00 and plan update are confirmed.' });
    this.log(d, 'ok', `  ← held in airlock until ${new Date(r3.releaseAt).toLocaleTimeString()} (email ${r3.id})`);
    await sleep(PACE_MS * 1.5);

    this.log(d, 'info', 'Step 4/4 → sync_to_crm');
    d.crashed = true;
    d.status = 'crashed';
    this.log(d, 'error', '✖ CHAOS: CRM sync agent crashed at step 4 (injected failure)');
    await sleep(CRASH_TO_REVERT_MS);

    d.status = 'reverting';
    this.log(d, 'warn', 'Running Rollikey revert(runId): cancel airlock, then LIFO compensation…');
    const rep = await sp.revert(runId);
    for (const s of rep.steps) this.log(d, s.status === 'reverted' ? 'ok' : 'error', `  revert seq ${s.seq} ${s.actionType} → ${s.status}`);
    this.log(d, 'ok', `  airlock cancelled ${rep.emails.cancelled.length} email(s), already sent ${rep.emails.alreadySent.length}`);
    if (!rep.complete) this.log(d, 'error', 'CHAOS DRILL FAILED: revert incomplete.');
    else if (rep.emails.alreadySent.length) this.log(d, 'warn', `Rolled back, but ${rep.emails.alreadySent.length} email(s) were released early before the revert and cannot be recalled.`);
    else this.log(d, 'ok', 'CHAOS DRILL PASSED: crash fully contained.');
    d.status = 'done';
    d.finishedAt = new Date().toISOString();
  }
}
