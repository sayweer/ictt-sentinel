-- 0008_alert_recovery_outbox_status
-- A recovery can race a pending delivery after a crash. Keep the durable row,
-- but make it ineligible for delivery so responders never receive a stale
-- breach after the recovery that superseded it.

ALTER TABLE alert_outbox DROP CONSTRAINT alert_outbox_status_ck;
ALTER TABLE alert_outbox ADD CONSTRAINT alert_outbox_status_ck CHECK
  (status IN ('pending', 'sent', 'failed', 'abandoned', 'cancelled'));

COMMENT ON COLUMN alert_outbox.status IS
  'cancelled means a pending notification was superseded by recovery before delivery; it is retained for audit and is never leased.';
