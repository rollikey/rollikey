import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createRollikey, type Rollikey } from '../engine/index.js';
import { FakeStripe } from './fake-stripe.js';

/**
 * Side-by-side disaster demo: the SAME rogue agent workflow runs twice against disposable sandboxes,
 * once with raw tool access (left) and once through Rollikey (right).
 *  - Postgres: tables demo_unprotected_accounts / demo_protected_accounts (recreated every run)
 *  - S3: MinIO prefixes demo/unprotected/ and demo/protected/
 *  - Stripe: in-memory FakeStripe (never touches a real Stripe account)
 *  - Email: the unprotected side really sends to Mailpit; the protected side goes through the airlock
 */

export type Side = 'left' | 'right';
export type DemoLevel = 'info' | 'ok' | 'warn' | 'bad';
export interface DemoEvent {
  i: number;
  /** ms since the run started. */
  ms: number;
  side: Side;
  kind: 'step' | 'call' | 'blocked' | 'snapshot' | 'airlock' | 'crash' | 'revert' | 'verify' | 'damage' | 'info';
  level: DemoLevel;
  step: number;
  msg: string;
}
export interface SideMetrics {
  rowsCorrupted: number;
  balanceDamageCents: number;
  stripeDamageCents: number;
  totalDamageCents: number;
  filesDeleted: number;
  filesTotal: number;
  emailsLeaked: number;
  snapshots: number;
  blocks: number;
  holdsOutstanding: number;
}
export interface DemoState {
  id: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  now: string;
  holdSeconds: number;
  step: number;
  stepTitles: string[];
  events: DemoEvent[];
  left: { phase: 'idle' | 'running' | 'crashed'; metrics: SideMetrics };
  right: {
    phase: 'idle' | 'running' | 'crashed' | 'reverting' | 'restored';
    metrics: SideMetrics;
    airlock: { id: string; releaseAt: string; status: 'held' | 'cancelled' | 'released' } | null;
    revertMs: number | null;
    verify: { label: string; ok: boolean }[] | null;
  };
  error: string | null;
}

export const STEP_TITLES = ['Corrupt customer balances', 'Charge & double-refund Stripe', 'Delete invoices, email a stranger', 'CRM sync crashes'];

const ACCOUNTS = 200;
const FILES = 25;
const HALLUCINATED = 'jordan.whitfield@northwind-partners.example';
const emptyMetrics = (): SideMetrics => ({ rowsCorrupted: 0, balanceDamageCents: 0, stripeDamageCents: 0, totalDamageCents: 0, filesDeleted: 0, filesTotal: FILES, emailsLeaked: 0, snapshots: 0, blocks: 0, holdsOutstanding: 0 });
const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the agent is allowed to call. The workflow below is identical for both sides. */
interface Tools {
  updateBalances(where: Record<string, unknown>, set: Record<string, number>): Promise<{ ok: true; rows: number } | { ok: false; reason: string; rows: number }>;
  authorizeCharge(amountCents: number): Promise<string>;
  refund(amountCents: number): Promise<string>;
  deleteInvoices(arg: { prefix: string } | { keys: string[] }): Promise<{ ok: true; count: number } | { ok: false; reason: string }>;
  sendEmail(to: string, subject: string, text: string): Promise<string>;
}

export interface DemoOptions {
  /** Multiplies every pause. 1 = ~45 s recording pace; 0 = instant (tests). */
  speed?: number;
}

export class DisasterDemo {
  private state: DemoState;
  private readonly demoSp: Rollikey;
  private readonly fakeLeft = new FakeStripe();
  private readonly fakeRight = new FakeStripe();
  private t0 = 0;
  private emailsLeaked = 0;
  private leftRun = '';
  private rightRun = '';
  private rightSeed = new Map<string, string>(); // key -> etag
  private leftSeedKeys: string[] = [];

  constructor(private readonly sp: Rollikey, private readonly log: (m: string) => void = () => {}) {
    // Share the live Postgres/Redis/SMTP/S3 clients, but give the demo its own fake Stripe and a >=60 s airlock.
    this.demoSp = createRollikey({
      infra: { ...sp.infra, stripe: this.fakeRight.asStripe(), close: async () => {} },
      config: { ...sp.config, airlock: { ...sp.config.airlock, holdSeconds: Math.max(60, sp.config.airlock.holdSeconds) } },
      log,
    });
    this.state = this.fresh();
  }

