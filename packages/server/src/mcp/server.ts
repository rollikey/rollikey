import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { emailRequestSchema } from '../engine/airlock.js';
import type { Rollikey } from '../engine/index.js';
import { RUN_ID_PATTERN } from '../engine/ledger.js';
import { deleteRequestSchema, updateRequestSchema } from '../engine/postgres.js';
import { authorizeHoldSchema, captureHoldsSchema, refundRequestSchema } from '../engine/stripe.js';
import { s3AclRequestSchema, s3DeleteRequestSchema, s3PutRequestSchema } from '../engine/s3.js';
import { githubDeleteBranchesSchema, githubUpdateRequestSchema } from '../engine/github.js';
import { slackArchiveSchema, slackPostSchema } from '../engine/slack.js';

const runId = z.string().regex(RUN_ID_PATTERN).describe('Agent run / session id. Every action in a run can be reverted together.');

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function ok(value: unknown, isError = false): ToolResult {
  const structured = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, ...(isError ? { isError } : {}) };
}

async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = (await fn()) as { status?: string };
    // A blocked call is a tool-level failure the agent must see and react to.
    return ok(value, value?.status === 'blocked');
  } catch (err) {
    const e = err as Error & { code?: string };
    return ok({ status: 'error', code: e.code ?? 'internal_error', message: e.message }, true);
  }
}

