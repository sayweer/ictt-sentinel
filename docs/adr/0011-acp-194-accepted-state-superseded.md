# ADR-0011 — ACP-194 is active: accepted-state truth is superseded on the C-Chain

- **Status:** `ACCEPTED` — partially supersedes ADR-0002 (C-Chain mainnet and Fuji only)
- **Date:** 2026-10-09
- **Milestone:** 16
- **Related:** ADR-0002 (accepted-quorum truth, its expiry condition), ADR-0003 (fail-closed
  verdicts), `docs/PROTOCOL_SOURCE_LOCK.md` §6, `packages/domain/src/finality.ts`

## Context

ADR-0002 anchors every comparison to an accepted block agreed by independent witnesses, and it
carries a dated expiry condition: the moment Helicon receives a concrete activation timestamp on
any network, ADR-0002 is superseded there and the affected network's verdict is `UNKNOWN` until
the truth anchor moves to settled state.

That condition has been met. Sources read on 2026-10-09:

| Fact | Source | Status |
|---|---|---|
| Helicon activates at **2026-09-22T15:00:00Z on Mainnet** and **2026-07-28T15:00:00Z on Fuji** | `avalanchego` master `upgrade/upgrade.go` (`HeliconTime`) | `VERIFIED` |
| Helicon's activation list includes **ACP-194 "C-Chain Async Execution"** | Release `v1.15.0` "Helicon: Continuous Execution & Auto-Renewed Staking" (2026-09-08) | `VERIFIED` |
| `latest` = last **executed** block; `safe` and `finalized` = last **settled** block; `pending` maps to last executed by default | `v1.15.0` release notes; ACP-194 text | `VERIFIED` |
| A proposed block carries the `stateRoot` of the most recently **settled** block, not its own | ACP-194 text (`ACPs/194-continuous-execution`, status `Implementable`) | `VERIFIED` |
| Live: on Mainnet `latest` ran about five blocks (about 5 s) ahead of `finalized`; C-Chain blockchainIDs `0x0427d4…d652` (Mainnet) and `0x7fc93d…10d5` (Fuji) | Read-only `eth_getBlockByNumber` and Warp precompile `getBlockchainID()` against the public endpoints | `OBSERVED` |
| ACP-194 parameters are specified for the C-Chain only | ACP-194 text; Subnet-EVM / L1 coverage is not stated | `ASSUMPTION` |

Nothing in the code reacted to this. On an affected chain an accepted-quorum reading is no longer
evidence of executed state, so a verdict built on it can be green for the wrong reason.

## Decision

1. **One definition.** `acceptedStateSuperseded(identity, blockTimestamp)` in
   `@ictt-sentinel/domain` lists the affected chains (C-Chain Mainnet and Fuji) with their
   activation instants. A chain matches on its EVM chain id **or** its blockchainID; a half-declared
   C-Chain is still treated as affected. Activation is by block timestamp, as AvalancheGo gates
   upgrades, so evidence pinned before activation keeps the semantics it was taken under.
2. **Fail closed on every path that turns an accepted reading into a judgement:**
   - the offline verifier refuses an `accepted-quorum` chain pin at or after activation
     (`missing-required-evidence`), so `check`, `replay`, `evidence export` and the hosted API
     answer `UNKNOWN`;
   - the agent adds one required `UNKNOWN` per affected lane, with reason
     `ACCEPTED_STATE_SUPERSEDED`. Replay keeps ingesting, because executed logs are still facts;
   - `doctor` does not report accepted-quorum finality as established for an affected pin
     (`acceptanceEvidence: superseded-by-acp-194`).
3. **`settled-quorum` stays refused by configuration** until it is implemented and tested. The
   guard is the interim state that ADR-0002 prescribed, not the migration itself.

## Consequences

### Positive

- A deployment touching the C-Chain cannot receive `OK` on a superseded basis.
- Historical evidence from before activation still verifies.
- The platform change surfaced as a decision with a test, which was the point of ADR-0002's expiry
  clause.

### Negative / accepted cost

- Every live C-Chain deployment is `UNKNOWN` until `settled-quorum` lands. This is deliberate.
- A deterministic breach on an affected chain is also reported as `UNKNOWN` rather than
  `CRITICAL`: the state it would rest on is the state whose meaning changed.
- The activation table is maintained by hand. A new network adopting asynchronous execution needs
  an entry, and until it has one this guard does not see it.

## Remaining migration (not in this ADR)

1. Anchor on the settled block: resolve the head from the `finalized` tag per independent trust
   domain and pin all reads there.
2. Re-validate the ledger ingest path against executed-versus-settled receipts.
3. Re-run the regression corpus and fault lab for every affected invariant.
4. Only then accept `settled-quorum` in configuration.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Refuse C-Chain manifests at config load | That reports a configuration error where the honest answer is a verdict of `UNKNOWN`, and it stops `doctor` from explaining why. |
| Gate on the wall clock everywhere | Evidence pinned before activation would be rejected for no reason; block timestamps are what the upgrade itself uses. |
| Treat `latest` (executed) as the new anchor | Executed state is not yet settled into consensus; ACP-194 names `finalized` for that. |
