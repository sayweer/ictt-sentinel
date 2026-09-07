-- 0002_verdicts_and_jobs
--
-- Two clearly separated groups:
--
--   append-only judgement   evaluations, verdict_events, evidence_bundles
--   mutable operational     replay_checkpoints, replay_ranges, projection_*,
--                           alert_outbox, alert_deliveries
--
-- The split is enforced by privilege in 0003, not by convention: the runtime role
-- gets INSERT-only on the first group and full DML on the second.

-- --------------------------------------------------------- append-only judgement

CREATE TABLE evaluations (
  evaluation_id    text PRIMARY KEY,
  -- Derived only from inputs: deployment, subject, policy version, adapter
  -- version, pinned block identities and the sorted input observation digests.
  -- No random UUID and no wall-clock component - that is what makes a retry of
  -- the same work idempotent instead of duplicating a verdict.
  idempotency_key  text NOT NULL UNIQUE,
  deployment_id    text NOT NULL REFERENCES deployments (deployment_id),
  subject          text NOT NULL,
  policy_version   text NOT NULL,
  adapter_version  text NOT NULL,
  pinned_blocks    jsonb NOT NULL,
  input_digest     text NOT NULL,
  verdict          text NOT NULL,
  payload_digest   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Verdict lattice (docs/INVARIANTS.md): CRITICAL > required UNKNOWN > WARN > OK.
  -- UNKNOWN is a first-class value here and is never stored as OK.
  CONSTRAINT evaluations_verdict_ck CHECK (verdict IN ('OK', 'WARN', 'UNKNOWN', 'CRITICAL')),
  CONSTRAINT evaluations_idem_ck    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluations_input_ck   CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluations_payload_ck CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  -- Every evaluation is pinned to at least one (number, hash) pair.
  CONSTRAINT evaluations_pinned_ck  CHECK (jsonb_typeof(pinned_blocks) = 'array'
                                           AND jsonb_array_length(pinned_blocks) >= 1)
);

COMMENT ON COLUMN evaluations.idempotency_key IS
  'Content-addressed over inputs. Same key + same payload_digest is a no-op retry; same key + different payload is a conflict.';

CREATE TABLE verdict_events (
  event_id      text PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES evaluations (evaluation_id),
  verdict       text NOT NULL,
  reason_code   text NOT NULL,
  detail        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verdict_events_verdict_ck CHECK (verdict IN ('OK', 'WARN', 'UNKNOWN', 'CRITICAL'))
);

CREATE TABLE evidence_bundles (
  bundle_id     text PRIMARY KEY,
  evaluation_id text NOT NULL UNIQUE REFERENCES evaluations (evaluation_id),
  export_hash   text NOT NULL,
  manifest_hash text NOT NULL,
  policy_hash   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_bundles_export_ck   CHECK (export_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_bundles_manifest_ck CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_bundles_policy_ck   CHECK (policy_hash ~ '^[0-9a-f]{64}$')
);

-- --------------------------------------------------------- mutable operational

-- A checkpoint advances only inside the same transaction that persisted the facts
-- it covers. The repository enforces that; the schema keeps the state minimal.
CREATE TABLE replay_checkpoints (
  deployment_id     text NOT NULL REFERENCES deployments (deployment_id),
  chain_key         text NOT NULL REFERENCES chains (chain_key),
  last_block_number bigint NOT NULL,
  last_block_hash   text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, chain_key),
  CONSTRAINT replay_checkpoints_hash_ck   CHECK (last_block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT replay_checkpoints_number_ck CHECK (last_block_number >= 0)
);

CREATE TABLE replay_ranges (
  range_id       text PRIMARY KEY,
  deployment_id  text NOT NULL REFERENCES deployments (deployment_id),
  chain_key      text NOT NULL REFERENCES chains (chain_key),
  from_block     bigint NOT NULL,
  to_block       bigint NOT NULL,
  status         text NOT NULL,
  reason_code    text,
  provider_group text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replay_ranges_bounds_ck CHECK (to_block >= from_block),
  -- Operator-visible states. `gap`, `stale`, `divergent` and `blocked` never map
  -- to a green status anywhere above this layer.
  CONSTRAINT replay_ranges_status_ck CHECK (status IN
    ('pending', 'complete', 'gap', 'stale', 'divergent', 'blocked'))
);

CREATE TABLE projection_versions (
  projection_name text PRIMARY KEY,
  version         integer NOT NULL,
  source_digest   text NOT NULL,
  rebuilt_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projection_versions_version_ck CHECK (version >= 1),
  CONSTRAINT projection_versions_digest_ck  CHECK (source_digest ~ '^[0-9a-f]{64}$')
);

-- A derived read model. Every row is reproducible from the raw facts alone, so it
-- can be dropped and rebuilt at a new version without touching the ledger.
CREATE TABLE projection_transfer_totals (
  projection_version integer NOT NULL,
  deployment_id      text NOT NULL REFERENCES deployments (deployment_id),
  chain_key          text NOT NULL REFERENCES chains (chain_key),
  subject            text NOT NULL,
  total_amount       numeric(78, 0) NOT NULL,
  observation_count          bigint NOT NULL,
  source_digest      text NOT NULL,
  PRIMARY KEY (projection_version, deployment_id, chain_key, subject),
  CONSTRAINT projection_transfer_totals_amount_ck CHECK (total_amount >= 0),
  CONSTRAINT projection_transfer_totals_count_ck  CHECK (observation_count >= 0),
  CONSTRAINT projection_transfer_totals_digest_ck CHECK (source_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE alert_outbox (
  outbox_id     text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES deployments (deployment_id),
  evaluation_id text REFERENCES evaluations (evaluation_id),
  dedup_key     text NOT NULL UNIQUE,
  payload       jsonb NOT NULL,
  status        text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_outbox_status_ck   CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  CONSTRAINT alert_outbox_attempts_ck CHECK (attempts >= 0)
);

CREATE TABLE alert_deliveries (
  delivery_id text PRIMARY KEY,
  outbox_id   text NOT NULL REFERENCES alert_outbox (outbox_id),
  target      text NOT NULL,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_deliveries_outcome_ck CHECK (outcome IN ('delivered', 'rejected', 'error'))
);
