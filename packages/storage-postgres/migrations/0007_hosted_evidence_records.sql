-- 0007_hosted_evidence_records
-- Additive hosted read model. Canonical local facts and evaluations remain in
-- their existing append-only tables; this table stores only what an operator
-- explicitly chose to share with the optional hosted plane.

-- A deployment can belong to exactly one tenant in v1. This explicit pair is
-- the tenant-isolation anchor used by the composite FK below.
ALTER TABLE deployment_tenants
  ADD CONSTRAINT deployment_tenants_pair_uq UNIQUE (deployment_id, tenant_id);

CREATE TABLE hosted_evaluations (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  deployment_id   text NOT NULL,
  evidence_digest text NOT NULL,
  payload_hash    text NOT NULL,
  sharing_level   text NOT NULL,
  verify_status   text NOT NULL,
  protocol_status text NOT NULL,
  data_status     text NOT NULL,
  observed_at     timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, deployment_id, evidence_digest),
  FOREIGN KEY (deployment_id, tenant_id)
    REFERENCES deployment_tenants (deployment_id, tenant_id),
  CONSTRAINT hosted_evaluations_digest_ck CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hosted_evaluations_payload_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hosted_evaluations_sharing_ck CHECK
    (sharing_level IN ('sanitized-metadata', 'approved-full')),
  CONSTRAINT hosted_evaluations_verify_ck CHECK
    (verify_status IN ('verified', 'metadata-only')),
  CONSTRAINT hosted_evaluations_protocol_ck CHECK
    (protocol_status IN ('OK', 'WARN', 'UNKNOWN', 'CRITICAL')),
  CONSTRAINT hosted_evaluations_data_ck CHECK
    (data_status IN ('COMPLETE', 'STALE', 'PARTIAL', 'DIVERGENT', 'UNKNOWN')),
  CONSTRAINT hosted_evaluations_ttl_ck CHECK (expires_at > observed_at)
);

CREATE INDEX hosted_evaluations_timeline
  ON hosted_evaluations (tenant_id, deployment_id, observed_at DESC, evidence_digest DESC);

GRANT SELECT, INSERT ON hosted_evaluations TO ictt_sentinel_runtime;
