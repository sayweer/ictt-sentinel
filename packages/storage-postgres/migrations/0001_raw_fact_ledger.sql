-- 0001_raw_fact_ledger
--
-- Raw, append-only observed facts. Nothing in this file expresses a judgement:
-- verdicts, evidence and mutable job state arrive in 0002.
--
-- Binding rules applied here (docs/DATA_MODEL.md, docs/INVARIANTS.md):
--   * Log identity is (chain_key, block_hash, tx_hash, log_index). `block_number`
--     alone is NOT identity - after a reorg the same height carries another block.
--   * Deterministic order is (block_number, tx_index, log_index).
--   * `blockchain_id` (ICM) and `evm_chain_id` are separate columns and are never
--     folded into one.
--   * Token amounts are NUMERIC(78,0) base units. DOUBLE PRECISION is forbidden;
--     78 digits covers uint256 (max 78 decimal digits) exactly.
--   * There is deliberately no `confirmations` column anywhere in this schema
--     (docs/DATA_MODEL.md 3.1): Ethereum-style depth is not Avalanche finality.
--
-- Objects are owned by ictt_sentinel_migrator. The runtime role never owns them
-- and never receives UPDATE or DELETE on a fact table.

CREATE TABLE schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);

COMMENT ON TABLE schema_migrations IS
  'Applied migrations. A recorded checksum is never rewritten: a changed file is an error, the fix is a new migration.';

-- ---------------------------------------------------------------- reference data

