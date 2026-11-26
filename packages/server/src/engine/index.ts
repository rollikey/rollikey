import { config as defaultConfig, type Config } from '../config.js';
import { createInfra, type Infra } from '../infra.js';
import { Airlock, type EmailRequest } from './airlock.js';
import { GitHubProxy, type GitHubDeleteBranchesRequest, type GitHubUpdateRequest } from './github.js';
import { ensureGitHubSandbox } from './github-sandbox.js';
import { S3Proxy, type S3AclRequest, type S3DeleteRequest, type S3PutRequest } from './s3.js';
import { SlackProxy, type SlackArchiveRequest, type SlackPostRequest } from './slack.js';
import { type SnapshotRow } from './ledger.js';
import { PostgresProxy, TableCatalog, type DeleteRequest, type UpdateRequest } from './postgres.js';
import { revertRun } from './revert.js';
import { StripeProxy, type AuthorizeHoldRequest, type RefundRequest } from './stripe.js';

export interface RollikeyOptions {
  infra?: Infra;
  config?: Config;
  log?: (msg: string) => void;
}

export function createRollikey(opts: RollikeyOptions = {}) {
  const cfg = opts.config ?? defaultConfig;
  const infra = opts.infra ?? createInfra();
  const log = opts.log ?? ((m: string) => console.error(`[rollikey] ${m}`));

  const catalog = new TableCatalog(infra.pool, cfg.protectedTablePrefixes);
  const postgres = new PostgresProxy({
    pool: infra.pool,
    catalog,
    limits: cfg.gate,
    monetaryColumns: cfg.monetaryColumns,
  });
  const stripe = new StripeProxy({ pool: infra.pool, stripe: infra.stripe, limits: cfg.gate, connect: { feeBps: cfg.stripeConnect.feeBps, account: cfg.stripeConnect.account } });
  const airlock = new Airlock({
    pool: infra.pool,
    redis: infra.redis,
    mailer: infra.mailer,
    holdSeconds: cfg.airlock.holdSeconds,
    defaultFrom: cfg.smtp.from,
    log,
  });

  const s3 = new S3Proxy({
    pool: infra.pool, s3: infra.s3, defaultBucket: cfg.s3.defaultBucket, vaultBucket: cfg.s3.vaultBucket, maxBulkItems: cfg.gate.maxBulkItems,
  });
  const live = Boolean(cfg.github.token);
  const github = new GitHubProxy({
    pool: infra.pool,
    apiUrl: live ? 'https://api.github.com' : `http://127.0.0.1:${cfg.github.sandboxPort}`,
    token: cfg.github.token,
    defaultRepo: cfg.github.defaultRepo,
    maxBulkItems: cfg.gate.maxBulkItems,
    protectedBranches: cfg.github.protectedBranches,
  });
  const slack = new SlackProxy({
    pool: infra.pool, redis: infra.redis, botToken: cfg.slack.botToken, webhookUrl: cfg.slack.webhookUrl,
    externalPrefixes: cfg.slack.externalChannelPrefixes, holdSeconds: cfg.airlock.holdSeconds, maxBulkItems: cfg.gate.maxBulkItems, log,
  });
  let ready: Promise<void> | null = null;
  /** Idempotent: create MinIO buckets and start the offline GitHub sandbox (if no GITHUB_TOKEN). */
  const init = () => (ready ??= (async () => {
    await s3.ensureBuckets();
    if (!live) await ensureGitHubSandbox(infra.pool, cfg.github.sandboxPort);
  })());

  return {
    config: cfg,
    init,
    s3,
    github,
    slack,
    putObject: async (req: S3PutRequest) => (await init(), s3.putObject(req)),
    deleteObjects: async (req: S3DeleteRequest) => (await init(), s3.deleteObjects(req)),
    setBucketAcl: async (req: S3AclRequest) => (await init(), s3.setBucketAcl(req)),
    updateIssues: async (req: GitHubUpdateRequest) => (await init(), github.updateItems('issue', req)),
    updatePulls: async (req: GitHubUpdateRequest) => (await init(), github.updateItems('pull', req)),
    deleteBranches: async (req: GitHubDeleteBranchesRequest) => (await init(), github.deleteBranches(req)),
    slackPost: (req: SlackPostRequest) => slack.post(req),
    slackArchive: (req: SlackArchiveRequest) => slack.archiveChannel(req),
    infra,
    updateRows: (req: UpdateRequest) => postgres.update(req),
    deleteRows: (req: DeleteRequest) => postgres.delete(req),
    refund: (req: RefundRequest) => stripe.refund(req),
    authorizeHold: (req: AuthorizeHoldRequest) => stripe.authorizeHold(req),
    captureHolds: (runId: string) => stripe.captureHolds({ runId }),
    sendEmail: (req: EmailRequest) => airlock.enqueue(req),
    revert: async (runId: string) => (await init(), revertRun({ pool: infra.pool, airlock, postgres, stripe, s3, github, slack }, runId)),
    async getRun(runId: string) {
      const { rows } = await infra.pool.query<SnapshotRow>(
        'SELECT * FROM rollikey_snapshots WHERE run_id = $1 ORDER BY seq',
        [runId],
      );
      return { runId, snapshots: rows, emails: await airlock.listRun(runId), slack: await slack.listRun(runId) };
    },
    airlock,
    /** One worker drives both airlocks (email + Slack). */
    startAirlockWorker: (intervalMs = 1000) => {
      const emailWorker = airlock.startWorker(intervalMs);
      let stopped = false;
      let running: Promise<unknown> = Promise.resolve();
      const timer = setInterval(() => {
        if (stopped) return;
        running = running.then(() => slack.releaseDue()).catch((err) => log(`slack airlock worker error: ${(err as Error).message}`));
      }, intervalMs);
      return { async stop() { stopped = true; clearInterval(timer); await running; await emailWorker.stop(); } };
    },
    close: () => infra.close(),
  };
}

export type Rollikey = ReturnType<typeof createRollikey>;
