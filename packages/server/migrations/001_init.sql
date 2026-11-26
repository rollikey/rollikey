-- Rollikey initial schema: demo customers table + Rollikey ledger tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customers (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  plan          TEXT        NOT NULL CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  balance_cents BIGINT      NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled'))
);

-- Persistent, append-mostly ledger of every intercepted mutation.
-- before_state is the exact pre-mutation state (Postgres rows as to_jsonb(row),
-- or the Stripe object as returned by the API) and is what revert() restores from.
CREATE TABLE IF NOT EXISTS rollikey_snapshots (
  id            BIGSERIAL   PRIMARY KEY,
  run_id        TEXT        NOT NULL,
  seq           INTEGER     NOT NULL,
  action_type   TEXT        NOT NULL CHECK (action_type IN ('pg.update', 'pg.delete', 'stripe.refund')),
  target        TEXT        NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('pending', 'applied', 'blocked', 'failed', 'reverted', 'revert_failed')),
  request       JSONB       NOT NULL,
  before_state  JSONB       NOT NULL,
  after_state   JSONB,
  rows_affected INTEGER,
  amount_cents  BIGINT,
  block_reason  TEXT,
  error         TEXT,
  compensation  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at   TIMESTAMPTZ,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS rollikey_snapshots_run_idx ON rollikey_snapshots (run_id, seq DESC);

-- Outbound email staging airlock. Redis holds a TTL key per message; the row is
-- only released to SMTP once release_at has passed AND the Redis hold has expired.
CREATE TABLE IF NOT EXISTS rollikey_airlock_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          TEXT        NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('held', 'releasing', 'released', 'cancelled', 'failed')),
  from_address    TEXT        NOT NULL,
  to_addresses    TEXT[]      NOT NULL,
  subject         TEXT        NOT NULL,
  text_body       TEXT,
  html_body       TEXT,
  release_at      TIMESTAMPTZ NOT NULL,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  smtp_message_id TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS rollikey_airlock_due_idx ON rollikey_airlock_queue (release_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS rollikey_airlock_run_idx ON rollikey_airlock_queue (run_id);
