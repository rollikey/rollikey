/**
 * Provider tool-call adapters, offline: shows what you hand to Anthropic / OpenAI / Gemini and
 * proves the run-scoped dispatcher works end to end (including the gate and revert).
 *   npx tsx packages/sdk/examples/tool-calls.ts
 */
import { fileURLToPath } from 'node:url';
import { RollikeyClient, anthropicTools, geminiTools, openAITools } from '../src/index.js';

const serverEntry = fileURLToPath(new URL('../../server/src/mcp/stdio.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

const sp = await RollikeyClient.connectStdio({
  command: tsx,
  args: [serverEntry],
  env: { ...(process.env as Record<string, string>), ROLLIKEY_RUN_AIRLOCK_WORKER: 'false' },
});
try {
  const tools = await sp.tools();
  console.log(`${tools.length} tools · anthropic ${anthropicTools(tools).length} · openai ${openAITools(tools).length} · gemini ${geminiTools(tools)[0]!.functionDeclarations.length}`);
  const run = sp.run();
  // This is exactly what your tool-call loop does with a model's function call:
  const blocked = await run.call('rollikey_db_delete', { table: 'customers', where: { status: 'active' } });
  console.log('bulk delete →', blocked.status, '·', blocked.reason);
  const ok = await run.call('rollikey_db_update', { table: 'customers', where: { id: 10 }, set: { plan: 'pro' } });
  console.log('single update →', ok.status);
  const report = await run.revert();
  console.log('revert →', report.status);
} finally {
  await sp.close();
}
