-- Phase 2C: non-custodial Stripe auth-hold (capture_method: manual).

ALTER TABLE rollikey_snapshots DROP CONSTRAINT IF EXISTS rollikey_snapshots_action_type_check;
ALTER TABLE rollikey_snapshots ADD CONSTRAINT rollikey_snapshots_action_type_check CHECK (action_type IN (
  'pg.update', 'pg.delete', 'stripe.refund', 'stripe.authorize_hold',
  's3.put', 's3.delete', 's3.acl',
  'github.issue_update', 'github.pr_update', 'github.branch_delete',
  'slack.post', 'slack.archive'));
