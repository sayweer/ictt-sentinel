-- 0003_runtime_privileges
--
-- The authority model, expressed as PostgreSQL privileges rather than as
-- application discipline. The runtime role is not the schema owner and is not a
-- superuser; it physically cannot rewrite an observed fact or a recorded verdict.
--
-- Roles are created once by a superuser before migrations run (see
-- `ensureRoles` in src/bootstrap.ts and docs/RUNBOOK.md). This file only grants.
--
--   ictt_sentinel_migrator  owns every object; the only role that may DDL.
--   ictt_sentinel_runtime   INSERT+SELECT on facts and judgement,
--                           full DML on operational state, nothing else.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ictt_sentinel_runtime;

-- Reference data is operator-curated and read-only at runtime.
GRANT SELECT ON
  schema_migrations,
  deployments,
  chains,
  rpc_endpoints,
  contract_baselines
TO ictt_sentinel_runtime;

-- Append-only. INSERT and SELECT deliberately without UPDATE or DELETE: an
-- observed fact and a recorded judgement are evidence, and evidence is not edited.
GRANT SELECT, INSERT ON
  chain_blocks,
  block_status_events,
  chain_logs,
  observations,
  message_transitions,
  integrity_incidents,
  evaluations,
  verdict_events,
  evidence_bundles
TO ictt_sentinel_runtime;

-- Operational state is meant to change: checkpoints move, ranges are retried,
-- projections are rebuilt, the outbox drains.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  replay_checkpoints,
  replay_ranges,
  projection_versions,
  projection_transfer_totals,
  alert_outbox,
  alert_deliveries
TO ictt_sentinel_runtime;

-- No sequences are used (all identifiers are content-addressed or caller-supplied),
-- so no sequence privileges are granted. Default privileges stay closed so a table
-- added by a later migration is unreachable until it is granted explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE ictt_sentinel_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM ictt_sentinel_runtime;
