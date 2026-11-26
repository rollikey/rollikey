/**
 * Phase 2C: Stripe auth-hold + optional Connect fee, and the side-by-side disaster demo.
 * Uses an in-memory FakeStripe (no network, no real Stripe account) on top of the local Docker stack.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config as baseConfig, parseConnectFeeBps } from '../src/config.js';
import { DisasterDemo } from '../src/demo/disaster.js';
import { FakeStripe } from '../src/demo/fake-stripe.js';
import { createInfra } from '../src/infra.js';
import { createRollikey, type Rollikey } from '../src/engine/index.js';
import { connectFeeCents } from '../src/engine/stripe.js';
import { migrate } from '../src/scripts/migrate.js';

const rid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const infra = createInfra();
const make = (fake: FakeStripe, connect = { feeBps: 0, account: '' }): Rollikey =>
  createRollikey({
    infra: { ...infra, stripe: fake.asStripe(), close: async () => {} },
    config: { ...baseConfig, stripeConnect: connect },
    log: () => {},
  });

before(async () => { await migrate(infra.pool); });
after(() => infra.close());

describe('connect fee config', () => {
  it('defaults to 0 and only allows 0 or 25-50 bps', () => {
    assert.equal(parseConnectFeeBps(undefined), 0);
    assert.equal(parseConnectFeeBps(''), 0);
    assert.equal(parseConnectFeeBps('0'), 0);
    assert.equal(parseConnectFeeBps('25'), 25);
    assert.equal(parseConnectFeeBps('50'), 50);
    for (const bad of ['10', '51', '0.5', '-1', 'abc']) assert.throws(() => parseConnectFeeBps(bad), /ROLLIKEY_CONNECT_FEE_BPS/);
  });
  it('computes floor(amount * bps / 10000)', () => {
    assert.equal(connectFeeCents(24_900, 0), 0);
    assert.equal(connectFeeCents(24_900, 50), 124);
    assert.equal(connectFeeCents(100_000, 25), 250);
    assert.equal(connectFeeCents(100, 25), 0);
  });
});

describe('Stripe auth-hold (manual capture)', () => {
  it('holds funds with capture_method manual and revert() cancels the PaymentIntent', async () => {
    const fake = new FakeStripe();
    const sp = make(fake);
    const pay = fake.seedPayment(50_000);
    const runId = rid('hold');
    const h = await sp.authorizeHold({ runId, amountCents: 24_900, customerId: pay.pi.customer, paymentMethodId: pay.pi.payment_method });
    assert.equal(h.status, 'applied');
    if (h.status !== 'applied') return;
    assert.equal(h.holdStatus, 'requires_capture');
    assert.equal(fake.calls.find((c) => c.op === 'paymentIntents.create')!.params.capture_method, 'manual');
    assert.equal(fake.holdsOutstanding(runId), 1);
    assert.equal(fake.netMoneyOutCents(runId), 0, 'nothing captured while held');

    const report = await sp.revert(runId);
    assert.ok(report.complete);
    assert.equal(report.steps[0]!.actionType, 'stripe.authorize_hold');
    assert.equal(report.steps[0]!.compensation?.type, 'hold_cancelled');
    assert.equal(fake.piMap.get(h.paymentIntentId)!.status, 'canceled');
    assert.equal(fake.calls.filter((c) => c.op === 'paymentIntents.cancel').length, 1);
    assert.equal((await sp.revert(runId)).steps.length, 0, 'idempotent');
  });

  it('captureHolds captures verified holds; a later revert refunds them', async () => {
    const fake = new FakeStripe();
    const sp = make(fake);
    const pay = fake.seedPayment(50_000);
    const runId = rid('cap');
    const h = await sp.authorizeHold({ runId, amountCents: 10_000, customerId: pay.pi.customer, paymentMethodId: pay.pi.payment_method });
    assert.equal(h.status, 'applied');
    const cap = await sp.captureHolds(runId);
    assert.equal(cap.captured.length, 1);
    assert.equal(cap.totalFeeCents, 0, 'self-hosted mode takes no fee');
    assert.equal((await sp.captureHolds(runId)).captured.length, 0, 'captures only once');
    assert.equal(fake.netMoneyOutCents(runId), 10_000);
    const report = await sp.revert(runId);
    assert.ok(report.complete);
    assert.equal(report.steps[0]!.compensation?.type, 'captured_hold_refunded');
  });

  it('blast-radius gate blocks holds above the dollar limit', async () => {
    const fake = new FakeStripe();
    const sp = make(fake);
    const h = await sp.authorizeHold({ runId: rid('big'), amountCents: sp.config.gate.maxAmountCents + 1 });
    assert.equal(h.status, 'blocked');
    assert.equal(fake.piMap.size, 0, 'no PaymentIntent was created');
  });

  it('hosted Connect mode takes the bps fee on capture only, on the connected account', async () => {
    const fake = new FakeStripe();
    const sp = make(fake, { feeBps: 50, account: 'acct_test123' });
    const pay = fake.seedPayment(50_000);
    const runId = rid('fee');
    const h = await sp.authorizeHold({ runId, amountCents: 24_900, customerId: pay.pi.customer, paymentMethodId: pay.pi.payment_method });
    assert.equal(h.status === 'applied' && h.feeCents, 124);
    const create = fake.calls.find((c) => c.op === 'paymentIntents.create')!;
    assert.equal(create.opts.stripeAccount, 'acct_test123');
    assert.equal(create.params.application_fee_amount, undefined, 'no fee is taken while merely held');
    const cap = await sp.captureHolds(runId);
    assert.equal(cap.totalFeeCents, 124);
    assert.equal(fake.calls.find((c) => c.op === 'paymentIntents.capture')!.params.application_fee_amount, 124);
    await sp.revert(runId);
    assert.equal(fake.calls.find((c) => c.op === 'refunds.create')!.params.refund_application_fee, true, 'fee is returned on revert');
  });

  it('a reverted (cancelled) hold never pays a fee, and non-Stripe rollbacks stay free', async () => {
    const fake = new FakeStripe();
    const sp = make(fake, { feeBps: 25, account: 'acct_test123' });
    const runId = rid('free');
    await sp.authorizeHold({ runId, amountCents: 20_000 });
    await sp.revert(runId);
    assert.equal(fake.calls.filter((c) => c.op === 'paymentIntents.capture').length, 0);
    assert.ok(![...fake.calls].some((c) => c.params.application_fee_amount), 'no application fee was ever set');
  });

  it('refuses fee mode without a connected account', async () => {
    const sp = make(new FakeStripe(), { feeBps: 25, account: '' });
    await assert.rejects(sp.authorizeHold({ runId: rid('noacct'), amountCents: 100 }), /ROLLIKEY_CONNECT_ACCOUNT/);
  });
});

describe('side-by-side disaster demo', () => {
  it('unprotected side is wrecked; protected side ends with $0 damage and 100% restored', async () => {
    const live = createRollikey({ infra: { ...infra, close: async () => {} }, log: () => {} });
    const state = await new DisasterDemo(live).runToEnd({ speed: 0 });
    assert.equal(state.status, 'done', state.error ?? '');

    const L = state.left.metrics;
    assert.equal(L.rowsCorrupted, 200);
    assert.ok(L.balanceDamageCents > 0);
    assert.equal(L.stripeDamageCents, 100_000 + 24_900, 'double refund + unwanted charge');
    assert.equal(L.filesDeleted, 25);
    assert.equal(L.emailsLeaked, 1);
    assert.equal(state.left.phase, 'crashed');

    const R = state.right.metrics;
    assert.equal(state.right.phase, 'restored');
    assert.equal(R.totalDamageCents, 0);
    assert.equal(R.rowsCorrupted, 0);
    assert.equal(R.filesDeleted, 0);
    assert.equal(R.emailsLeaked, 0);
    assert.ok(R.blocks >= 2, 'bulk DB update and bulk S3 delete were both blocked by the gate');
    assert.ok(state.right.verify!.every((c) => c.ok), JSON.stringify(state.right.verify));
    assert.ok(state.right.revertMs! < 1000, `revert took ${state.right.revertMs} ms`);
    assert.equal(state.right.airlock?.status, 'cancelled');
  });
});