  private fresh(): DemoState {
    return {
      id: null, status: 'idle', startedAt: null, finishedAt: null, now: new Date().toISOString(),
      holdSeconds: this.demoSp?.config.airlock.holdSeconds ?? 60, step: 0, stepTitles: STEP_TITLES, events: [],
      left: { phase: 'idle', metrics: emptyMetrics() },
      right: { phase: 'idle', metrics: emptyMetrics(), airlock: null, revertMs: null, verify: null },
      error: null,
    };
  }

  get running() { return this.state.status === 'running'; }
  snapshot(): DemoState { return { ...this.state, now: new Date().toISOString() }; }

  private emit(side: Side, kind: DemoEvent['kind'], level: DemoLevel, msg: string) {
    this.state.events.push({ i: this.state.events.length, ms: Date.now() - this.t0, side, kind, level, step: this.state.step, msg });
  }

  /** Start a run in the background; resolves immediately with the id. */
  start(opts: DemoOptions = {}): string {
    if (this.running) throw new Error('A demo run is already in progress');
    const id = `demo_${Date.now()}`;
    this.state = this.fresh();
    this.state.id = id;
    this.state.status = 'running';
    this.state.startedAt = new Date().toISOString();
    this.t0 = Date.now();
    this.leftRun = `${id}_unprotected`;
    this.rightRun = `${id}_protected`;
    this.run(opts.speed ?? 1).catch((err) => {
      this.state.status = 'error';
      this.state.error = (err as Error).message;
      this.state.finishedAt = new Date().toISOString();
      this.log(`demo failed: ${(err as Error).stack}`);
    });
    return id;
  }

  /** Run to completion (used by tests). */
  async runToEnd(opts: DemoOptions = {}): Promise<DemoState> {
    this.start(opts);
    while (this.running) await sleep(25);
    return this.snapshot();
  }

