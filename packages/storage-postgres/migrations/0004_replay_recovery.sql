-- 0004_replay_recovery
--
-- Additive only. 0001-0003 are applied and therefore immutable; every change
-- here arrives as new objects and new grants (docs/RUNBOOK.md 2).
--
-- The load-bearing decision in this file is the separation of `webhook_hints`
-- from every fact table. A hint carries no block hash, no log and no digest, so
-- there is literally nothing in the row that could be promoted into evidence.

-- --------------------------------------------------------- priority hint queue

CREATE TABLE webhook_hints (
  hint_id                text PRIMARY KEY,
  deployment_id          text NOT NULL REFERENCES deployments (deployment_id),
  chain_key              text NOT NULL REFERENCES chains (chain_key),
  -- A height the source *claims* is interesting. Deliberately not a block hash:
  -- a hint must not be able to assert chain identity.
  suggested_block_number bigint NOT NULL,
  source                 text NOT NULL,
  -- Stable across redeliveries of one upstream event: this is the replay guard.
  dedup_key              text NOT NULL UNIQUE,
  received_at            timestamptz NOT NULL DEFAULT now(),
  consumed_at            timestamptz,
  CONSTRAINT webhook_hints_source_ck CHECK (source IN ('webhook', 'metrics-api', 'data-api')),
  CONSTRAINT webhook_hints_block_ck  CHECK (suggested_block_number >= 0)
);

COMMENT ON TABLE webhook_hints IS
  'Speed hints only. Cannot become a fact or a verdict and cannot advance a checkpoint; the engine reads these solely to order work the accepted-head plan already contained.';

CREATE INDEX webhook_hints_pending ON webhook_hints (deployment_id, chain_key, received_at)
  WHERE consumed_at IS NULL;

-- ------------------------------------------------------ data-quality incidents

-- Append-only. Distinct from integrity_incidents: those mean two observations of
-- final history contradict each other, these mean history could not be observed
-- completely. Both block a green verdict, for different reasons.
CREATE TABLE data_quality_incidents (
  incident_id   text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES deployments (deployment_id),
  chain_key     text NOT NULL REFERENCES chains (chain_key),
  reason_code   text NOT NULL,
  from_block    bigint NOT NULL,
  to_block      bigint NOT NULL,
  provider_group text,
  runbook       text NOT NULL,
  detail        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_quality_incidents_bounds_ck CHECK (to_block >= from_block),
  CONSTRAINT data_quality_incidents_reason_ck CHECK (reason_code IN (
    'SILENT_TRUNCATION', 'MISSING_BLOCK', 'MISSING_LOG', 'PRUNED_HISTORY',
    'EMPTY_RESPONSE_AMBIGUITY', 'PROVIDER_DIVERGENCE', 'INSUFFICIENT_WITNESSES',
    'RETRY_BUDGET_EXHAUSTED', 'RANGE_INDIVISIBLE', 'STALE_COLLECTION',
    'ARCHIVE_FALLBACK_UNAVAILABLE', 'REMOTE_HISTORY_UNAVAILABLE',
    'NONCANONICAL_BLOCK_REJECTED'
  ))
);

-- ------------------------------------------------------------ remote candidates

-- A permissionlessly registered remote. `trust` has exactly one legal value:
-- there is no state in this schema in which discovery alone confers trust.
CREATE TABLE remote_candidates (
  deployment_id           text NOT NULL REFERENCES deployments (deployment_id),
  remote_blockchain_id    text NOT NULL,
  remote_address          text NOT NULL,
  registered_at_block     bigint NOT NULL,
  registered_at_block_hash text NOT NULL,
  trust                   text NOT NULL DEFAULT 'candidate',
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, remote_blockchain_id, remote_address),
  CONSTRAINT remote_candidates_trust_ck CHECK (trust = 'candidate'),
  CONSTRAINT remote_candidates_chain_ck CHECK (remote_blockchain_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT remote_candidates_addr_ck  CHECK (remote_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT remote_candidates_hash_ck  CHECK (registered_at_block_hash ~ '^0x[0-9a-f]{64}$')
);

-- ------------------------------------------------- completeness projection

-- Derived, rebuildable, mutable. Holds the operator-visible replay status.
CREATE TABLE projection_replay_completeness (
  deployment_id   text NOT NULL REFERENCES deployments (deployment_id),
  chain_key       text NOT NULL REFERENCES chains (chain_key),
  status          text NOT NULL,
  verdict         text NOT NULL,
  window_from     bigint NOT NULL,
  window_to       bigint NOT NULL,
  gap_count       integer NOT NULL,
  reasons         text[] NOT NULL,
  last_success_at timestamptz,
  evaluated_at    timestamptz NOT NULL,
  PRIMARY KEY (deployment_id, chain_key),
  CONSTRAINT projection_replay_status_ck CHECK (status IN
    ('pending', 'complete', 'gap', 'stale', 'divergent', 'blocked')),
  CONSTRAINT projection_replay_verdict_ck CHECK (verdict IN ('OK', 'WARN', 'UNKNOWN', 'CRITICAL')),
  -- The rule, enforced by the database rather than by discipline: only a
  -- `complete` window may be reported as OK. Every other status is UNKNOWN, so
  -- there is no row shape in which a gap or a stale collection reads as green.
  CONSTRAINT projection_replay_only_complete_is_ok CHECK (
    (verdict = 'OK') = (status = 'complete')
  ),
  CONSTRAINT projection_replay_gaps_ck CHECK (gap_count >= 0),
  CONSTRAINT projection_replay_window_ck CHECK (window_to >= window_from)
);

-- ------------------------------------------------------------------- privileges

-- Append-only evidence: insert and read, never edit.
GRANT SELECT, INSERT ON data_quality_incidents, remote_candidates TO ictt_sentinel_runtime;

-- Operational: hints are consumed, the projection is recomputed.
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_hints, projection_replay_completeness
  TO ictt_sentinel_runtime;
