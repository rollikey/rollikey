import type pg from 'pg';
import Stripe from 'stripe';
import { z } from 'zod';
import { evaluateGate, type GateLimits } from './gate.js';
import {
  assertRunId,
  completeAction,
  insertSnapshot,
  noteActionError,
  recordAction,
  lockRunXact,
  nextSeq,
  RollikeyError,
  type SnapshotRow,
} from './ledger.js';

export const refundRequestSchema = z
  .object({
    runId: z.string(),
    paymentIntentId: z.string().startsWith('pi_').optional(),
    chargeId: z.string().startsWith('ch_').optional(),
    /** Omit to refund the full remaining refundable amount. */
    amountCents: z.number().int().positive().optional(),
    reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
  })
  .refine((r) => Boolean(r.paymentIntentId) !== Boolean(r.chargeId), {
    message: 'Provide exactly one of paymentIntentId or chargeId',
  });
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export type RefundResult =
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; amountCents: number; refundId: string; refundStatus: string | null }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; amountCents: number; reason: string }
  | { status: 'pending'; runId: string; seq: number; snapshotId: string; amountCents: number; error: string };

export const authorizeHoldSchema = z.object({
  runId: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('usd'),
  customerId: z.string().startsWith('cus_').optional(),
  paymentMethodId: z.string().startsWith('pm_').optional(),
  description: z.string().max(500).optional(),
});
export type AuthorizeHoldRequest = z.input<typeof authorizeHoldSchema>;

export const captureHoldsSchema = z.object({ runId: z.string() });

export type AuthorizeHoldResult =
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; amountCents: number; paymentIntentId: string; holdStatus: string; feeCents: number }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; amountCents: number; reason: string }
  | { status: 'pending'; runId: string; seq: number; snapshotId: string; amountCents: number; error: string };

export interface CaptureHoldsResult {
  runId: string;
  captured: { paymentIntentId: string; amountCents: number; feeCents: number }[];
  skipped: string[];
  totalFeeCents: number;
}

/** Application fee (Stripe Connect) for one captured hold: floor(amount * bps / 10_000). */
export function connectFeeCents(amountCents: number, feeBps: number): number {
  return feeBps > 0 ? Math.floor((amountCents * feeBps) / 10_000) : 0;
}

interface HoldState {
  paymentIntentId?: string;
  stripeAccount?: string;
  feeBps: number;
  captured?: boolean;
  feeCents?: number;
}

interface RefundBeforeState {
  charge: Stripe.Charge;
  paymentIntent: Stripe.PaymentIntent | null;
}

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === 'string' ? v : v.id);

export interface StripeProxyDeps {
  pool: pg.Pool;
  stripe: Stripe | null;
  limits: GateLimits;
  /** Optional Connect settings. feeBps 0 / no account = self-hosted, no fee. */
  connect?: { feeBps: number; account: string };
}

export class StripeProxy {
  constructor(private readonly deps: StripeProxyDeps) {}

