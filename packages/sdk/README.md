# @rollikey/sdk

Typed client for [Rollikey](../../README.md): put a blast-radius gate, pre-flight snapshots, a 60-second airlock and
a one-call `revert(runId)` between any AI agent and your database, Stripe, S3, GitHub and Slack/Email.

MIT licensed. The server (`packages/server`) is FSL-1.1-MIT.

## Install

```bash
npm install @rollikey/sdk
npx -y @rollikey/mcp   # the MCP proxy the client talks to
```

## Start the local stack

Source: https://github.com/rollikey/rollikey

```bash
docker compose up -d          # postgres, redis, mailpit, minio
npm install
npm run db:seed               # migrations + 5,000 demo customers
npm run dashboard             # http://localhost:3000  (side-by-side demo: http://localhost:3000/demo)
```

Everything runs on local sandboxes at $0. Stripe is optional (`STRIPE_SECRET_KEY=sk_test_...`, test keys only).

## The 3-line quickstart

```ts
import { RollikeyClient } from '@rollikey/sdk';
const sp  = await RollikeyClient.connectStdio({ command: 'npx', args: ['-y', '@rollikey/mcp'] });
const run = sp.run();                       // 1. one run = one undo unit
try { await myAgent(run); } catch { await run.revert(); }   // 2-3. unchanged agent; crash → LIFO undo
```

`run.revert()` cancels held emails/Slack posts, then undoes every applied action in reverse order.
Bulk spikes are blocked before they execute (more than 10 rows/objects, more than $1,000 per call).

### MCP (Claude Desktop, Cursor, any MCP client)

```json
{ "mcpServers": { "rollikey": { "command": "npx", "args": ["-y", "@rollikey/mcp"], "env": { "DATABASE_URL": "postgres://…", "REDIS_URL": "redis://…" } } } }
```

Tools: `rollikey_db_update`, `rollikey_db_delete`, `rollikey_stripe_refund`, `rollikey_stripe_authorize_hold`,
`rollikey_stripe_capture_holds`, `rollikey_send_email`, `rollikey_s3_*`, `rollikey_github_*`, `rollikey_slack_*`,
`rollikey_revert`, `rollikey_get_run`. Pass the same `runId` on every call of one agent session.

### Anthropic tool calls

```ts
const run = sp.run(), tools = anthropicTools(await sp.tools());           // 1 + 2
const msg = await anthropic.messages.create({ model, max_tokens: 1024, tools, messages });
for (const b of msg.content) if (b.type === 'tool_use') result = await run.call(b.name, b.input as any); // 3
```

### OpenAI tool calls

```ts
const run = sp.run(), tools = openAITools(await sp.tools());              // 1 + 2
const res = await openai.chat.completions.create({ model, tools, messages });
for (const c of res.choices[0].message.tool_calls ?? []) result = await run.call(c.function.name, JSON.parse(c.function.arguments)); // 3
```

### Gemini tool calls

```ts
const run = sp.run(), tools = geminiTools(await sp.tools());              // 1 + 2
const res = await ai.models.generateContent({ model, contents, config: { tools } });
for (const fc of res.functionCalls ?? []) result = await run.call(fc.name!, fc.args ?? {});  // 3
```

### LangGraph

```ts
const run = sp.run();                                                      // 1
const tools = (await sp.tools()).map((t) => tool(async (a) => JSON.stringify(await run.call(t.name, a)), { name: t.name, description: t.description, schema: t.inputSchema })); // 2
const agent = createReactAgent({ llm, tools });  /* …invoke…, then on error: */ await run.revert(); // 3
```

`run.call()` returns gate blocks as normal tool results (`{ status: "blocked", reason }`) so the model can adapt.
Use the typed helpers (`run.postgres.update`, `run.s3.delete`, `run.stripe.authorizeHold`, …) when you write the calls yourself.

## Non-custodial Stripe auth-hold

```ts
const hold = await run.stripe.authorizeHold({ amountCents: 24_900, customerId, paymentMethodId }); // capture_method: 'manual', nothing charged
await run.stripe.captureHolds();   // only after the multi-step run verified cleanly
// …or run.revert() → paymentIntents.cancel(), the customer is never charged.
```

Rollikey never holds your money. Set `ROLLIKEY_CONNECT_FEE_BPS` (0, or 25-50) only in hosted Connect mode;
the fee applies to captured holds, never to database, S3, GitHub or Slack/Email rollbacks.

## Examples

```bash
npx tsx packages/sdk/examples/quickstart.ts    # SDK → MCP stdio → engine
npx tsx packages/sdk/examples/tool-calls.ts    # provider adapters + run.call(), offline
```
