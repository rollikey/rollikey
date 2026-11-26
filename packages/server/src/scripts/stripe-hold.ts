/**
 * Live Stripe Test Mode check for the non-custodial auth-hold:
 * authorize a $249 hold (capture_method manual), then revert() and verify it was cancelled.
 *   npx tsx packages/server/src/scripts/stripe-hold.ts
 */
import assert from 'node:assert/strict';
import { createRollikey } from '../engine/index.js';

const sp = createRollikey({ log: () => {} });
const stripe = sp.infra.stripe;
if (!stripe) throw new Error('STRIPE_SECRET_KEY (test key) is not set');

try {
  const runId = `stripe_hold_${Date.now()}`;
  const customer = await stripe.customers.create({ name: 'Rollikey Hold Test', description: runId });
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });

  const hold = await sp.authorizeHold({ runId, amountCents: 24_900, customerId: customer.id, paymentMethodId: pm.id });
  assert.equal(hold.status, 'applied');
  if (hold.status !== 'applied') throw new Error('unreachable');
  assert.equal(hold.holdStatus, 'requires_capture');
  console.log(`hold ${hold.paymentIntentId}: ${hold.holdStatus} (no money moved)`);

  const report = await sp.revert(runId);
  assert.ok(report.complete);
  const after = await stripe.paymentIntents.retrieve(hold.paymentIntentId);
  assert.equal(after.status, 'canceled');
  console.log(`revert -> ${report.steps[0]!.compensation?.type}; PaymentIntent is now ${after.status}`);
  console.log('STRIPE HOLD CHECK PASSED');
} finally {
  await sp.close();
}
