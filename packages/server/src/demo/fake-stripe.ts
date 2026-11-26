import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';

/**
 * In-memory stand-in for the slice of the Stripe API that Rollikey uses.
 * Powers the /demo disaster comparison (so a recording never touches a real account or network)
 * and deterministic unit tests. It models PaymentIntents (incl. capture_method manual), charges,
 * refunds and off-session re-charges. It is NOT a general Stripe emulator.
 */
type Obj = Record<string, any>;
const id = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export class FakeStripe {
  readonly piMap = new Map<string, Obj>();
  readonly chargeMap = new Map<string, Obj>();
  readonly refundMap = new Map<string, Obj>();
  /** idempotency key -> created object, like Stripe's 24h idempotency cache. */
  private readonly idem = new Map<string, Obj>();
  /** Every request option set seen (lets tests assert stripeAccount / application_fee_amount). */
  readonly calls: { op: string; params: Obj; opts: Obj }[] = [];

  private note(op: string, params: Obj = {}, opts: Obj = {}) { this.calls.push({ op, params, opts }); }
  private once<T extends Obj>(opts: Obj | undefined, make: () => T): T {
    const k = opts?.idempotencyKey as string | undefined;
    if (k && this.idem.has(k)) return this.idem.get(k) as T;
    const v = make();
    if (k) this.idem.set(k, v);
    return v;
  }

  customers = { create: async (p: Obj) => ({ id: id('cus'), ...p }) };

  paymentIntents = {
    create: async (p: Obj, opts?: Obj) => {
      this.note('paymentIntents.create', p, opts);
      return this.once(opts, () => {
        const manual = p.capture_method === 'manual';
        const confirmed = Boolean(p.confirm);
        const pi: Obj = {
          id: id('pi'), object: 'payment_intent', amount: p.amount, currency: p.currency ?? 'usd',
          customer: p.customer ?? null, payment_method: p.payment_method ?? null, capture_method: manual ? 'manual' : 'automatic',
          metadata: p.metadata ?? {}, description: p.description ?? null, latest_charge: null, amount_received: 0,
          application_fee_amount: p.application_fee_amount ?? null,
          status: confirmed ? (manual ? 'requires_capture' : 'succeeded') : 'requires_payment_method',
          account: opts?.stripeAccount ?? null,
        };
        if (confirmed && !manual) this.makeCharge(pi);
        if (confirmed && manual) this.makeCharge(pi, false);
        this.piMap.set(pi.id, pi);
        return pi;
      });
    },
    retrieve: async (piId: string, params?: Obj, _opts?: Obj) => {
      const pi = this.must(this.piMap, piId);
      if (params?.expand?.includes('latest_charge') && pi.latest_charge) return { ...pi, latest_charge: this.chargeMap.get(pi.latest_charge) };
      return pi;
    },
    capture: async (piId: string, p: Obj = {}, opts?: Obj) => {
      this.note('paymentIntents.capture', p, opts);
      const pi = this.must(this.piMap, piId);
      if (pi.status !== 'requires_capture') throw this.err(`PaymentIntent status is ${pi.status}, not capturable`);
      pi.status = 'succeeded';
      pi.amount_received = pi.amount;
      if (p.application_fee_amount) pi.application_fee_amount = p.application_fee_amount;
      const ch = this.chargeMap.get(pi.latest_charge);
      if (ch) { ch.captured = true; ch.amount_captured = pi.amount; }
      return pi;
    },
    cancel: async (piId: string, p: Obj = {}, opts?: Obj) => {
      this.note('paymentIntents.cancel', p, opts);
      const pi = this.must(this.piMap, piId);
      if (pi.status === 'succeeded' || pi.status === 'canceled') throw this.err(`PaymentIntent status is ${pi.status}, cannot cancel`);
      pi.status = 'canceled';
      return pi;
    },
    search: async (p: Obj, _opts?: Obj) => {
      const m = /metadata\['(\w+)'\]:'([^']*)'/.exec(String(p.query));
      return { data: [...this.piMap.values()].filter((pi) => m && pi.metadata?.[m[1]!] === m[2]) };
    },
  };

  charges = { retrieve: async (chId: string) => this.must(this.chargeMap, chId) };

  refunds = {
    create: async (p: Obj, opts?: Obj) => {
      this.note('refunds.create', p, opts);
      return this.once(opts, () => {
        const ch = p.charge ? this.must(this.chargeMap, p.charge) : this.must(this.chargeMap, this.must(this.piMap, p.payment_intent).latest_charge);
        const amount = p.amount ?? ch.amount_captured - ch.amount_refunded;
        if (amount > ch.amount_captured - ch.amount_refunded) throw this.err('Refund amount exceeds charge amount');
        ch.amount_refunded += amount;
        const r: Obj = { id: id('re'), object: 'refund', amount, currency: ch.currency, charge: ch.id, payment_intent: ch.payment_intent, status: 'succeeded', metadata: p.metadata ?? {} };
        this.refundMap.set(r.id, r);
        return r;
      });
    },
    retrieve: async (rid: string) => this.must(this.refundMap, rid),
    cancel: async (rid: string) => { throw this.err(`Refund ${rid} cannot be cancelled`); },
    list: async (p: Obj) => ({ data: [...this.refundMap.values()].filter((r) => r.charge === p.charge) }),
  };

  balance = { retrieve: async () => ({ available: [] }) };

  /** Seed a succeeded, reusable-card payment (what a past customer order looks like). */
  seedPayment(amountCents: number, customer = id('cus')): { pi: Obj; charge: Obj } {
    const pi: Obj = { id: id('pi'), object: 'payment_intent', amount: amountCents, currency: 'usd', customer, payment_method: id('pm'), capture_method: 'automatic', status: 'succeeded', metadata: {}, amount_received: amountCents, latest_charge: null };
    const charge = this.makeCharge(pi);
    this.piMap.set(pi.id, pi);
    return { pi, charge };
  }

  private makeCharge(pi: Obj, captured = true): Obj {
    const ch: Obj = { id: id('ch'), object: 'charge', amount: pi.amount, currency: pi.currency, captured, amount_captured: captured ? pi.amount : 0, amount_refunded: 0, payment_intent: pi.id };
    this.chargeMap.set(ch.id, ch);
    pi.latest_charge = ch.id;
    return ch;
  }

  // ---- damage accounting used by the demo ------------------------------------------------------
  /**
   * Net money the agent moved: refunds issued + unwanted agent charges captured,
   * minus whatever Rollikey's compensating re-charges won back.
   */
  netMoneyOutCents(tag: string): number {
    const refunded = [...this.refundMap.values()].filter((r) => r.status === 'succeeded').reduce((n, r) => n + r.amount, 0);
    const reversed = [...this.piMap.values()].filter((p) => p.metadata?.rollikey_reverses && p.status === 'succeeded').reduce((n, p) => n + p.amount, 0);
    const agentCharges = [...this.piMap.values()]
      .filter((p) => (p.metadata?.agent_run === tag || p.metadata?.rollikey_run_id === tag) && !p.metadata?.rollikey_reverses && p.status === 'succeeded')
      .reduce((n, p) => n + p.amount, 0);
    return refunded - reversed + agentCharges;
  }
  holdsOutstanding(tag: string): number {
    return [...this.piMap.values()].filter((p) => p.metadata?.rollikey_run_id === tag && p.status === 'requires_capture').length;
  }

  private must<T extends Obj>(m: Map<string, T>, k: string): T {
    const v = m.get(k);
    if (!v) throw this.err(`No such object: ${k}`);
    return v;
  }
  private err(message: string) { return Object.assign(new Error(message), { type: 'invalid_request_error' }); }

  asStripe(): Stripe { return this as unknown as Stripe; }
}
