import { setTimeout as sleep } from 'node:timers/promises';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Rollikey } from '../engine/index.js';

export interface FiveToolOptions {
  /** Pause between steps (ms) so the dashboard can show each one landing. */
  paceMs?: number;
  /** Pause between the step-6 crash and revert() (ms). */
  pauseBeforeRevertMs?: number;
  log?: (level: 'info' | 'ok' | 'warn' | 'error', msg: string) => void;
  onRun?: (runId: string) => void;
  onCrash?: () => void;
  onReverting?: () => void;
}

export interface FiveToolResult {
  runId: string;
  passed: boolean;
  checks: { label: string; ok: boolean }[];
}

const CUSTOMER_ID = 42;
const ISSUE = 7;

/**
 * 5-Tool Chaos Drill: mutates Postgres, Stripe, S3, GitHub and Slack+Email (airlocked) through
 * Rollikey, crashes on step 6, then reverts everything LIFO and proves every system is back.
 * Runs entirely on local sandboxes (MinIO, offline GitHub, Slack sink) plus Stripe TEST mode.
 */
export async function runFiveToolDrill(sp: Rollikey, opts: FiveToolOptions = {}): Promise<FiveToolResult> {
  const log = opts.log ?? ((l, m) => console.log(`[${l}] ${m}`));
  const pace = () => sleep(opts.paceMs ?? 0);
  const stripe = sp.infra.stripe;
  if (!stripe) throw new Error('STRIPE_SECRET_KEY (test key) is required for the drill');
  if (sp.github.live) throw new Error('Refusing to run the chaos drill against live GitHub; unset GITHUB_TOKEN');
  if (sp.slack.backend !== 'sink') throw new Error('Refusing to run the chaos drill against live Slack; unset SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL');
  await sp.init();

  const runId = `drill5_${Date.now()}`;
  opts.onRun?.(runId);
  const s3 = sp.infra.s3;
  const bucket = sp.config.s3.defaultBucket;
  const repo = sp.config.github.defaultRepo;
  const cfgKey = `chaos/${runId}/config.json`;
  const sumKey = `chaos/${runId}/summary.txt`;
  const branch = `feature/chaos-${Date.now()}`;
  const branchSha = 'c'.repeat(40);
  const pool = sp.infra.pool;
  const row = async () => (await pool.query('SELECT to_jsonb(c) AS r FROM customers c WHERE id = $1', [CUSTOMER_ID])).rows[0]?.r ?? null;
  const objExists = (k: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: k })).then(() => true, () => false);

  log('info', `5-tool drill, run ${runId}. Creating fixtures (Stripe test charge, S3 object, GitHub branch)…`);
  const sc = await stripe.customers.create({ name: 'Chaos Drill Customer', description: runId });
  const pi = await stripe.paymentIntents.create({
    amount: 100_000, currency: 'usd', customer: sc.id, payment_method: 'pm_card_visa', setup_future_usage: 'off_session',
    confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  const cfgBody = JSON.stringify({ feature_flags: { checkout_v2: false }, rev: 1 });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: cfgKey, Body: cfgBody, ContentType: 'application/json', Metadata: { owner: 'platform', rev: '1' } }));
  await sp.github.createBranch(repo, branch, branchSha);
  const pgBefore = await row();
  if (!pgBefore) throw new Error(`customer ${CUSTOMER_ID} not found; run npm run db:seed`);
  const cfgHeadBefore = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cfgKey }));
  const ghBefore = await sp.github.readItem(repo, ISSUE, 'issue');
  log('ok', `Fixtures ready: ${pi.id}, s3://${bucket}/${cfgKey}, ${repo}#${ISSUE}, branch ${branch}`);
  await pace();

  const step = (n: number, what: string) => log('info', `Step ${n}/6 → ${what}`);
  const res = (r: { status: string; seq?: number }) => log(r.status === 'blocked' ? 'warn' : 'ok', `  ← ${r.status}${r.seq ? ` (seq ${r.seq})` : ''}`);

  step(1, 'PostgreSQL: update customers#42 (plan=enterprise, status=suspended)');
  res(await sp.updateRows({ runId, table: 'customers', where: { id: CUSTOMER_ID }, set: { plan: 'enterprise', status: 'suspended', name: 'Chaos Agent Was Here' } }));
  await pace();

  step(2, 'Stripe: refund $500.00');
  res(await sp.refund({ runId, paymentIntentId: pi.id, amountCents: 50_000, reason: 'requested_by_customer' }));
  await pace();

  step(3, 'AWS S3: overwrite config.json (vaulted) + create summary.txt');
  res(await sp.putObject({ runId, key: cfgKey, body: JSON.stringify({ feature_flags: { checkout_v2: true }, rev: 2 }), contentType: 'text/plain', metadata: { owner: 'chaos-agent', rev: '2' } }));
  res(await sp.putObject({ runId, key: sumKey, body: 'chaos run summary' }));
  await pace();

  step(4, `GitHub: close ${repo}#${ISSUE} and delete branch ${branch}`);
  res(await sp.updateIssues({ runId, numbers: [ISSUE], patch: { title: 'CHAOS: closed by agent', state: 'closed', labels: ['chaos'] } }));
  res(await sp.deleteBranches({ runId, branches: [branch] }));
  await pace();

  step(5, 'Slack + Email: @channel announcement and customer email (both enter the 60s airlock)');
  const slack = await sp.slackPost({ runId, channel: 'general', text: '<!channel> Refund issued and plan upgraded for customer 42.' });
  res(slack);
  const email = await sp.sendEmail({ runId, to: `customer${CUSTOMER_ID}@example.test`, subject: `[${runId}] Your refund and plan update are confirmed`, text: 'Refund of $500.00 confirmed.' });
  log('ok', `  ← held (email ${email.id})`);
  await sleep((opts.paceMs ?? 0) * 1.5);

  step(6, 'sync_to_crm');
  log('error', '✖ CHAOS: CRM sync agent crashed at step 6 (injected failure)');
  opts.onCrash?.();
  const pgMid = await row();
  await sleep(opts.pauseBeforeRevertMs ?? 0);

  opts.onReverting?.();
  log('warn', 'Running Rollikey revert(runId): cancel airlocks, then LIFO compensation across all 5 systems…');
  const rep = await sp.revert(runId);
  for (const s of rep.steps) log(s.status === 'reverted' ? 'ok' : 'error', `  revert seq ${s.seq} ${s.actionType} → ${s.status}${s.error ? ` (${s.error})` : ''}`);
  log('ok', `  email airlock cancelled ${rep.emails.cancelled.length}, Slack airlock cancelled ${rep.slack.cancelled.length}`);

  // ---- verification ------------------------------------------------------------------------------
  const leaked = await sp.slack.releaseDue() + await sp.airlock.releaseDue();
  const cfgNow = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cfgKey }));
  const cfgHeadNow = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cfgKey }));
  const cfgText = await cfgNow.Body!.transformToString();
  const ghNow = await sp.github.readItem(repo, ISSUE, 'issue');
  const brNow = await sp.github.readBranch(repo, branch);
  const stripeStep = rep.steps.find((s) => s.actionType === 'stripe.refund');
  const recharge = (stripeStep?.compensation as { paymentIntentId?: string; type?: string } | undefined);
  const rechargePi = recharge?.paymentIntentId ? await stripe.paymentIntents.retrieve(recharge.paymentIntentId) : null;
  const sinkLive = (await pool.query('SELECT count(*)::int AS n FROM rollikey_slack_sink WHERE run_id = $1 AND NOT deleted', [runId])).rows[0].n;
  const slackQ = await sp.slack.listRun(runId);
  const mailQ = await sp.airlock.listRun(runId);

  const checks: { label: string; ok: boolean }[] = [
    { label: 'agent crashed mid-run (state was dirty at crash)', ok: JSON.stringify(pgMid) !== JSON.stringify(pgBefore) },
    { label: 'revert complete, strict LIFO (seq strictly descending)', ok: rep.complete && rep.steps.every((s, i) => i === 0 || rep.steps[i - 1]!.seq > s.seq) && rep.steps.length === 7 },
    { label: 'PostgreSQL row identical to Before State', ok: JSON.stringify(await row()) === JSON.stringify(pgBefore) },
    { label: 'Stripe refund compensated (re-charge $500 succeeded)', ok: rechargePi?.status === 'succeeded' && rechargePi.amount === 50_000 },
    { label: 'S3 config.json bytes + metadata restored exactly', ok: cfgText === cfgBody && cfgHeadNow.ETag === cfgHeadBefore.ETag && cfgHeadNow.ContentType === 'application/json' && cfgHeadNow.Metadata?.owner === 'platform' && cfgHeadNow.Metadata?.rev === '1' },
    { label: 'S3 newly created summary.txt removed', ok: !(await objExists(sumKey)) },
    { label: 'GitHub issue restored (title, state, labels)', ok: JSON.stringify(ghNow) === JSON.stringify(ghBefore) },
    { label: 'GitHub branch recreated at its saved commit SHA', ok: brNow?.sha === branchSha },
    { label: 'Slack @channel post cancelled in airlock, 0 messages in sink', ok: slackQ.length === 1 && slackQ.every((q) => q.status === 'cancelled') && sinkLive === 0 },
    { label: 'Email cancelled in airlock', ok: mailQ.length === 1 && mailQ.every((q) => q.status === 'cancelled') },
    { label: 'Nothing leaked after revert (worker pass released 0)', ok: leaked === 0 },
  ];
  for (const c of checks) log(c.ok ? 'ok' : 'error', `${c.ok ? '✓ PASS' : '✗ FAIL'}  ${c.label}`);
  const passed = checks.every((c) => c.ok);
  log(passed ? 'ok' : 'error', passed ? '5-TOOL CHAOS DRILL PASSED: crash fully contained across Postgres, Stripe, S3, GitHub and Slack+Email.' : '5-TOOL CHAOS DRILL FAILED.');
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cfgKey })).catch(() => {});
  await sp.github.rawDeleteBranch(repo, branch);
  return { runId, passed, checks };
}
