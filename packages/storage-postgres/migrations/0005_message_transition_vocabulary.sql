-- 0005_message_transition_vocabulary
--
-- Milestone 06 created `message_transitions` before the message model existed,
-- with a placeholder vocabulary that mixed lifecycle STATES into a column that
-- holds TRANSITIONS. Milestone 08 defines the real one, so this migration
-- replaces the constraint with the semantic transition kinds the state machine
-- actually produces (`TransitionKind` in @ictt-sentinel/state-machine).
--
-- Replacing rather than widening is deliberate: carrying two vocabularies in one
-- column would make `transition_kind` ambiguous, and an ambiguous accounting
-- column is how double counting starts. If a deployed database still held rows
-- under the old vocabulary this ALTER would fail loudly, which is the correct
-- outcome - a silent coexistence is the thing to avoid.

ALTER TABLE message_transitions
  DROP CONSTRAINT message_transitions_kind_ck;

ALTER TABLE message_transitions
  ADD CONSTRAINT message_transitions_kind_ck CHECK (transition_kind IN (
    'source-application-emitted',
    'intent-observed',
    'source-accounted',
    'icm-sent',
    -- A further send attempt for one intent. NOT a second intent.
    'send-retry',
    -- A new ICM envelope carrying the same application lineage after a re-sign.
    'envelope-resigned',
    -- Delivery. Never execution.
    'delivered',
    'execution-succeeded',
    'execution-failed',
    'execution-retried',
    -- Relayer liveness. Carries no economic weight on its own.
    'receipt-observed',
    'unreceivable-by-version-policy',
    'paused-version',
    'orphaned',
    'unsupported'
  ));

-- Transition identity must include the RAW FACT, not just the route and kind.
--
-- Milestone 06 keyed transitions on (route, transition_kind) alone. That silently
-- absorbs a second successful execution of the same route: the row is dropped as
-- a duplicate and the evidence that two credits were attempted disappears with
-- it. Both facts must be stored, so the breach is visible and the economic-effect
-- index below is the thing that refuses it.
--
-- The route tuple is still the message identity. `message_id` alone remains
-- unconstrained, for the reason 0001 documents.
ALTER TABLE message_transitions
  DROP CONSTRAINT message_transitions_identity_uq;

ALTER TABLE message_transitions
  ADD CONSTRAINT message_transitions_identity_uq UNIQUE (
    source_blockchain_id,
    destination_blockchain_id,
    messenger_address,
    registry_protocol_version,
    message_id,
    transition_kind,
    chain_key,
    block_hash,
    tx_hash,
    log_index
  );

-- Which ICM envelope carried this transition. Separate from the message key on
-- purpose: a re-signed message has one lineage and two envelopes, and folding
-- them together would lose the distinction the retry rules depend on.
ALTER TABLE message_transitions
  ADD COLUMN envelope_id text;

-- Whether this transition carried an actual transfer. A receipt-only or
-- empty-payload message sets it false, which is what keeps it out of the
-- economic effect count.
ALTER TABLE message_transitions
  ADD COLUMN carries_economic_effect boolean NOT NULL DEFAULT false;

-- At most ONE credited economic effect per message route, enforced by the
-- database rather than by application discipline. The partial unique index means
-- a second successful execution for the same route raises unique_violation
-- instead of quietly becoming a second credit.
CREATE UNIQUE INDEX message_transitions_one_economic_effect
  ON message_transitions (
    source_blockchain_id,
    destination_blockchain_id,
    messenger_address,
    registry_protocol_version,
    message_id
  )
  WHERE carries_economic_effect;

COMMENT ON INDEX message_transitions_one_economic_effect IS
  'One credited effect per route. A send retry and an execution retry are additional attempts, never additional effects.';
