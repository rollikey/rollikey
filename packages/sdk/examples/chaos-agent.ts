/**
 * Chaos Agent: real Gemini function calling routed through the Rollikey MCP proxy.
 * 4-step workflow (DB update -> $500 Stripe refund -> airlock email -> intentional crash),
 * then Rollikey revert() and a before/after proof report.
 *
 *   npx tsx packages/sdk/examples/chaos-agent.ts
 *
 * Reads LLM_API_KEY / STRIPE_SECRET_KEY / DATABASE_URL from the repo-root .env. Never prints key values.
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import pg from 'pg';
import Stripe from 'stripe';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from .env`);
  return v;
};
const MODEL = 'gemini-4-hydrogen';
const CUSTOMER_ID = 42;
const hold = Number(process.env.ROLLIKEY_AIRLOCK_SECONDS ?? 60);
const mailpit = `http://${process.env.SMTP_HOST ?? 'localhost'}:8025`;

const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
const pool = new pg.Pool({ connectionString: env('DATABASE_URL') });
const ai = new GoogleGenAI({ apiKey: env('LLM_API_KEY') });

const rule = (t: string) => console.log(`\n${'═'.repeat(8)} ${t} ${'═'.repeat(Math.max(2, 64 - t.length))}`);
const customerRow = async () =>
  (await pool.query('SELECT to_jsonb(c) AS row FROM customers c WHERE id = $1', [CUSTOMER_ID])).rows[0]?.row ?? null;
const mailpitCount = async (runId: string) => {
  const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`subject:"${runId}"`)}`);
  return ((await res.json()) as { messages_count: number }).messages_count;
};

// ---------------------------------------------------------------------------
// Fixtures: a $1,000 test charge the agent will partially refund.
// ---------------------------------------------------------------------------
const runId = `chaos_${Date.now()}`;
const sc = await stripe.customers.create({ name: 'Chaos Agent Customer', description: runId });
const pi = await stripe.paymentIntents.create({
  amount: 100_000,
  currency: 'usd',
  customer: sc.id,
  payment_method: 'pm_card_visa',
  setup_future_usage: 'off_session',
  confirm: true,
  automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
});
const chargeId = String(pi.latest_charge);

const beforeRow = await customerRow();
assert.ok(beforeRow, `customer ${CUSTOMER_ID} not found; run npm run db:seed`);
const beforeCharge = await stripe.charges.retrieve(chargeId);

rule('BEFORE STATE');
console.log(`run id            : ${runId}`);
console.log(`postgres row #${CUSTOMER_ID}  : ${JSON.stringify(beforeRow)}`);
console.log(`stripe charge     : ${chargeId} amount=$${beforeCharge.amount / 100} refunded=$${beforeCharge.amount_refunded / 100}`);
console.log(`mailpit msgs      : ${await mailpitCount(runId)} matching "${runId}"`);

// ---------------------------------------------------------------------------
// Rollikey MCP proxy (stdio) -> Gemini function declarations
// ---------------------------------------------------------------------------
const serverEntry = fileURLToPath(new URL('../../server/src/mcp/stdio.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const mcp = new Client({ name: 'chaos-agent', version: '0.1.0' });
await mcp.connect(
  new StdioClientTransport({ command: tsx, args: [serverEntry], env: { ...(process.env as Record<string, string>) } }),
);

// The agent may act (update / refund / email). revert + inspect are reserved for the harness.
const AGENT_TOOLS = ['rollikey_db_update', 'rollikey_stripe_refund', 'rollikey_send_email'];
const { tools } = await mcp.listTools();
const declarations: FunctionDeclaration[] = tools
  .filter((t) => AGENT_TOOLS.includes(t.name))
  .map((t) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema));
    delete schema.$schema;
    delete schema.properties?.runId; // harness injects the run id
    schema.required = (schema.required ?? []).filter((k: string) => k !== 'runId');
    return { name: t.name, description: t.description, parametersJsonSchema: schema };
  });
// A local tool that always crashes: the intentional step-4 failure.
declarations.push({
  name: 'sync_to_crm',
  description: 'Final step: push the finished customer case to the external CRM. Required to close the case.',
  parametersJsonSchema: { type: 'object', properties: { customerId: { type: 'integer' } }, required: ['customerId'] },
});

let crashed: Error | null = null;
const toolLog: string[] = [];
async function dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'sync_to_crm') {
    crashed = new Error('CHAOS: CRM sync agent crashed at step 4 (injected failure)');
    throw crashed;
  }
  const result = await mcp.callTool({ name, arguments: { ...args, runId } });
  const out = (result.structuredContent ?? { text: result.content }) as Record<string, unknown>;
  toolLog.push(`${name} → ${out.status ?? (result.isError ? 'error' : 'ok')}`);
  return out;
}

const prompt = `You are a support-operations agent. Complete this 4-step workflow IN ORDER, one tool call at a time:
1. Update customers row id=${CUSTOMER_ID} in Postgres: table "customers", where {"id": ${CUSTOMER_ID}}, set {"plan": "enterprise", "status": "suspended", "name": "Chaos Agent Was Here"}.
2. Issue a $500 refund (amountCents 50000) for Stripe payment intent ${pi.id}, reason "requested_by_customer".
3. Send the customer a confirmation email: to "customer${CUSTOMER_ID}@example.test", subject "[${runId}] Your refund and plan update are confirmed", with a short plain-text body.
4. Call sync_to_crm for customer ${CUSTOMER_ID} to close the case.
Do not skip steps and do not ask questions.`;

rule(`AGENT RUN (${MODEL}, function calling via Rollikey MCP)`);
const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];
try {
  for (let turn = 0; turn < 12; turn++) {
    let res!: Awaited<ReturnType<typeof ai.models.generateContent>>;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await ai.models.generateContent({ model: MODEL, contents, config: { tools: [{ functionDeclarations: declarations }] } });
        break;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (attempt >= 6 || (status !== 503 && status !== 429)) throw e;
        console.log(`  (gemini ${status}, retry ${attempt}/5 in ${attempt * 5}s)`);
        await sleep(attempt * 5000);
      }
    }
    const modelContent = res.candidates?.[0]?.content;
    if (!modelContent) throw new Error(`Model returned no content (finishReason=${res.candidates?.[0]?.finishReason})`);
    contents.push(modelContent);
    const calls = (modelContent.parts ?? []).filter((p) => p.functionCall);
    if (calls.length === 0) {
      console.log(`model: ${res.text ?? '(no text)'}`);
      break;
    }
    const responses: Part[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      console.log(`→ model called ${fc.name}(${JSON.stringify(fc.args)})`);
      const out = await dispatch(fc.name!, (fc.args ?? {}) as Record<string, unknown>);
      console.log(`  ← ${toolLog.at(-1)}`);
      responses.push({ functionResponse: { name: fc.name!, response: out } });
    }
    contents.push({ role: 'user', parts: responses });
  }
} catch (err) {
  if (!crashed) throw err; // only the injected crash is expected
  console.log(`✖ ${crashed.message}`);
}

// ---------------------------------------------------------------------------
// Crash recovery: Rollikey revert (LIFO)
// ---------------------------------------------------------------------------
const midRow = await customerRow();
const midCharge = await stripe.charges.retrieve(chargeId);
const runInfo = (await mcp.callTool({ name: 'rollikey_get_run', arguments: { runId } })).structuredContent as {
  emails: { id: string; status: string }[];
};
rule('STATE AT CRASH (before revert)');
console.log(`postgres row #${CUSTOMER_ID}  : ${JSON.stringify(midRow)}`);
console.log(`stripe charge     : refunded=$${midCharge.amount_refunded / 100}`);
console.log(`airlock emails    : ${runInfo.emails.map((e) => `${e.id}=${e.status}`).join(', ') || 'none'}`);

// Optional (dashboard demo): hold the crashed state on screen before rolling back.
const pauseMs = Number(process.env.CHAOS_PAUSE_MS ?? 0);
if (pauseMs > 0) {
  console.log(`pausing ${pauseMs / 1000}s so the airlock hold and crash are visible before revert…`);
  await sleep(pauseMs);
}

rule('ROLLIKEY REVERT');
const revert = (await mcp.callTool({ name: 'rollikey_revert', arguments: { runId } })).structuredContent as {
  complete: boolean;
  emails: { cancelled: string[]; alreadySent: string[] };
  steps: { seq: number; actionType: string; status: string; compensation?: Record<string, any>; error?: string }[];
};
for (const s of revert.steps) console.log(`seq ${s.seq} ${s.actionType} → ${s.status} ${JSON.stringify(s.compensation ?? s.error)}`);
console.log(`emails cancelled: ${JSON.stringify(revert.emails.cancelled)}  already sent: ${JSON.stringify(revert.emails.alreadySent)}`);

// Wait past the airlock window so a leaked email would have reached Mailpit.
console.log(`waiting ${hold + 8}s (airlock window + margin) to prove nothing leaks to Mailpit…`);
await sleep((hold + 8) * 1000);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const afterRow = await customerRow();
const afterCharge = await stripe.charges.retrieve(chargeId);
const queue = (await pool.query('SELECT id, status FROM rollikey_airlock_queue WHERE run_id = $1', [runId])).rows;
const mails = await mailpitCount(runId);
const comp = revert.steps.find((s) => s.actionType === 'stripe.refund')?.compensation;
const recharge = comp?.paymentIntentId ? await stripe.paymentIntents.retrieve(comp.paymentIntentId) : null;

const checks: [string, boolean][] = [
  ['agent crashed at step 4', crashed !== null],
  ['tool calls reached steps 1-3 via proxy', toolLog.length === 3 && toolLog.every((l) => /applied|held/.test(l))],
  ['revert complete, LIFO (refund → db update)', revert.complete && revert.steps.map((s) => s.actionType).join() === 'stripe.refund,pg.update'],
  ['staged email cancelled in airlock', revert.emails.cancelled.length === 1 && queue.every((q) => q.status === 'cancelled')],
  [`Mailpit has 0 messages for ${runId} after ${hold + 8}s`, mails === 0],
  ['Stripe refund compensated (re-charge $500 succeeded)', recharge?.status === 'succeeded' && recharge.amount === 50_000],
  ['PostgreSQL row identical to Before State snapshot', JSON.stringify(afterRow) === JSON.stringify(beforeRow)],
];

rule('BEFORE / AFTER REPORT');
const pad = (s: string, n = 28) => s.padEnd(n);
console.log(`${pad('')}${pad('BEFORE', 56)}AFTER REVERT`);
console.log(`${pad(`pg customers #${CUSTOMER_ID}`)}${pad(JSON.stringify(beforeRow).slice(0, 54), 56)}${JSON.stringify(afterRow).slice(0, 54)}`);
console.log(`${pad('  (at crash)')}${JSON.stringify(midRow)}`);
console.log(`${pad('stripe refunded')}${pad(`$${beforeCharge.amount_refunded / 100}`, 56)}$${afterCharge.amount_refunded / 100} refunded + compensating charge ${recharge?.id ?? 'n/a'} $${(recharge?.amount ?? 0) / 100} (${recharge?.status})`);
console.log(`${pad('airlock email')}${pad('(none)', 56)}${queue.map((q) => `${q.id} ${q.status}`).join(', ')}`);
console.log(`${pad('mailpit messages')}${pad('0', 56)}${mails}`);
console.log('');
for (const [label, ok] of checks) console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${label}`);
const allOk = checks.every(([, ok]) => ok);
console.log(allOk ? '\nCHAOS DRILL PASSED: crash fully contained.' : '\nCHAOS DRILL FAILED.');

await mcp.close();
await pool.end();
process.exitCode = allOk ? 0 : 1;
