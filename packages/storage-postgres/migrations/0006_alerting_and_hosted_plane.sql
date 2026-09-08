-- 0006_alerting_and_hosted_plane
--
-- Additive only. 0001-0005 are applied and therefore immutable (docs/RUNBOOK.md 2).
--
-- Two groups arrive here:
--
--   alert lifecycle   the outbox stops being a bare payload queue and becomes the
--                     durable home of the alert state machine, so a restart
--                     resumes an incident instead of re-opening it.
--   hosted plane      tenants, scoped tokens, ingest idempotency, webhook replay
--                     protection and an append-only audit log.
--
-- Nothing in this file can hold a chain-write capability. A token here authorises
-- reading evidence and posting evaluations produced by a local agent; there is no
-- column anywhere in this schema that could carry a signing key.

-- ------------------------------------------------------------ alert lifecycle

-- The outbox row is the alert. `dedup_key` was already UNIQUE in 0002, which is
-- what makes the whole lifecycle idempotent: a second observation of the same
-- evidence updates this row instead of creating a second incident.
ALTER TABLE alert_outbox
  -- Groups the notification events of ONE incident. `dedup_key` identifies a
  -- single notification (deployment + rule/reason + verdict transition +
  -- evidence digest, so new evidence is a new page); `incident_key` is the
  -- coarser deployment + rule + reason grouping that an acknowledgement mutes
  -- and a recovery closes.
  ADD COLUMN incident_key    text,
  ADD COLUMN rule_id         text,
  ADD COLUMN reason_code     text,
  ADD COLUMN verdict_from    text,
  ADD COLUMN verdict_to      text,
  ADD COLUMN evidence_digest text,
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'first_seen',
  ADD COLUMN occurrences     integer NOT NULL DEFAULT 1,
  ADD COLUMN first_seen_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN acknowledged_by text,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN recovered_at    timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE alert_outbox
  ADD CONSTRAINT alert_outbox_lifecycle_ck CHECK (lifecycle_state IN
    ('first_seen', 'repeated', 'escalated', 'acknowledged', 'recovered')),
  ADD CONSTRAINT alert_outbox_occurrences_ck CHECK (occurrences >= 1),
  -- UNKNOWN is a first-class alert severity and is never stored as OK
  -- (docs/adr/0003-fail-closed-verdicts.md).
  ADD CONSTRAINT alert_outbox_verdict_to_ck CHECK
    (verdict_to IS NULL OR verdict_to IN ('OK', 'WARN', 'UNKNOWN', 'CRITICAL')),
  ADD CONSTRAINT alert_outbox_verdict_from_ck CHECK
    (verdict_from IS NULL OR verdict_from IN ('NONE', 'OK', 'WARN', 'UNKNOWN', 'CRITICAL')),
  ADD CONSTRAINT alert_outbox_evidence_ck CHECK
    (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT alert_outbox_incident_ck CHECK
    (incident_key IS NULL OR incident_key ~ '^[0-9a-f]{64}$'),
  -- An acknowledgement is a human act and is recorded as one. The database
  -- refuses a row that claims to be acknowledged by nobody.
  ADD CONSTRAINT alert_outbox_ack_ck CHECK
    ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
  ADD CONSTRAINT alert_outbox_recovered_ck CHECK
    ((lifecycle_state = 'recovered') = (recovered_at IS NOT NULL));

COMMENT ON COLUMN alert_outbox.lifecycle_state IS
  'acknowledged is a hosted operational state: it mutes paging. It is not a chain action, it does not change a verdict, and the underlying condition may still be live.';

CREATE INDEX alert_outbox_due
  ON alert_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX alert_outbox_by_deployment
  ON alert_outbox (deployment_id, last_seen_at DESC);

-- The open incident lookup. Partial, because a closed incident is never the one
-- a new observation folds into.
CREATE INDEX alert_outbox_open_incident
  ON alert_outbox (incident_key, last_seen_at DESC)
  WHERE lifecycle_state <> 'recovered';

-- --------------------------------------------------------------- hosted plane

CREATE TABLE tenants (
  tenant_id   text PRIMARY KEY,
  display_name text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT tenants_id_ck CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

-- Authorization edge. Kept out of `deployments` so that the fact tables stay
-- exactly as 0001 defined them and a tenancy mistake cannot reshape evidence.
CREATE TABLE deployment_tenants (
  deployment_id text PRIMARY KEY REFERENCES deployments (deployment_id),
  tenant_id     text NOT NULL REFERENCES tenants (tenant_id),
  -- What this tenant's agent is permitted to upload. Default is the safe end.
  sharing_level text NOT NULL DEFAULT 'local-only',
  CONSTRAINT deployment_tenants_sharing_ck CHECK (sharing_level IN
    ('local-only', 'sanitized-metadata', 'approved-full'))
);

CREATE INDEX deployment_tenants_by_tenant ON deployment_tenants (tenant_id);

-- Only the hash is stored. A leaked database backup must not be a working set of
-- API credentials, and nothing in this product ever needs the token back.
CREATE TABLE api_tokens (
  token_id    text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  token_hash  text NOT NULL UNIQUE,
  scopes      text[] NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT api_tokens_hash_ck   CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_tokens_scopes_ck CHECK (cardinality(scopes) >= 1),
  -- Every token expires. A credential with no end date is a credential nobody
  -- ever rotates.
  CONSTRAINT api_tokens_expiry_ck CHECK (expires_at > created_at),
  -- Scopes are an allowlist, spelled out here so a typo cannot silently widen
  -- authority. There is deliberately no scope that writes to a chain.
  CONSTRAINT api_tokens_scope_values_ck CHECK (scopes <@ ARRAY[
    'evidence:read', 'status:read', 'ingest:write', 'alerts:ack', 'hint:write'
  ]::text[])
);

CREATE INDEX api_tokens_by_tenant ON api_tokens (tenant_id);

-- Ingest idempotency. The key is caller-supplied; the payload hash is ours.
-- Same key + same payload is a replay and returns the first answer. Same key +
-- different payload is a conflict and is refused, because silently accepting the
-- second body would let a retry rewrite an evaluation.
CREATE TABLE api_idempotency (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  idempotency_key text NOT NULL,
  route           text NOT NULL,
  payload_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT api_idempotency_key_ck     CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  CONSTRAINT api_idempotency_payload_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_idempotency_status_ck  CHECK (response_status BETWEEN 100 AND 599),
  CONSTRAINT api_idempotency_ttl_ck     CHECK (expires_at > created_at)
);

CREATE INDEX api_idempotency_expiry ON api_idempotency (expires_at);

-- Webhook replay protection. A signature alone is replayable forever, so a
-- webhook is accepted once: the nonce is remembered until its timestamp window
-- closes, and a repeat inside that window is refused.
CREATE TABLE webhook_nonces (
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id),
  nonce      text NOT NULL,
  signed_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, nonce),
  CONSTRAINT webhook_nonces_nonce_ck CHECK (nonce ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  CONSTRAINT webhook_nonces_ttl_ck   CHECK (expires_at > signed_at)
);

CREATE INDEX webhook_nonces_expiry ON webhook_nonces (expires_at);

-- Append-only. The runtime role gets INSERT and SELECT and nothing else, so the
-- process that serves requests cannot erase the record of what it served.
CREATE TABLE api_audit_log (
  audit_id     text PRIMARY KEY,
  tenant_id    text REFERENCES tenants (tenant_id),
  token_id     text REFERENCES api_tokens (token_id),
  request_id   text NOT NULL,
  action       text NOT NULL,
  resource     text NOT NULL,
  outcome      text NOT NULL,
  status_code  integer NOT NULL,
  -- No request body, no headers, no URL query. An audit log that copies the
  -- request is a second place for a credential to live.
  detail       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_audit_outcome_ck CHECK (outcome IN ('allowed', 'denied', 'error')),
  CONSTRAINT api_audit_status_ck  CHECK (status_code BETWEEN 100 AND 599)
);

CREATE INDEX api_audit_by_tenant ON api_audit_log (tenant_id, created_at DESC);

-- ------------------------------------------------------------------ privileges

-- Reference and authorization data is operator-curated; the runtime reads it.
GRANT SELECT ON tenants, deployment_tenants, api_tokens TO ictt_sentinel_runtime;

-- Append-only audit.
GRANT SELECT, INSERT ON api_audit_log TO ictt_sentinel_runtime;

-- Operational state with a TTL: rows are written, read and swept.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_idempotency, webhook_nonces
  TO ictt_sentinel_runtime;