CREATE TABLE deployments (
  deployment_id  text PRIMARY KEY,
  manifest_hash  text NOT NULL,
  asset_mode     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployments_asset_mode_ck
    CHECK (asset_mode IN ('canonical-erc20', 'native')),
  CONSTRAINT deployments_manifest_hash_ck
    CHECK (manifest_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE chains (
  chain_key      text PRIMARY KEY,
  deployment_id  text NOT NULL REFERENCES deployments (deployment_id),
  blockchain_id  text NOT NULL,
  evm_chain_id   bigint NOT NULL,
  finality_mode  text NOT NULL,
  CONSTRAINT chains_blockchain_id_ck CHECK (blockchain_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chains_evm_chain_id_ck  CHECK (evm_chain_id > 0),
  -- Named semantics only. `settled-quorum` is schema-legal but rejected by policy
  -- until ACP-194 is active; that rejection lives in packages/config, not here.
  CONSTRAINT chains_finality_mode_ck CHECK (finality_mode IN ('accepted-quorum', 'settled-quorum')),
  CONSTRAINT chains_identity_uq UNIQUE (deployment_id, blockchain_id)
);

COMMENT ON COLUMN chains.blockchain_id IS 'Avalanche ICM identity. Never interchangeable with evm_chain_id.';
COMMENT ON COLUMN chains.evm_chain_id IS 'EVM chainId. Separate identity space from blockchain_id.';

-- Endpoint metadata carries the environment variable NAME, never a URL or token.
CREATE TABLE rpc_endpoints (
  chain_key      text NOT NULL REFERENCES chains (chain_key),
  endpoint_id    text NOT NULL,
  provider_group text NOT NULL,
  trust_domain   text NOT NULL,
  endpoint_role  text NOT NULL,
  archive_depth  text NOT NULL,
  secret_ref     text NOT NULL,
  PRIMARY KEY (chain_key, endpoint_id),
  CONSTRAINT rpc_endpoints_role_ck    CHECK (endpoint_role IN ('primary', 'witness', 'archive')),
  CONSTRAINT rpc_endpoints_archive_ck CHECK (archive_depth IN ('pruned', 'archive', 'unknown')),
  -- An env var name, not a value: upper snake case and never a URL.
  CONSTRAINT rpc_endpoints_secret_ref_name_ck CHECK (secret_ref ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT rpc_endpoints_secret_ref_not_url_ck CHECK (secret_ref NOT LIKE '%://%')
);

COMMENT ON COLUMN rpc_endpoints.provider_group IS
  'Quorum is counted DISTINCT over this column, never over endpoint_id: two URLs sharing an upstream are one witness.';

CREATE TABLE contract_baselines (
  baseline_id          text PRIMARY KEY,
  deployment_id        text NOT NULL REFERENCES deployments (deployment_id),
  chain_key            text NOT NULL REFERENCES chains (chain_key),
  address              text NOT NULL,
  bytecode_hash        text NOT NULL,
  proxy_implementation text,
  adapter_id           text NOT NULL,
  source_commit_sha    text NOT NULL,
  fingerprint_status   text NOT NULL,
  approved_at          timestamptz,
  CONSTRAINT contract_baselines_address_ck CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT contract_baselines_bytecode_ck CHECK (bytecode_hash ~ '^0x[0-9a-f]{64}$'),
  -- Traceable to an immutable commit, never a moving ref (docs/PROTOCOL_SOURCE_LOCK.md).
  CONSTRAINT contract_baselines_source_ck CHECK (source_commit_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT contract_baselines_status_ck
    CHECK (fingerprint_status IN ('approved', 'candidate', 'unsupported', 'unknown')),
  -- Only an approved baseline may carry an approval timestamp.
  CONSTRAINT contract_baselines_approval_ck
    CHECK ((fingerprint_status = 'approved') = (approved_at IS NOT NULL)),
  CONSTRAINT contract_baselines_identity_uq UNIQUE (deployment_id, chain_key, address)
);

-- ------------------------------------------------------------------- raw facts

-- Immutable as observed. Reclassification is an appended block_status_events row,
-- never an UPDATE: the runtime role has no UPDATE privilege on this table.
CREATE TABLE chain_blocks (
  chain_key       text NOT NULL REFERENCES chains (chain_key),
  block_hash      text NOT NULL,
  block_number    bigint NOT NULL,
  parent_hash     text NOT NULL,
  block_timestamp bigint NOT NULL,
  observed_class  text NOT NULL,
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (chain_key, block_hash),
  CONSTRAINT chain_blocks_hash_ck   CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_blocks_parent_ck CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_blocks_number_ck CHECK (block_number >= 0),
  -- 'accepted' is the canonical truth path; 'candidate' is an optional
  -- speed-path observation that may never produce a fact or verdict.
  CONSTRAINT chain_blocks_class_ck  CHECK (observed_class IN ('accepted', 'candidate'))
);

-- The integrity boundary. At most one ACCEPTED block per height: a second,
-- different accepted hash at the same height raises unique_violation, which the
-- repository converts into an integrity incident. It is never treated as a normal
-- reorg and never rolls back or overwrites the stored evidence.
CREATE UNIQUE INDEX chain_blocks_one_accepted_per_height
  ON chain_blocks (chain_key, block_number)
  WHERE observed_class = 'accepted';

CREATE TABLE block_status_events (
  event_id   text PRIMARY KEY,
  chain_key  text NOT NULL,
  block_hash text NOT NULL,
  status     text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (chain_key, block_hash) REFERENCES chain_blocks (chain_key, block_hash),
  CONSTRAINT block_status_events_status_ck CHECK (status IN ('candidate', 'accepted', 'orphaned'))
);

COMMENT ON TABLE block_status_events IS
  'Append-only reclassification history. An orphaned candidate keeps its raw row; the history is never deleted.';

CREATE TABLE chain_logs (
  chain_key    text NOT NULL,
  block_hash   text NOT NULL,
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  block_number bigint NOT NULL,
  tx_index     integer NOT NULL,
  address      text NOT NULL,
  topics       text[] NOT NULL,
  data         text NOT NULL,
  observed_at  timestamptz NOT NULL,
  -- Identity is the full tuple; block_number is ordering, not identity.
  PRIMARY KEY (chain_key, block_hash, tx_hash, log_index),
  FOREIGN KEY (chain_key, block_hash) REFERENCES chain_blocks (chain_key, block_hash),
  CONSTRAINT chain_logs_tx_hash_ck   CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_logs_address_ck   CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT chain_logs_log_index_ck CHECK (log_index >= 0),
  CONSTRAINT chain_logs_tx_index_ck  CHECK (tx_index >= 0),
  CONSTRAINT chain_logs_topics_ck    CHECK (cardinality(topics) BETWEEN 0 AND 4)
);

CREATE INDEX chain_logs_canonical_order
  ON chain_logs (chain_key, block_number, tx_index, log_index);

-- A pinned state read. Every comparative read carries block number AND hash;
-- there is no column that could hold a `latest` answer.
CREATE TABLE observations (
  observation_id  text PRIMARY KEY,
  deployment_id   text NOT NULL REFERENCES deployments (deployment_id),
  chain_key       text NOT NULL,
  block_hash      text NOT NULL,
  block_number    bigint NOT NULL,
  subject         text NOT NULL,
  amount          numeric(78, 0),
  finality_basis  text NOT NULL,
  provider_groups text[] NOT NULL,
  payload_digest  text NOT NULL,
  observed_at     timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  FOREIGN KEY (chain_key, block_hash) REFERENCES chain_blocks (chain_key, block_hash),
  CONSTRAINT observations_identity_uq UNIQUE (deployment_id, chain_key, block_hash, subject),
  -- Quorum provenance is not optional and is counted over provider groups.
  CONSTRAINT observations_groups_ck CHECK (cardinality(provider_groups) >= 1),
  CONSTRAINT observations_amount_ck CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT observations_digest_ck CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  -- Freshness has an explicit end. A stale observation cannot stay green forever.
  CONSTRAINT observations_ttl_ck    CHECK (expires_at > observed_at)
);

COMMENT ON COLUMN observations.amount IS
  'Base units as NUMERIC(78,0). uint256 max fits exactly. Float/double is forbidden by docs/DATA_MODEL.md 2.2.';

-- Teleporter delivery and application execution are distinct states and are
-- recorded as distinct transition kinds. DELIVERED is never EXECUTED_SUCCESS.
CREATE TABLE message_transitions (
  transition_id             text PRIMARY KEY,
  deployment_id             text NOT NULL REFERENCES deployments (deployment_id),
  source_blockchain_id      text NOT NULL,
  destination_blockchain_id text NOT NULL,
  messenger_address         text NOT NULL,
  registry_protocol_version integer NOT NULL,
  message_id                text NOT NULL,
  transition_kind           text NOT NULL,
  chain_key                 text NOT NULL,
  block_hash                text NOT NULL,
  tx_hash                   text NOT NULL,
  log_index                 integer NOT NULL,
  observed_at               timestamptz NOT NULL,
  FOREIGN KEY (chain_key, block_hash, tx_hash, log_index)
    REFERENCES chain_logs (chain_key, block_hash, tx_hash, log_index),
  CONSTRAINT message_transitions_kind_ck CHECK (transition_kind IN (
    'INTENT_OBSERVED', 'HOME_ACCOUNTED', 'ICM_SENT', 'DELIVERED',
    'EXECUTED_SUCCESS', 'EXECUTED_FAILED', 'RETRY_PENDING', 'RETRIED_SUCCESS'
  )),
  CONSTRAINT message_transitions_messenger_ck CHECK (messenger_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT message_transitions_version_ck   CHECK (registry_protocol_version >= 1),
  -- messageID is NOT globally unique. Identity is the full routing tuple; a bare
  -- UNIQUE (message_id) here would silently collapse distinct messages.
  CONSTRAINT message_transitions_identity_uq UNIQUE (
    source_blockchain_id, destination_blockchain_id, messenger_address,
    registry_protocol_version, message_id, transition_kind
  )
);

COMMENT ON COLUMN message_transitions.message_id IS
  'Not globally unique. Never constrain this column alone; identity is the routing tuple in message_transitions_identity_uq.';

-- A typed, append-only record of evidence that cannot be reconciled. Reaching
-- this table means the answer is UNKNOWN/BLOCKED, not a silent repair.
CREATE TABLE integrity_incidents (
  incident_id   text PRIMARY KEY,
  kind          text NOT NULL,
  chain_key     text NOT NULL REFERENCES chains (chain_key),
  block_number  bigint,
  expected_hash text,
  observed_hash text,
  detail        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integrity_incidents_kind_ck CHECK (kind IN (
    'RPC_INTEGRITY_CONFLICT', 'ACCEPTED_HASH_CONFLICT', 'LOG_DIGEST_DIVERGENCE'
  ))
);
