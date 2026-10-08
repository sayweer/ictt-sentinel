# ADR-0013 — settled-quorum: anchoring on the settled block

- **Status:** `ACCEPTED` — completes the migration ADR-0011 left open
- **Date:** 2026-10-09
- **Milestone:** 19
- **Related:** ADR-0002 (accepted-quorum truth), ADR-0011 (ACP-194 guard),
  `packages/domain/src/finality.ts`, `docs/PROTOCOL_SOURCE_LOCK.md` §6

## Context

ADR-0011 made every accepted-quorum reading on a post-Helicon C-Chain `UNKNOWN`. That stopped
wrong greens, but it also left C-Chain deployments with no mode that could produce a verdict.
The ADR listed the remaining migration: anchor on the settled block, re-check the ingest path,
re-run the regression corpus, and only then accept `settled-quorum` in configuration.

Read-only observations against the public C-Chain endpoints (Mainnet and Fuji, 2026-10-09):

| Observation | Result |
|---|---|
| `eth_blockNumber` minus the `finalized` block number | 4 to 7 blocks on both networks: the block number reports executed, not settled |
| `eth_getBlockByNumber(<finalized number>)` hash equals the `finalized` tag's hash | Yes, on both networks |
| `eth_call` pinned to the finalized block number | Answers (Warp `getBlockchainID()`) |
| `eth_getLogs` over a range ending at the finalized block | Answers |
| `finalized` across successive reads behind a load balancer | Monotonic over these reads; different backends can report different heights |

So the agent's head, `eth_blockNumber`, ran ahead of settlement. Everything below the settled
block can be read with the primitives the product already uses.

## Decision

1. **`settled-quorum` is accepted by configuration.** It does not require the `accepted-only`
   assertion, because it never reads `latest`. `accepted-quorum` keeps that requirement.
2. **One rule decides whether a basis stands:** `finalityBasisStands(basis, chain, timestamp)` in
   `@ictt-sentinel/domain`. `settled-quorum` stands on every chain. `accepted-quorum` stands only
   where ACP-194 has not separated execution. Any other value stands nowhere. The verifier, the
   agent and `doctor` all call this rule.
3. **The agent's head under settled-quorum** is the minimum across independent witnesses of each
   witness's `finalized` block. A witness's block number is never used for a settled lane.
   Ingest is unchanged: `eth_getLogs` over committed ranges, every range bounded by that head.
4. **Evidence binds its semantic.** A bundle's chain pin must carry the finality mode that its
   manifest chain declares (`finality-basis-mismatch` otherwise). An accepted-quorum bundle cannot
   pass against a settled manifest, or the other way round.
5. **The example manifest's home (a C-Chain) uses `settled-quorum`.** Its remote, an L1, stays on
   `accepted-quorum`, so the template shows both modes.

## Consequences

### Positive

- C-Chain deployments can again reach `OK`, on settled state.
- On chains where execution never separated from acceptance, `settled-quorum` and
  `accepted-quorum` read the same block, so choosing settled is never wrong. It is the safer
  default.
- Two fault-lab scenarios cover the change: an accepted pin after ACP-194 must not be `OK`, and a
  settled pin must still verify.

### Negative / accepted cost

- Settled state trails execution by about τ (5 s on the C-Chain) plus block time. Verdicts are
  that much later.
- Settled-quorum relies on the endpoint's `finalized` tag meaning "settled". That is what ACP-194
  and the v1.15.0 release notes specify and what was observed, but it is still a node statement,
  probed through `doctor` and not proven.
- Accepted-quorum on a post-Helicon C-Chain is still a valid configuration, and it still yields
  `UNKNOWN`. Refusing it at load time was rejected in ADR-0011.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Anchor on `latest` (executed) | Executed state is not yet committed by consensus; ACP-194 names `finalized` for settled state. |
| Anchor on `safe` | On these networks `safe` and `finalized` both name the settled block; one tag avoids two semantics. |
| Make `settled-quorum` the only mode | L1s without asynchronous execution would gain nothing, and existing manifests would break for no reason. |