  private get stripe(): Stripe {
    if (!this.deps.stripe) throw new RollikeyError('stripe_not_configured', 'STRIPE_SECRET_KEY is not set');
    return this.deps.stripe;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    assertRunId(req.runId);
    const stripe = this.stripe;

    // 1. Pre-flight: capture the exact Before State from Stripe.
    let paymentIntent: Stripe.PaymentIntent | null = null;
    let charge: Stripe.Charge;
    if (req.paymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(req.paymentIntentId, { expand: ['latest_charge'] });
      const latest = paymentIntent.latest_charge;
      if (!latest) throw new RollikeyError('no_charge', `${req.paymentIntentId} has no charge to refund`);
      charge = typeof latest === 'string' ? await stripe.charges.retrieve(latest) : latest;
    } else {
      charge = await stripe.charges.retrieve(req.chargeId!);
      const piId = idOf(charge.payment_intent);
      if (piId) paymentIntent = await stripe.paymentIntents.retrieve(piId);
    }
    const refundable = charge.amount_captured - charge.amount_refunded;
    const amountCents = req.amountCents ?? refundable;
    if (amountCents <= 0) throw new RollikeyError('nothing_refundable', `Charge ${charge.id} has nothing left to refund`);
    if (amountCents > refundable) {
      throw new RollikeyError('over_refund', `Requested ${amountCents} but only ${refundable} cents are refundable on ${charge.id}`);
    }
    const before: RefundBeforeState = { charge, paymentIntent };

    // 2. Gate + ledger write (committed BEFORE the external call).
    const decision = evaluateGate({ rowsAffected: 1, amountCents }, this.deps.limits);
    const client = await this.deps.pool.connect();
    let snap: SnapshotRow;
    try {
      await client.query('BEGIN');
      await lockRunXact(client, req.runId);
      const seq = await nextSeq(client, req.runId);
      snap = await insertSnapshot(client, {
        runId: req.runId,
        seq,
        actionType: 'stripe.refund',
        target: charge.id,
        status: decision.allowed ? 'pending' : 'blocked',
        request: req,
        beforeState: before,
        rowsAffected: 1,
        amountCents,
        ...(decision.allowed ? {} : { blockReason: decision.reason }),
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const base = { runId: req.runId, seq: snap.seq, snapshotId: snap.id, amountCents };
    if (!decision.allowed) return { status: 'blocked', ...base, reason: decision.reason };

    // 3. Execute. The idempotency key ties the Stripe refund to this ledger row.
    try {
      const refund = await stripe.refunds.create(
        {
          charge: charge.id,
          amount: amountCents,
          ...(req.reason ? { reason: req.reason } : {}),
          metadata: { rollikey_run_id: req.runId, rollikey_snapshot_id: snap.id },
        },
        { idempotencyKey: `rollikey-refund-${snap.id}` },
      );
      await this.deps.pool.query(
        `UPDATE rollikey_snapshots SET status = 'applied', after_state = $2 WHERE id = $1`,
        [snap.id, JSON.stringify(refund)],
      );
      return { status: 'applied', ...base, refundId: refund.id, refundStatus: refund.status };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError) {
        // Outcome unknown: leave 'pending' so revert() reconciles against Stripe.
        await this.deps.pool.query(`UPDATE rollikey_snapshots SET error = $2 WHERE id = $1`, [snap.id, message]);
        return { status: 'pending', ...base, error: message };
      }
      await this.deps.pool.query(`UPDATE rollikey_snapshots SET status = 'failed', error = $2 WHERE id = $1`, [snap.id, message]);
      throw err;
    }
  }


  // ---------------------------------------------------------------------------
  // Non-custodial auth-hold: capture_method 'manual'. Funds are only authorised
  // (never moved) until the whole run verifies cleanly and captureHolds() is called.
  // revert(runId) cancels still-held PaymentIntents with paymentIntents.cancel.
  // ---------------------------------------------------------------------------

  private get connectOpts(): { feeBps: number; account: string } {
    const c = this.deps.connect ?? { feeBps: 0, account: '' };
    if (c.feeBps > 0 && !c.account) {
      throw new RollikeyError('connect_account_required', 'ROLLIKEY_CONNECT_FEE_BPS needs ROLLIKEY_CONNECT_ACCOUNT (hosted Connect mode)');
    }
    return c;
  }

  async authorizeHold(input: AuthorizeHoldRequest): Promise<AuthorizeHoldResult> {
    const req = authorizeHoldSchema.parse(input);
    assertRunId(req.runId);
    const stripe = this.stripe;
    const connect = this.connectOpts;
    const requestOpts = connect.account ? { stripeAccount: connect.account } : {};
    const decision = evaluateGate({ rowsAffected: 1, amountCents: req.amountCents }, this.deps.limits);
    const state: HoldState = { feeBps: connect.feeBps, ...(connect.account ? { stripeAccount: connect.account } : {}) };

    const snap = await recordAction(this.deps.pool, {
      runId: req.runId,
      actionType: 'stripe.authorize_hold',
      target: `hold:${req.amountCents}${req.currency}`,
      status: decision.allowed ? 'pending' : 'blocked',
      request: req,
      beforeState: { created: false, ...state },
      rowsAffected: 1,
      amountCents: req.amountCents,
      ...(decision.allowed ? {} : { blockReason: decision.reason }),
    });
    const base = { runId: req.runId, seq: snap.seq, snapshotId: snap.id, amountCents: req.amountCents };
    if (!decision.allowed) return { status: 'blocked', ...base, reason: decision.reason };

    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: req.currency,
          capture_method: 'manual',
          ...(req.customerId ? { customer: req.customerId } : {}),
          ...(req.paymentMethodId ? { payment_method: req.paymentMethodId, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' as const } } : {}),
          ...(req.description ? { description: req.description } : {}),
          metadata: { rollikey_run_id: req.runId, rollikey_snapshot_id: snap.id },
        },
        { idempotencyKey: `rollikey-hold-${snap.id}`, ...requestOpts },
      );
      const after: HoldState = { ...state, paymentIntentId: pi.id };
      await completeAction(this.deps.pool, snap.id, after);
      return { status: 'applied', ...base, paymentIntentId: pi.id, holdStatus: pi.status, feeCents: connectFeeCents(req.amountCents, connect.feeBps) };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError) {
        await noteActionError(this.deps.pool, snap.id, message);
        return { status: 'pending', ...base, error: message };
      }
      await this.deps.pool.query(`UPDATE rollikey_snapshots SET status = 'failed', error = $2 WHERE id = $1`, [snap.id, message]);
      throw err;
    }
  }

