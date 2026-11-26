/**
 * Rollikey SDK tour of all 5 connectors over the MCP stdio server (offline sandboxes only).
 *   npx tsx packages/sdk/examples/five-tools.ts
 */
import { fileURLToPath } from 'node:url';
import { RollikeyClient } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sp = await RollikeyClient.connectStdio({
  command: `${root}node_modules/.bin/tsx`,
  args: [`${root}packages/server/src/mcp/stdio.ts`],
  env: process.env as Record<string, string>,
});
const run = sp.run();
try {
  await run.postgres.update('customers', { id: 7 }, { status: 'past_due' });
  await run.s3.put({ key: `sdk/${run.runId}/hello.txt`, body: 'hello from the SDK' });
  await run.github.updateIssues([2], { title: 'Edited through Rollikey' });
  console.log('slack:', (await run.slack.post({ channel: 'general', text: '<!here> SDK demo' })).status);
  console.log('email:', (await run.slack.email({ to: 'x@example.test', subject: `[${run.runId}] hi`, text: 'hi' })).status);
  const r = await run.revert();
  console.log('reverted:', r.status, r.steps.map((s) => `${s.seq}:${s.actionType}`).join(' <- '));
} finally {
  await sp.close();
}
