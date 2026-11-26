-- Phase 2B: S3 / GitHub / Slack connectors.

ALTER TABLE rollikey_snapshots DROP CONSTRAINT IF EXISTS rollikey_snapshots_action_type_check;
ALTER TABLE rollikey_snapshots ADD CONSTRAINT rollikey_snapshots_action_type_check CHECK (action_type IN (
  'pg.update', 'pg.delete', 'stripe.refund',
  's3.put', 's3.delete', 's3.acl',
  'github.issue_update', 'github.pr_update', 'github.branch_delete',
  'slack.post', 'slack.archive'));

-- Slack staging airlock (mirrors rollikey_airlock_queue; Redis holds the TTL key).
CREATE TABLE IF NOT EXISTS rollikey_slack_queue (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      TEXT        NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('held', 'releasing', 'released', 'cancelled', 'failed')),
  channel     TEXT        NOT NULL,
  text        TEXT        NOT NULL,
  thread_ts   TEXT,
  reason      TEXT        NOT NULL,
  release_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  message_ts  TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS rollikey_slack_due_idx ON rollikey_slack_queue (release_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS rollikey_slack_run_idx ON rollikey_slack_queue (run_id);

-- Local Slack inbox sink: where posts land when no live Slack credentials are configured.
CREATE TABLE IF NOT EXISTS rollikey_slack_sink (
  id         BIGSERIAL   PRIMARY KEY,
  ts         TEXT        NOT NULL UNIQUE,
  channel    TEXT        NOT NULL,
  text       TEXT        NOT NULL,
  thread_ts  TEXT,
  run_id     TEXT,
  edited     BOOLEAN     NOT NULL DEFAULT false,
  deleted    BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Offline GitHub sandbox backing store (served by the built-in mock REST server).
CREATE TABLE IF NOT EXISTS sandbox_gh_items (
  repo       TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('issue', 'pull')),
  title      TEXT    NOT NULL,
  body       TEXT,
  state      TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  labels     JSONB   NOT NULL DEFAULT '[]',
  assignees  JSONB   NOT NULL DEFAULT '[]',
  milestone  INTEGER,
  base       TEXT,
  head       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS sandbox_gh_branches (
  repo      TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  sha       TEXT    NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (repo, name)
);
