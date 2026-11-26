/**
 * End-to-end demo against the local Docker stack. Run with a short airlock to
 * see delivery quickly:  ROLLIKEY_AIRLOCK_SECONDS=3 npm run demo
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRollikey } from '../engine/index.js';

const sp = createRollikey({ log: (m) => console.log(`  · ${m}`) });
const { pool } = sp.infra;
const hold = sp.config.airlock.holdSeconds;

const snapshotOf = async (ids: number[]) =>
  (await pool.query<{ row: unknown }>('SELECT to_jsonb(c) AS row FROM customers c WHERE id = ANY($1) ORDER BY id', [ids])).rows.map(
    (r) => r.row,
  );

async function main() {
  const runId = `demo_${Date.now()}`;
  console.log(`\n▶ Run ${runId}`);
  const watched = [1, 2, 3, 4];
  const original = await snapshotOf(watched);

  // 1. Small, allowed update (3 rows, no money).
  const r1 = await sp.updateRows({ runId, table: 'customers', where: { id: { op: 'in', value: [1, 2, 3] } }, set: { status: 'suspended' } });
  console.log(`1. update 3 rows → ${r1.status} (seq ${r1.seq})`);
  assert.equal(r1.status, 'applied');

  // 2. Bulk update: blocked by the row gate.
  const r2 = await sp.updateRows({ runId, table: 'customers', where: { plan: 'free' }, set: { plan: 'pro' } });
  console.log(`2. bulk update → ${r2.status}: ${r2.status === 'blocked' ? r2.reason : ''}`);
  assert.equal(r2.status, 'blocked');

  // 3. Single-row update moving >$1,000: blocked by the money gate.
  const { rows: rich } = await pool.query<{ id: number }>(
    'SELECT id FROM customers WHERE balance_cents > 150000 ORDER BY id LIMIT 1',
  );
  const r3 = await sp.updateRows({ runId, table: 'customers', where: { id: rich[0]!.id }, set: { balance_cents: 0 } });
  console.log(`3. zero a large balance → ${r3.status}: ${r3.status === 'blocked' ? r3.reason : ''}`);
  assert.equal(r3.status, 'blocked');

  // 4. Second touch of row 2, then delete row 4 (LIFO must unwind both correctly).
  const r4 = await sp.updateRows({ runId, table: 'customers', where: { id: 2 }, set: { name: 'Changed By Agent', balance_cents: 1234 } });
  const r5 = await sp.deleteRows({ runId, table: 'customers', where: { id: 4 } });
  console.log(`4. update row 2 again → ${r4.status}; delete row 4 → ${r5.status}`);
  assert.equal(r5.status, 'applied');
  assert.equal((await snapshotOf([4])).length, 0);

  // 5. Emails go to the airlock, not SMTP.
  const e1 = await sp.sendEmail({ runId, to: 'ada@example.test', subject: `[${runId}] Your account was suspended`, text: 'Sorry!' });
  console.log(`5. email → ${e1.status} until ${e1.releaseAt.toISOString()}`);
  assert.equal(await sp.infra.redis.exists(`rollikey:airlock:hold:${e1.id}`), 1);

  // 6. Revert the whole run.
  const report = await sp.revert(runId);
  console.log(`6. revert → complete=${report.complete}, emails cancelled=${report.emails.cancelled.length}`);
  for (const s of report.steps) console.log(`     seq ${s.seq} ${s.actionType} → ${s.status} ${JSON.stringify(s.compensation ?? s.error)}`);
  assert.ok(report.complete);
  assert.deepEqual(report.steps.map((s) => s.seq), [5, 4, 1], 'LIFO order over applied actions only');
  assert.deepEqual(report.emails.cancelled, [e1.id]);
  assert.deepEqual(await snapshotOf(watched), original, 'rows restored byte-for-byte');
  console.log('   ✓ customers 1-4 identical to pre-run state; email cancelled');

  // 7. Revert again is a no-op (idempotent).
  const again = await sp.revert(runId);
  assert.equal(again.steps.length, 0);
  console.log('7. second revert → no-op ✓');

  // 8. Airlock release path: an un-reverted email reaches Mailpit after the hold.
  const runB = `${runId}_mail`;
  const worker = sp.startAirlockWorker(500);
  const e2 = await sp.sendEmail({ runId: runB, to: 'grace@example.test', subject: `[${runB}] Hello from the airlock`, text: 'Released after hold.' });
  console.log(`8. email ${e2.id} held ${hold}s…`);
  const deadline = Date.now() + (hold + 10) * 1000;
  let status = 'held';
  while (Date.now() < deadline) {
    status = (await pool.query<{ status: string }>('SELECT status FROM rollikey_airlock_queue WHERE id = $1', [e2.id])).rows[0]!.status;
    if (status === 'released' || status === 'failed') break;
    await sleep(500);
  }
  await worker.stop();
  assert.equal(status, 'released');
  const res = await fetch(`http://${sp.config.smtp.host}:8025/api/v1/search?query=${encodeURIComponent(`subject:"${runB}"`)}`);
  const found = ((await res.json()) as { messages_count: number }).messages_count;
  console.log(`   ✓ released; Mailpit has ${found} matching message(s)`);
  assert.ok(found >= 1);

  // 9. Stripe (only when a test key is configured).
  if (sp.infra.stripe) await stripeDemo(`${runId}_stripe`);
  else console.log('9. Stripe demo skipped (STRIPE_SECRET_KEY not set)');

  console.log('\nAll demo assertions passed.');
}

async function stripeDemo(runId: string) {
  const stripe = sp.infra.stripe!;
  const customer = await stripe.customers.create({ name: 'Rollikey Demo', description: runId });
  const pi = await stripe.paymentIntents.create({
    amount: 250_000,
    currency: 'usd',
    customer: customer.id,
    payment_method: 'pm_card_visa',
    setup_future_usage: 'off_session',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  const big = await sp.refund({ runId, paymentIntentId: pi.id });
  console.log(`9. full $2,500 refund → ${big.status}`);
  assert.equal(big.status, 'blocked');
  const small = await sp.refund({ runId, paymentIntentId: pi.id, amountCents: 5_000 });
  console.log(`   $50 refund → ${small.status}`);
  assert.equal(small.status, 'applied');
  const report = await sp.revert(runId);
  console.log(`   revert → ${JSON.stringify(report.steps.map((s) => s.compensation ?? s.error))}`);
  assert.ok(report.complete);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sp.close());
