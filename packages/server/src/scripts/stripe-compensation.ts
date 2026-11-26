/**
 * Live Stripe Test Mode check: seed customer + $1,000 card charge, refund $500
 * through the Rollikey proxy, revert(), and verify the compensating action in Stripe.
 *   npx tsx packages/server/src/scripts/stripe-compensation.ts
 */
import assert from 'node:assert/strict';
import { createRollikey } from '../engine/index.js';

const sp = createRollikey({ log: () => {} });
const stripe = sp.infra.stripe;
if (!stripe) throw new Error('STRIPE_SECRET_KEY is not set');

try {
  const runId = `stripe_comp_${Date.now()}`;
  const customer = await stripe.customers.create({ name: 'Rollikey Compensation Test', description: runId });
  const pi = await stripe.paymentIntents.create({
    amount: 100_000,
    currency: 'usd',
    customer: customer.id,
    payment_method: 'pm_card_visa',
    setup_future_usage: 'off_session',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  assert.equal(pi.status, 'succeeded');
  console.log(`seeded customer ${customer.id}, charge PI ${pi.id} ($1,000.00, ${pi.status})`);

  const refund = await sp.refund({ runId, paymentIntentId: pi.id, amountCents: 50_000 });
  assert.equal(refund.status, 'applied');
  const afterRefund = await stripe.charges.retrieve(String(pi.latest_charge));
  console.log(
    `refund via proxy: ${refund.status} $${refund.amountCents / 100} (${refund.status === 'applied' ? refund.refundId : ''}); charge amount_refunded=${afterRefund.amount_refunded}`,
  );
  assert.equal(afterRefund.amount_refunded, 50_000);

  const report = await sp.revert(runId);
  assert.ok(report.complete, 'revert complete');
  assert.equal(report.steps.length, 1);
  const step = report.steps[0]!;
  assert.equal(step.status, 'reverted');
  console.log(`revert: ${step.status}; compensation=${JSON.stringify(step.compensation)}`);

  const comp = step.compensation as Record<string, any>;
  if (comp.type === 'recharged') {
    const re = await stripe.paymentIntents.retrieve(comp.paymentIntentId);
    assert.equal(re.status, 'succeeded');
    assert.equal(re.amount, 50_000);
    assert.equal(re.customer, customer.id);
    console.log(`verified in Stripe: compensating PI ${re.id} succeeded for $${re.amount / 100}`);
  } else {
    const r = await stripe.refunds.retrieve(String(comp.refundId));
    assert.equal(r.status, 'canceled');
    console.log(`verified in Stripe: refund ${r.id} status=${r.status}`);
  }
  const again = await sp.revert(runId);
  assert.equal(again.steps.length, 0);
  console.log('second revert is a no-op ✓\nSTRIPE COMPENSATION TEST PASSED');
} finally {
  await sp.close();
}
