import pg from 'pg';
import { Redis } from 'ioredis';
import nodemailer, { type Transporter } from 'nodemailer';
import Stripe from 'stripe';
import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

export interface Infra {
  pool: pg.Pool;
  redis: Redis;
  mailer: Transporter;
  /** null when STRIPE_SECRET_KEY is unset. */
  stripe: Stripe | null;
  s3: S3Client;
  close(): Promise<void>;
}

export function assertTestStripeKey(key: string): void {
  if (/^(sk|rk)_live_/.test(key)) {
    throw new Error('Rollikey prototype refuses live Stripe keys. Use a sk_test_ key.');
  }
}

export function createInfra(): Infra {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  const mailer = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    ignoreTLS: true, // Mailpit speaks plain SMTP locally
  });
  let stripe: Stripe | null = null;
  if (config.stripeSecretKey) {
    assertTestStripeKey(config.stripeSecretKey);
    stripe = new Stripe(config.stripeSecretKey);
  }
  const s3 = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  return {
    pool,
    s3,
    redis,
    mailer,
    stripe,
    async close() {
      mailer.close();
      s3.destroy();
      redis.disconnect();
      await pool.end();
    },
  };
}