  // ---- sandbox setup ----------------------------------------------------------------------------
  private async reset() {
    const { pool, s3 } = this.sp.infra;
    const bucket = this.sp.config.s3.defaultBucket;
    await this.demoSp.init();
    for (const t of ['demo_unprotected_accounts', 'demo_protected_accounts']) {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${t} (
        id BIGINT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, balance_cents BIGINT NOT NULL, original_cents BIGINT NOT NULL)`);
      await pool.query(`TRUNCATE ${t}`);
      await pool.query(
        `INSERT INTO ${t} (id, name, email, balance_cents, original_cents)
         SELECT g, 'Customer ' || g, 'customer' || g || '@example.test', 2000 + (g * 37) % 4000, 2000 + (g * 37) % 4000
           FROM generate_series(1, ${ACCOUNTS}) g`,
      );
    }
    // wipe + reseed both S3 sandboxes
    for (const side of ['unprotected', 'protected']) {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `demo/${side}/` }));
      if (list.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })), Quiet: true } }));
      for (let n = 1; n <= FILES; n++) {
        const key = `demo/${side}/invoices/inv-${String(n).padStart(4, '0')}.pdf`;
        const body = `Invoice ${n} for Customer ${n}. Amount due: $${(n * 41) % 900}.00\n${'x'.repeat(200)}`;
        const put = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/pdf' }));
        if (side === 'protected') this.rightSeed.set(key, String(put.ETag).replace(/"/g, ''));
        else this.leftSeedKeys.push(key);
      }
    }
  }

  private async measure(side: Side): Promise<SideMetrics> {
    const { pool, s3 } = this.sp.infra;
    const bucket = this.sp.config.s3.defaultBucket;
    const table = side === 'left' ? 'demo_unprotected_accounts' : 'demo_protected_accounts';
    const { rows } = await pool.query<{ n: string; d: string }>(
      `SELECT count(*) FILTER (WHERE balance_cents <> original_cents) AS n, COALESCE(sum(abs(balance_cents - original_cents)), 0) AS d FROM ${table}`,
    );
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `demo/${side === 'left' ? 'unprotected' : 'protected'}/invoices/` }));
    const stripeDamageCents = (side === 'left' ? this.fakeLeft : this.fakeRight).netMoneyOutCents(side === 'left' ? this.leftRun : this.rightRun);
    const m = emptyMetrics();
    m.rowsCorrupted = Number(rows[0]!.n);
    m.balanceDamageCents = Number(rows[0]!.d);
    m.stripeDamageCents = stripeDamageCents;
    m.totalDamageCents = m.balanceDamageCents + stripeDamageCents;
    m.filesDeleted = FILES - (list.KeyCount ?? list.Contents?.length ?? 0);
    if (side === 'left') {
      m.emailsLeaked = this.emailsLeaked;
    } else {
      const { rows: e } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM rollikey_airlock_queue WHERE run_id = $1 AND status IN ('releasing', 'released')`, [this.rightRun]);
      m.emailsLeaked = Number(e[0]!.n);
      const { rows: s } = await pool.query<{ applied: string; blocked: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('applied', 'reverted')) AS applied, count(*) FILTER (WHERE status = 'blocked') AS blocked FROM rollikey_snapshots WHERE run_id = $1`, [this.rightRun]);
      m.snapshots = Number(s[0]!.applied);
      m.blocks = Number(s[0]!.blocked);
      m.holdsOutstanding = this.fakeRight.holdsOutstanding(this.rightRun);
    }
    return m;
  }

  private async refreshMetrics(side?: Side) {
    if (!side || side === 'left') this.state.left.metrics = await this.measure('left');
    if (!side || side === 'right') this.state.right.metrics = await this.measure('right');
  }

  // ---- the two tool surfaces -------------------------------------------------------------------
  private leftTools(): Tools {
    const { pool, s3, mailer } = this.sp.infra;
    const bucket = this.sp.config.s3.defaultBucket;
    const stripe = this.fakeLeft;
    const payment = stripe.seedPayment(100_000);
    const run = this.leftRun;
    return {
      updateBalances: async (where, set) => {
        const cond = Object.keys(where).length ? 'WHERE id <= 10' : '';
        const r = await pool.query(`UPDATE demo_unprotected_accounts SET balance_cents = $1 ${cond}`, [set.balance_cents]);
        return { ok: true, rows: r.rowCount ?? 0 };
      },
      authorizeCharge: async (amount) => {
        const pi = await stripe.paymentIntents.create({ amount, currency: 'usd', customer: payment.pi.customer, payment_method: payment.pi.payment_method, confirm: true, metadata: { agent_run: run } });
        return pi.id as string;
      },
      refund: async (amount) => (await stripe.refunds.create({ charge: payment.charge.id, amount })).id as string,
      deleteInvoices: async (arg) => {
        const keys = 'keys' in arg ? arg.keys : this.leftSeedKeys;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
        return { ok: true, count: keys.length };
      },
      sendEmail: async (to, subject, text) => {
        await mailer.sendMail({ from: this.sp.config.smtp.from, to, subject, text });
        this.emailsLeaked++;
        return 'sent';
      },
    };
  }

  private rightTools(): Tools {
    const sp = this.demoSp;
    const runId = this.rightRun;
    const payment = this.fakeRight.seedPayment(100_000);
    const prefix = 'demo/protected/invoices/';
    return {
      updateBalances: async (where, set) => {
        const w = Object.keys(where).length ? { id: { op: 'lte' as const, value: 10 } } : { id: { op: 'gte' as const, value: 0 } };
        const r = await sp.updateRows({ runId, table: 'demo_protected_accounts', where: w, set });
        return r.status === 'applied' ? { ok: true, rows: r.rowsAffected } : { ok: false, reason: r.reason, rows: r.rowsMatched };
      },
      authorizeCharge: async (amount) => {
        const h = await sp.authorizeHold({ runId, amountCents: amount, customerId: payment.pi.customer, paymentMethodId: payment.pi.payment_method, description: 'Agent expedite fee' });
        if (h.status !== 'applied') throw new Error(`hold ${h.status}`);
        return h.paymentIntentId;
      },
      refund: async (amount) => {
        const r = await sp.refund({ runId, paymentIntentId: payment.pi.id, amountCents: amount });
        if (r.status !== 'applied') throw new Error(`refund ${r.status}`);
        return r.refundId;
      },
      deleteInvoices: async (arg) => {
        const r = await sp.deleteObjects('keys' in arg ? { runId, keys: arg.keys } : { runId, prefix });
        return r.status === 'applied' ? { ok: true, count: r.objects } : { ok: false, reason: r.reason };
      },
      sendEmail: async (to, subject, text) => (await sp.sendEmail({ runId, to, subject, text })).id,
    };
  }

  // ---- the rogue agent: identical for both sides ------------------------------------------------
  private async workflow(side: Side, tools: Tools, wait: (s: number) => Promise<void>) {
    const protectedSide = side === 'right';
    const step = (n: number) => { if (this.state.step < n) this.state.step = n; };
    const say = (kind: DemoEvent['kind'], level: DemoLevel, msg: string) => this.emit(side, kind, level, msg);
    const settle = async () => { await this.refreshMetrics(side); };
    const fallbackKeys = (side === 'left' ? this.leftSeedKeys : [...this.rightSeed.keys()]).slice(0, 10);

    // Step 1: bulk balance wipe, then a "smaller batch" retry if the gate stops it.
    await wait(1.2); step(1);
    say('step', 'info', `Step 1 · ${STEP_TITLES[0]}`);
    say('call', 'info', `UPDATE balance_cents = 0 on ${ACCOUNTS} customers`);
    const bulk = await tools.updateBalances({}, { balance_cents: 0 });
    if (bulk.ok) {
      say('call', 'bad', `${bulk.rows} balances overwritten with $0.00`);
      if (!protectedSide) await settle();
    } else {
      say('blocked', 'warn', `BLOCKED by Blast-Radius Gate · ${bulk.rows} rows > limit ${this.sp.config.gate.maxRows}`);
      await settle();
      await wait(2.5);
      say('call', 'info', 'Agent adapts: retry as a batch of 10 customers');
      const small = await tools.updateBalances({ batch: true }, { balance_cents: 0 });
      if (small.ok) {
        say('snapshot', 'ok', `Pre-flight snapshot saved · before-state of ${small.rows} rows`);
        say('call', 'warn', `${small.rows} balances overwritten (allowed, but revertable)`);
      }
    }
    await settle();

    // Step 2: unwanted $249 charge + duplicate refunds
    await wait(3.2); step(2);
    say('step', 'info', `Step 2 · ${STEP_TITLES[1]}`);
    say('call', 'info', 'Charge customer $249.00 "expedite fee"');
    await tools.authorizeCharge(24_900);
    if (protectedSide) say('snapshot', 'ok', 'Stripe auth-hold only (capture_method: manual) · no money moved');
    else say('call', 'bad', '$249.00 captured from the customer, no questions asked');
    await settle();
    await wait(2.4);
    say('call', 'info', 'Refund $500.00 (order #8841)');
    await tools.refund(50_000);
    if (protectedSide) say('snapshot', 'ok', 'Pre-flight snapshot · charge + PaymentIntent state saved');
    await settle();
    await wait(2);
    say('call', 'info', 'Timeout, agent retries: refund $500.00 (order #8841) again');
    await tools.refund(50_000);
    if (protectedSide) say('snapshot', 'ok', 'Pre-flight snapshot saved · duplicate refund is recorded in the ledger');
    else say('call', 'bad', 'Duplicate refund went through: $1,000.00 refunded in total');
    await settle();

    // Step 3: delete invoices (bulk), then email a hallucinated recipient
    await wait(3.4); step(3);
    say('step', 'info', `Step 3 · ${STEP_TITLES[2]}`);
    say('call', 'info', `DELETE s3://…/invoices/ (${FILES} files)`);
    const del = await tools.deleteInvoices({ prefix: 'demo/' + (protectedSide ? 'protected' : 'unprotected') + '/invoices/' });
    if (del.ok) say('call', 'bad', `${del.count} invoice files permanently deleted`);
    else {
      say('blocked', 'warn', `BLOCKED by Blast-Radius Gate · ${FILES} objects > limit ${this.sp.config.gate.maxBulkItems}`);
      await settle();
      await wait(2);
      say('call', 'info', 'Agent adapts: delete 10 files explicitly');
      const small = await tools.deleteInvoices({ keys: fallbackKeys });
      if (small.ok) say('snapshot', 'ok', `${small.count} files copied to the recovery vault, then deleted`);
    }
    await settle();
    await wait(2.4);
    say('call', 'info', `Email ${HALLUCINATED} (hallucinated recipient) with a customer's balance`);
    await tools.sendEmail(HALLUCINATED, 'Your account balance and refund confirmation', `Hi Jordan, Customer 1 now has a balance of $0.00 and a refund of $1,000.00 is on its way.`);
    if (protectedSide) {
      const held = (await this.sp.infra.pool.query<{ id: string; release_at: Date }>(`SELECT id, release_at FROM rollikey_airlock_queue WHERE run_id = $1 AND status = 'held'`, [this.rightRun])).rows[0];
      if (held) this.state.right.airlock = { id: held.id, releaseAt: held.release_at.toISOString(), status: 'held' };
      say('airlock', 'ok', `Email HELD in the ${this.state.holdSeconds}-second Airlock · nothing leaves the building`);
    } else {
      say('call', 'bad', 'Email DELIVERED to a stranger. Customer data leaked.');
    }
    await settle();

    // Step 4: crash
    await wait(5); step(4);
    say('step', 'info', `Step 4 · ${STEP_TITLES[3]}`);
    say('call', 'info', 'sync_to_crm()');
    await wait(1.4);
    throw new Error('CRM sync failed: 502 Bad Gateway (agent process crashed)');
  }

