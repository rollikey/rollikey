import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the monorepo-root .env (packages/server/src -> repo root). Real env vars win.
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, '../../../.env'), resolve(process.cwd(), '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

/**
 * Optional Stripe Connect application fee, in basis points, taken ONLY on captured Stripe auth-holds.
 * 0 (default, self-hosted) = no fee. Hosted Connect mode may set 25-50 bps (0.25%-0.50%).
 * Database, S3, GitHub and Slack/Email rollbacks are always free.
 */
export function parseConnectFeeBps(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || (n !== 0 && (n < 25 || n > 50))) {
    throw new Error(`ROLLIKEY_CONNECT_FEE_BPS must be 0 (no fee) or an integer from 25 to 50 (0.25%-0.50%), got "${raw}"`);
  }
  return n;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://rollikey:rollikey_dev_password@localhost:5432/rollikey_db',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: int('SMTP_PORT', 1025),
    from: process.env.SMTP_FROM ?? 'rollikey-agent@rollikey.local',
  },
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeConnect: {
    feeBps: parseConnectFeeBps(process.env.ROLLIKEY_CONNECT_FEE_BPS),
    /** Hosted Connect mode: the user's connected account (acct_...); funds settle directly there (non-custodial). */
    account: process.env.ROLLIKEY_CONNECT_ACCOUNT ?? '',
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    // Defaults match the local MinIO service in docker-compose.yml.
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'rollikey_minio',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'rollikey_minio_password',
    defaultBucket: process.env.S3_BUCKET ?? 'rollikey-sandbox',
    /** Recovery vault: exact prior bytes + metadata are copied here before any overwrite/delete. */
    vaultBucket: process.env.S3_VAULT_BUCKET ?? 'rollikey-vault',
  },
  github: {
    token: process.env.GITHUB_TOKEN ?? '',
    sandboxPort: int('GITHUB_SANDBOX_PORT', 4010),
    defaultRepo: process.env.GITHUB_DEFAULT_REPO ?? 'rollikey-sandbox/demo',
    /** Branches that may never be deleted through the proxy (in addition to API-reported protection). */
    protectedBranches: ['main', 'master'],
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
    webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
    /** Channels starting with these prefixes count as external / shared and are airlocked. */
    externalChannelPrefixes: (process.env.SLACK_EXTERNAL_PREFIXES ?? 'ext-,shared-,partner-,customer-').split(',').filter(Boolean),
  },
  gate: {
    /** Bulk limit for S3 deletes, GitHub items/branches and Slack messages per run (strictly more is blocked). */
    maxBulkItems: int('ROLLIKEY_MAX_BULK_ITEMS', 10),
    /** A single call may touch at most this many rows (strictly more is blocked). */
    maxRows: int('ROLLIKEY_MAX_ROWS', 10),
    /** A single call may move at most this many cents (strictly more is blocked). $1,000 by default. */
    maxAmountCents: int('ROLLIKEY_MAX_AMOUNT_CENTS', 100_000),
  },
  airlock: {
    holdSeconds: int('ROLLIKEY_AIRLOCK_SECONDS', 60),
    runWorker: (process.env.ROLLIKEY_RUN_AIRLOCK_WORKER ?? 'true') !== 'false',
  },
  /** Columns whose numeric change counts as money moved for the $ gate. */
  monetaryColumns: ['balance_cents'],
  /** Tables an agent may never mutate through the proxy. */
  protectedTablePrefixes: ['rollikey_', 'sandbox_', 'schema_migrations', 'pg_'],
} as const;

export type Config = typeof config;
