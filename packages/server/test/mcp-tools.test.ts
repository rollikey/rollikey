/**
 * MCP surface tests: a real MCP Client talks to createMcpServer() over an in-memory transport,
 * against the local Docker stack (Postgres, Redis, MinIO), the offline GitHub sandbox, the Slack sink
 * and an in-memory FakeStripe. Every one of the 16 tools is called by its literal name.
 *   docker compose up -d && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { config as baseConfig } from '../src/config.js';
import { FakeStripe } from '../src/demo/fake-stripe.js';
import { createRollikey, type Rollikey } from '../src/engine/index.js';
import { createInfra } from '../src/infra.js';
import { createMcpServer } from '../src/mcp/server.js';
import { migrate } from '../src/scripts/migrate.js';

const rid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const infra = createInfra();
const fake = new FakeStripe();
let sp: Rollikey;
let client: Client;

type Out = Record<string, any> & { status?: string };
async function call(name: string, args: Record<string, unknown>): Promise<{ sc: Out; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(res.structuredContent, `${name} returned structuredContent`);
  return { sc: res.structuredContent as Out, isError: Boolean(res.isError) };
}

before(async () => {
  await migrate(infra.pool);
  sp = createRollikey({
    infra: { ...infra, stripe: fake.asStripe(), close: async () => {} },
    config: { ...baseConfig, stripeConnect: { feeBps: 0, account: '' } },
    log: () => {},
  });
  await sp.init();
  assert.equal(sp.github.live, false, 'tests must use the offline GitHub sandbox');
  assert.equal(sp.slack.backend, 'sink', 'tests must use the local Slack sink');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(sp).connect(serverSide);
  client = new Client({ name: 'mcp-tools-test', version: '0.1.2' });
  await client.connect(clientSide);
});
after(async () => {
  await client?.close();
  await infra.close();
});

const EXPECTED = [
  'rollikey_db_update', 'rollikey_db_delete', 'rollikey_stripe_refund', 'rollikey_stripe_authorize_hold',
  'rollikey_stripe_capture_holds', 'rollikey_send_email', 'rollikey_s3_put_object', 'rollikey_s3_delete_objects',
  'rollikey_s3_set_bucket_acl', 'rollikey_github_update_issues', 'rollikey_github_update_pulls',
  'rollikey_github_delete_branches', 'rollikey_slack_post', 'rollikey_slack_archive_channel', 'rollikey_revert',
  'rollikey_get_run',
];

describe('tool annotations', () => {
  it('lists all 16 tools with four explicit boolean hints each', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
    for (const t of tools) {
      const a = t.annotations as Record<string, unknown> | undefined;
      assert.ok(a, `${t.name} has annotations`);
      for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof a[k], 'boolean', `${t.name}.${k} must be an explicit boolean`);
      }
    }
  });

  it('only rollikey_get_run is read-only; local-only tools are closed-world', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations as Record<string, boolean>]));
    assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name), ['rollikey_get_run']);
    assert.deepEqual(by['rollikey_get_run'], { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const n of ['rollikey_db_update', 'rollikey_db_delete', 'rollikey_slack_archive_channel', 'rollikey_get_run']) {
      assert.equal(by[n]!.openWorldHint, false, n);
    }
    for (const n of EXPECTED.filter((n) => !['rollikey_db_update', 'rollikey_db_delete', 'rollikey_slack_archive_channel', 'rollikey_get_run'].includes(n))) {
      assert.equal(by[n]!.openWorldHint, true, n);
    }
  });
});

describe('tool calls', () => {
  it('rollikey_db_update + rollikey_get_run + rollikey_revert', async () => {
    const runId = rid('mcp_dbu');
    const email = `${runId}@example.test`;
    const ins = await infra.pool.query(`INSERT INTO customers (name, email, plan, status) VALUES ('MCP Test', $1, 'free', 'active') RETURNING id`, [email]);
    const id = Number(ins.rows[0].id);
    try {
      const u = await call('rollikey_db_update', { runId, table: 'customers', where: { id }, set: { status: 'suspended' } });
      assert.equal(u.sc.status, 'applied');
      assert.equal(u.sc.rowsAffected, 1);
      const run = await call('rollikey_get_run', { runId });
      assert.equal(run.isError, false);
      assert.ok(JSON.stringify(run.sc).includes(runId));
      const rev = await call('rollikey_revert', { runId });
      assert.equal(rev.sc.status, 'reverted');
      const row = await infra.pool.query('SELECT status FROM customers WHERE id = $1', [id]);
      assert.equal(row.rows[0].status, 'active');
    } finally {
      await infra.pool.query('DELETE FROM customers WHERE id = $1', [id]);
    }
  });

  it('rollikey_db_delete is snapshotted and restored by revert', async () => {
    const runId = rid('mcp_dbd');
    const email = `${runId}@example.test`;
    const ins = await infra.pool.query(`INSERT INTO customers (name, email, plan, status) VALUES ('MCP Del', $1, 'free', 'active') RETURNING id`, [email]);
    const id = Number(ins.rows[0].id);
    try {
      const d = await call('rollikey_db_delete', { runId, table: 'customers', where: { id } });
      assert.equal(d.sc.status, 'applied');
      assert.equal((await infra.pool.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount, 0);
      const rev = await call('rollikey_revert', { runId });
      assert.equal(rev.sc.status, 'reverted');
      assert.equal((await infra.pool.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount, 1);
    } finally {
      await infra.pool.query('DELETE FROM customers WHERE id = $1', [id]);
    }
  });

  it('rollikey_stripe_refund refunds and is compensated on revert', async () => {
    const runId = rid('mcp_ref');
    const pay = fake.seedPayment(5_000);
    const r = await call('rollikey_stripe_refund', { runId, paymentIntentId: pay.pi.id });
    assert.equal(r.sc.status, 'applied');
    assert.equal(r.sc.amountCents, 5_000);
    assert.ok(String(r.sc.refundId).startsWith('re_'));
    assert.equal((await call('rollikey_revert', { runId })).sc.status, 'reverted');
  });

  it('rollikey_stripe_authorize_hold + rollikey_stripe_capture_holds', async () => {
    const runId = rid('mcp_hold');
    const pay = fake.seedPayment(50_000);
    const h = await call('rollikey_stripe_authorize_hold', { runId, amountCents: 2_500, customerId: pay.pi.customer, paymentMethodId: pay.pi.payment_method });
    assert.equal(h.sc.status, 'applied');
    assert.equal(h.sc.holdStatus, 'requires_capture');
    const c = await call('rollikey_stripe_capture_holds', { runId });
    assert.equal(c.sc.captured.length, 1);
    assert.equal(c.sc.captured[0].paymentIntentId, h.sc.paymentIntentId);
    const again = await call('rollikey_stripe_capture_holds', { runId });
    assert.equal(again.sc.captured.length, 0, 'capture is idempotent');
    assert.equal((await call('rollikey_revert', { runId })).sc.status, 'reverted');
  });

  it('rollikey_send_email is queued in the airlock and cancelled by revert', async () => {
    const runId = rid('mcp_mail');
    const e = await call('rollikey_send_email', { runId, to: 'x@example.test', subject: `[${runId}] hi`, text: 'hi' });
    assert.equal(e.sc.status, 'held');
    const rev = await call('rollikey_revert', { runId });
    assert.equal(rev.sc.status, 'reverted');
    assert.equal(rev.sc.emails.cancelled.length, 1);
  });

  it('rollikey_s3_put_object + rollikey_s3_delete_objects + rollikey_s3_set_bucket_acl', async () => {
    const runId = rid('mcp_s3');
    const key = `t/${runId}/a.txt`;
    const put = await call('rollikey_s3_put_object', { runId, key, body: 'hello' });
    assert.equal(put.sc.status, 'applied');
    const del = await call('rollikey_s3_delete_objects', { runId, keys: [key] });
    assert.equal(del.sc.status, 'applied');
    const acl = await call('rollikey_s3_set_bucket_acl', { runId, acl: 'public-read' });
    assert.equal(acl.sc.status, 'blocked');
    assert.equal(acl.isError, true);
    assert.equal((await call('rollikey_revert', { runId })).sc.status, 'reverted');
  });

  it('rollikey_github_update_issues + rollikey_github_update_pulls', async () => {
    const runId = rid('mcp_gh');
    const i = await call('rollikey_github_update_issues', { runId, numbers: [5], patch: { state: 'closed' } });
    assert.equal(i.sc.status, 'applied');
    const before = await sp.github.readItem(sp.config.github.defaultRepo, 5, 'issue');
    assert.equal(before.state, 'closed');
    const pr = await call('rollikey_github_update_pulls', { runId, numbers: [13], patch: { title: `MCP ${runId}` } });
    assert.equal(pr.sc.status, 'applied');
    assert.equal((await call('rollikey_revert', { runId })).sc.status, 'reverted');
    const restored = await sp.github.readItem(sp.config.github.defaultRepo, 5, 'issue');
    assert.notEqual(restored.state, 'closed');
  });

  it('rollikey_github_delete_branches blocks protected branches', async () => {
    const runId = rid('mcp_br');
    const r = await call('rollikey_github_delete_branches', { runId, branches: ['main'] });
    assert.equal(r.sc.status, 'blocked');
    assert.equal(r.isError, true);
  });

  it('rollikey_slack_post applies a normal message and revert deletes it', async () => {
    const runId = rid('mcp_slack');
    const p = await call('rollikey_slack_post', { runId, channel: 'eng', text: 'normal message' });
    assert.equal(p.sc.status, 'applied');
    assert.equal((await call('rollikey_revert', { runId })).sc.status, 'reverted');
  });

  it('rollikey_slack_archive_channel is always blocked', async () => {
    const r = await call('rollikey_slack_archive_channel', { runId: rid('mcp_arch'), channel: 'general' });
    assert.equal(r.sc.status, 'blocked');
    assert.equal(r.isError, true);
  });
});