  private async run(speed: number) {
    const wait = (s: number) => sleep(Math.round(s * 1000 * speed));
    await this.reset();
    await this.refreshMetrics();
    this.state.left.phase = 'running';
    this.state.right.phase = 'running';
    this.emit('left', 'info', 'info', 'Unprotected agent connected directly to the database, S3, Stripe and email');
    this.emit('right', 'info', 'info', 'Same agent, same tools, wrapped by Rollikey');

    const left = (async () => {
      try { await this.workflow('left', this.leftTools(), wait); }
      catch (err) {
        this.state.left.phase = 'crashed';
        this.emit('left', 'crash', 'bad', `✖ CRASH at step 4: ${(err as Error).message}`);
        await wait(1.2);
        await this.refreshMetrics('left');
        this.emit('left', 'damage', 'bad', 'No snapshots. No undo. The damage is permanent.');
      }
    })();

    const right = (async () => {
      try { await this.workflow('right', this.rightTools(), wait); }
      catch (err) {
        this.state.right.phase = 'crashed';
        this.emit('right', 'crash', 'bad', `✖ Step-4 crash detected: ${(err as Error).message}`);
        await this.refreshMetrics('right');
        await wait(2.2);
        this.state.right.phase = 'reverting';
        this.emit('right', 'revert', 'warn', 'revert(runId): cancelling airlock, then LIFO undo…');
        const t = performance.now();
        const report = await this.demoSp.revert(this.rightRun);
        const ms = Math.round(performance.now() - t);
        this.state.right.revertMs = ms;
        for (const s of [...report.steps]) {
          const label = s.actionType === 'pg.update' ? 'restored database rows' : s.actionType === 's3.delete' ? 'restored S3 files from the vault'
            : s.actionType === 'stripe.refund' ? 'refund compensated' : s.actionType === 'stripe.authorize_hold' ? 'auth-hold cancelled (paymentIntents.cancel)' : s.actionType;
          this.emit('right', 'revert', s.status === 'reverted' ? 'ok' : 'bad', `#${s.seq} ${label}`);
        }
        this.emit('right', 'revert', 'ok', `${report.emails.cancelled.length} email cancelled in the airlock · 0 sent`);
        if (this.state.right.airlock) this.state.right.airlock.status = report.emails.cancelled.length ? 'cancelled' : 'released';
        this.emit('right', 'revert', report.complete ? 'ok' : 'bad', `Reverted in ${ms} ms`);
        await this.refreshMetrics('right');
        this.state.right.verify = await this.verifyRight();
        const ok = this.state.right.verify.filter((v) => v.ok).length;
        const total = this.state.right.verify.length;
        this.state.right.phase = 'restored';
        this.emit('right', 'verify', ok === total ? 'ok' : 'bad', `${ok}/${total} state checks restored · damage ${usd(this.state.right.metrics.totalDamageCents)}`);
      }
    })();

    await Promise.all([left, right]);
    await this.refreshMetrics();
    this.state.status = 'done';
    this.state.finishedAt = new Date().toISOString();
  }