  /**
   * Capture every still-held authorisation of the run (call only after the run verified cleanly).
   * In hosted Connect mode the application fee (feeBps) is taken on capture; a cancelled hold never pays a fee.
   */
  async captureHolds(input: { runId: string }): Promise<CaptureHoldsResult> {
    const { runId } = captureHoldsSchema.parse(input);
    assertRunId(runId);
    const stripe = this.stripe;
    const { rows } = await this.deps.pool.query<SnapshotRow>(
      `SELECT * FROM rollikey_snapshots WHERE run_id = $1 AND action_type = 'stripe.authorize_hold' AND status = 'applied' ORDER BY seq`,
      [runId],
    );
    const captured: CaptureHoldsResult['captured'] = [];
    const skipped: string[] = [];
    for (const snap of rows) {
      const st = snap.after_state as HoldState;
      if (!st.paymentIntentId || st.captured) { if (st.paymentIntentId) skipped.push(st.paymentIntentId); continue; }
      const opts = st.stripeAccount ? { stripeAccount: st.stripeAccount } : {};
      const pi = await stripe.paymentIntents.retrieve(st.paymentIntentId, {}, opts);
      if (pi.status !== 'requires_capture') { skipped.push(pi.id); continue; }
      const feeCents = connectFeeCents(pi.amount, st.feeBps);
      const done = await stripe.paymentIntents.capture(
        pi.id,
        feeCents > 0 ? { application_fee_amount: feeCents } : {},
        { idempotencyKey: `rollikey-capture-${snap.id}`, ...opts },
      );
      await this.deps.pool.query(`UPDATE rollikey_snapshots SET after_state = $2 WHERE id = $1`, [snap.id, JSON.stringify({ ...st, captured: true, feeCents })]);
      captured.push({ paymentIntentId: done.id, amountCents: done.amount_received || done.amount, feeCents });
    }
    return { runId, captured, skipped, totalFeeCents: captured.reduce((n, c) => n + c.feeCents, 0) };
  }

