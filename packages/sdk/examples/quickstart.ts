/**
 * Spawns the Rollikey MCP server over stdio and drives it through the SDK.
 *   npx tsx packages/sdk/examples/quickstart.ts
 */
import { fileURLToPath } from 'node:url';
import { RollikeyBlockedError, RollikeyClient } from '../src/index.js';

const serverEntry = fileURLToPath(new URL('../../server/src/mcp/stdio.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

const sp = await RollikeyClient.connectStdio({
  command: tsx,
  args: [serverEntry],
  env: { ...(process.env as Record<string, string>), ROLLIKEY_RUN_AIRLOCK_WORKER: 'false' },
});

try {
  const run = sp.run();
  console.log('run', run.runId);

  const upd = await run.updateRows('customers', { id: { op: 'in', value: [10, 11] } }, { plan: 'enterprise' });
  console.log('update →', upd.status, 'rows', upd.status === 'applied' ? upd.rowsAffected : 0);

  try {
    await run.deleteRows('customers', { status: 'active' });
  } catch (err) {
    if (err instanceof RollikeyBlockedError) console.log('bulk delete → blocked:', err.message);
    else throw err;
  }

  const mail = await run.sendEmail({ to: 'linus@example.test', subject: 'Plan upgraded', text: 'Enjoy enterprise!' });
  console.log('email →', mail.status, 'until', mail.releaseAt);

  const report = await run.revert();
  console.log('revert →', report.status, 'steps', report.steps.map((s) => `${s.seq}:${s.status}`), 'emails cancelled', report.emails.cancelled.length);

  const info = await run.inspect();
  console.log('ledger →', info.snapshots.map((s) => `${s.seq}:${s.action_type}:${s.status}`).join(', '));
} finally {
  await sp.close();
}