export function createMcpServer(sp: Rollikey): McpServer {
  const server = new McpServer({ name: 'rollikey', version: '0.1.0' }, { capabilities: { tools: {} } });
  const { maxRows, maxAmountCents } = sp.config.gate;
  const gateNote = `Blocked if it affects more than ${maxRows} rows or moves more than $${maxAmountCents / 100} in one call; the Before State is snapshotted so the run can be reverted.`;

  server.registerTool(
    'rollikey_db_update',
    {
      title: 'Update rows (gated + snapshotted)',
      description: `UPDATE rows in a Postgres table. "where" maps column -> value (equality) or {op, value}; conditions are AND-ed. ${gateNote}`,
      inputSchema: updateRequestSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => guard(() => sp.updateRows(args)),
  );

  server.registerTool(
    'rollikey_db_delete',
    {
      title: 'Delete rows (gated + snapshotted)',
      description: `DELETE rows from a Postgres table. ${gateNote}`,
      inputSchema: deleteRequestSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => guard(() => sp.deleteRows(args)),
  );

  server.registerTool(
    'rollikey_stripe_refund',
    {
      title: 'Refund a Stripe payment (gated + snapshotted)',
      description: `Refund a Stripe payment intent or charge (test mode only). Omit amountCents for a full refund. ${gateNote}`,
      inputSchema: refundRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.refund(args)),
  );

  server.registerTool(
    'rollikey_stripe_authorize_hold',
    {
      title: 'Authorize a Stripe payment hold (manual capture, revertable)',
      description: `Authorize (hold) funds with capture_method "manual": nothing is charged until rollikey_stripe_capture_holds is called after the run verifies cleanly. revert cancels the hold with paymentIntents.cancel. Non-custodial: funds are never held by Rollikey. ${gateNote}`,
      inputSchema: authorizeHoldSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.authorizeHold(args)),
  );

  server.registerTool(
    'rollikey_stripe_capture_holds',
    {
      title: 'Capture the run\'s verified Stripe holds',
      description: 'Capture every still-held authorization of the run. Call it only after the multi-step run finished cleanly. In hosted Connect mode an optional application fee (ROLLIKEY_CONNECT_FEE_BPS) is taken on capture.',
      inputSchema: captureHoldsSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ runId }) => guard(() => sp.captureHolds(runId)),
  );

  server.registerTool(
    'rollikey_send_email',
    {
      title: 'Send email via the staging airlock',
      description: `Queue an outbound email. It is held for ${sp.config.airlock.holdSeconds}s in the airlock before delivery and is cancelled if the run is reverted in that window.`,
      inputSchema: emailRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.sendEmail(args)),
  );


  const bulk = sp.config.gate.maxBulkItems;

  // ---- AWS S3 ----
  server.registerTool(
    'rollikey_s3_put_object',
    {
      title: 'Put an S3 object (vault-snapshotted)',
      description: 'Create or overwrite an S3 object. Any existing bytes + metadata are copied to the recovery vault first; revert restores them exactly (or deletes the object if it is new).',
      inputSchema: s3PutRequestSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.putObject(args)),
  );
  server.registerTool(
    'rollikey_s3_delete_objects',
    {
      title: 'Delete S3 objects (vault-snapshotted, bulk-gated)',
      description: `Delete S3 objects by explicit keys or by prefix. Every object is vaulted first. Blocked if more than ${bulk} objects would be deleted.`,
      inputSchema: s3DeleteRequestSchema.and(z.object({ runId })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.deleteObjects(args)),
  );
  server.registerTool(
    'rollikey_s3_set_bucket_acl',
    {
      title: 'Set an S3 bucket ACL (public-exposure gated)',
      description: 'Set a bucket ACL. Any public ACL (public-read, public-read-write, authenticated-read) is blocked; only "private" is allowed.',
      inputSchema: s3AclRequestSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.setBucketAcl(args)),
  );

  // ---- GitHub ----
  server.registerTool(
    'rollikey_github_update_issues',
    {
      title: 'Edit or close GitHub issues (snapshotted, bulk-gated)',
      description: `Edit title/body/labels/state of issues. Prior state is snapshotted; revert restores it. Blocked if more than ${bulk} issues are touched in one call. Uses the offline sandbox unless GITHUB_TOKEN is set.`,
      inputSchema: githubUpdateRequestSchema.and(z.object({ runId })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.updateIssues(args)),
  );
  server.registerTool(
    'rollikey_github_update_pulls',
    {
      title: 'Edit or close GitHub pull requests (snapshotted, bulk-gated)',
      description: `Edit title/body/state/base of pull requests. Prior state is snapshotted. Blocked if more than ${bulk} PRs are touched in one call.`,
      inputSchema: githubUpdateRequestSchema.and(z.object({ runId })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.updatePulls(args)),
  );
  server.registerTool(
    'rollikey_github_delete_branches',
    {
      title: 'Delete GitHub branches (head-SHA snapshotted, protected-gated)',
      description: `Delete branches. The head commit SHA of each is saved so revert can recreate the ref. Blocked for protected branches (main/master/API-protected) or more than ${bulk} branches.`,
      inputSchema: githubDeleteBranchesSchema.and(z.object({ runId })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.deleteBranches(args)),
  );

  // ---- Slack ----
  server.registerTool(
    'rollikey_slack_post',
    {
      title: 'Post to Slack (airlock for high-blast messages)',
      description: `Post a Slack message. @channel/@here/@everyone, external/shared channels and webhooks are held ${sp.config.airlock.holdSeconds}s in the staging airlock and cancelled if the run is reverted; others post immediately and are deleted on revert. More than ${bulk} messages per run is blocked as a spam spike.`,
      inputSchema: slackPostSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => guard(() => sp.slackPost(args)),
  );
  server.registerTool(
    'rollikey_slack_archive_channel',
    {
      title: 'Archive a Slack channel (always blocked)',
      description: 'Channel archiving is never permitted for agents; the attempt is recorded as blocked.',
      inputSchema: slackArchiveSchema.extend({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => guard(() => sp.slackArchive(args)),
  );

  server.registerTool(
    'rollikey_revert',
    {
      title: 'Revert a run',
      description:
        'Cancel the run\'s held emails and Slack posts, then undo every applied action in strict last-in-first-out order (restore Postgres rows, compensate Stripe refunds, restore S3 objects from the vault, restore GitHub issues/PRs and recreate deleted branches, delete posted Slack messages). Safe to call again; it resumes after a failure.',
      inputSchema: z.object({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ runId }) =>
      guard(async () => {
        const report = await sp.revert(runId);
        return { status: report.complete ? 'reverted' : 'partial', ...report };
      }),
  );

  server.registerTool(
    'rollikey_get_run',
    {
      title: 'Inspect a run',
      description: 'Return the snapshot ledger and airlock queue entries for a run.',
      inputSchema: z.object({ runId }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ runId }) => guard(() => sp.getRun(runId)),
  );

  return server;
}