  /** Independent proof that the protected side is byte-for-byte back where it started. */
  private async verifyRight(): Promise<{ label: string; ok: boolean }[]> {
    const { pool, s3 } = this.sp.infra;
    const bucket = this.sp.config.s3.defaultBucket;
    const { rows } = await pool.query<{ ok: string; total: string }>(`SELECT count(*) FILTER (WHERE balance_cents = original_cents) AS ok, count(*) AS total FROM demo_protected_accounts`);
    let same = 0;
    for (const [key, etag] of this.rightSeed) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(() => null);
      if (head && String(head.ETag).replace(/"/g, '') === etag) same++;
    }
    const m = this.state.right.metrics;
    const mail = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM rollikey_airlock_queue WHERE run_id = $1 AND status = 'cancelled'`, [this.rightRun])).rows[0]!;
    return [
      { label: `Customer balances ${rows[0]!.ok}/${rows[0]!.total}`, ok: rows[0]!.ok === rows[0]!.total },
      { label: `Invoice files ${same}/${FILES}, same bytes`, ok: same === FILES },
      { label: `Stripe net movement ${usd(this.fakeRight.netMoneyOutCents(this.rightRun))}`, ok: this.fakeRight.netMoneyOutCents(this.rightRun) === 0 },
      { label: 'Stripe auth-hold cancelled, nothing captured', ok: m.holdsOutstanding === 0 },
      { label: `Emails leaked ${m.emailsLeaked} · cancelled in airlock ${mail.n}`, ok: m.emailsLeaked === 0 && Number(mail.n) === 1 },
    ];
  }
}

/** Short stable fingerprint helper (kept for tests that want to compare sandboxes). */
export const fingerprint = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);