  /** Inverse of authorizeHold: cancel an uncaptured hold; if already captured, refund it (and the app fee). */
  private async compensateHold(snap: SnapshotRow): Promise<Record<string, unknown>> {
    const stripe = this.stripe;
    const st = (snap.after_state ?? snap.before_state) as HoldState;
    const opts = st.stripeAccount ? { stripeAccount: st.stripeAccount } : {};
    let piId = st.paymentIntentId;
    if (!piId) {
      // 'pending': outcome unknown. Look the PaymentIntent up by the snapshot id we stamped on it.
      const found = await stripe.paymentIntents.search({ query: `metadata['rollikey_snapshot_id']:'${snap.id}'`, limit: 1 }, opts);
      piId = found.data[0]?.id;
      if (!piId) return { type: 'noop', note: 'Hold was never created at Stripe' };
    }
    const pi = await stripe.paymentIntents.retrieve(piId, {}, opts);
    if (pi.status === 'canceled') return { type: 'noop', paymentIntentId: pi.id, note: 'Hold already cancelled' };
    if (pi.status === 'succeeded') {
      const refund = await stripe.refunds.create(
        { payment_intent: pi.id, ...(st.stripeAccount ? { refund_application_fee: true } : {}), metadata: { rollikey_run_id: snap.run_id, rollikey_snapshot_id: snap.id } },
        { idempotencyKey: `rollikey-revert-${snap.id}`, ...opts },
      );
      return { type: 'captured_hold_refunded', paymentIntentId: pi.id, refundId: refund.id, amountCents: refund.amount };
    }
    const cancelled = await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' }, opts);
    return { type: 'hold_cancelled', paymentIntentId: cancelled.id, status: cancelled.status };
  }

  /**
   * Compensating inverse of a refund. Stripe refunds cannot be undone directly,
   * so: cancel it if it is still cancellable; otherwise re-charge the same
   * amount to the same customer + payment method (off-session).
   */
  async compensate(snap: SnapshotRow): Promise<Record<string, unknown>> {
    return snap.action_type === 'stripe.authorize_hold' ? this.compensateHold(snap) : this.compensateRefund(snap);
  }

  private async compensateRefund(snap: SnapshotRow): Promise<Record<string, unknown>> {
    const stripe = this.stripe;
    const before = snap.before_state as RefundBeforeState;
    let refund = (snap.after_state as Stripe.Refund | null) ?? null;

    if (!refund) {
      // 'pending' snapshot: find out whether the refund actually happened.
      const list = await stripe.refunds.list({ charge: before.charge.id, limit: 100 });
      refund = list.data.find((r) => r.metadata?.rollikey_snapshot_id === snap.id) ?? null;
      if (!refund) return { type: 'noop', note: 'Refund was never created at Stripe' };
    }

    refund = await stripe.refunds.retrieve(refund.id);
    if (refund.status === 'failed' || refund.status === 'canceled') {
      return { type: 'noop', refundId: refund.id, note: `Refund already ${refund.status}` };
    }
    if (refund.status === 'pending' || refund.status === 'requires_action') {
      try {
        const cancelled = await stripe.refunds.cancel(refund.id);
        return { type: 'refund_cancelled', refundId: cancelled.id, refundStatus: cancelled.status };
      } catch {
        // Not cancellable after all; fall through to re-charge.
      }
    }

    const pi = before.paymentIntent;
    const customer = idOf(pi?.customer);
    const paymentMethod = idOf(pi?.payment_method);
    if (!pi || !customer || !paymentMethod) {
      throw new RollikeyError(
        'not_compensable',
        `Refund ${refund.id} succeeded and the original payment has no reusable customer + payment method; manual action required`,
      );
    }
    const recharge = await stripe.paymentIntents.create(
      {
        amount: refund.amount,
        currency: refund.currency,
        customer,
        payment_method: paymentMethod,
        confirm: true,
        off_session: true,
        description: `Rollikey revert of ${refund.id} (run ${snap.run_id})`,
        metadata: { rollikey_run_id: snap.run_id, rollikey_snapshot_id: snap.id, rollikey_reverses: refund.id },
      },
      { idempotencyKey: `rollikey-revert-${snap.id}` },
    );
    if (recharge.status !== 'succeeded') {
      throw new RollikeyError('recharge_failed', `Compensating charge ${recharge.id} ended in status ${recharge.status}`);
    }
    return { type: 'recharged', refundId: refund.id, paymentIntentId: recharge.id, amountCents: recharge.amount };
  }
}
