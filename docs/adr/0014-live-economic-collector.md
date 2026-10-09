# ADR-0014 — Live economic collector for canonical ERC20

- **Status:** `ACCEPTED`
- **Date:** 2026-10-09
- **Milestone:** 21
- **Related:** ADR-0002 (pinned, witnessed reads), ADR-0011 / ADR-0013 (finality basis), ADR-0003
  (fail-closed verdicts), Milestone 15 R1 (the gap this closes for the CLI)

## Context

The invariant engine and evidence verifier were complete, but every evidence bundle came from a
fixture: nothing turned live chain reads into the engine's input. This was the main gap that kept
the release a technical preview. Gate A also depends on something no single read can give: a
causally closed cut across two chains.

## Decision

`ictt-sentinel collect --manifest <m> --policy <p> [--pins <pins>] [--max-facts <n>]` produces a
canonical ERC20 evidence bundle from live reads.

1. **Pins.** Each chain is pinned at the minimum, across its endpoints, of the settled block
   (`finalized` tag) or, under `accepted-quorum`, the head. `--pins` overrides this choice.
2. **Witnesses.** Endpoints must pass the existing `doctor` probe (identity, finality,
   fingerprint) at the pin. They are grouped into failure domains with
   `collapsedIndependenceGroups`. Each domain contributes one reading, and that reading is
   **complete**: bounded log scans, the blocks behind every log, pinned `eth_call`s and a re-check
   of the pin hash. Readings must be byte-identical. Any difference is `witness-divergence`, and
   fewer domains than required is `insufficient-independent-witnesses`. Majority is never taken.
3. **Decoding** uses the pinned ABI (`@ictt-sentinel/ictt-adapters` `events.ts`) and is strict.
   A Teleporter delivery's payload is decoded only when its origin and destination are the
   approved transferrers, so other applications' messages are never interpreted.
4. **Route model** (`apps/cli/src/collect/model.ts`). Derived from the pinned TokenHome and
   TokenRemote: `D(homePin) − S(remotePin) = P_h2r + P_r2h`, where a transfer is pending when its
   source fact is inside the cut and its successful execution is not. An execution inside the cut
   whose source is not inside it opens the cut. It is not an effect, because there is no source to
   judge it against. Routed, multi-hop and send-and-call traffic marks the route unsupported. A
   property test replays random histories with the contract's own update rules and checks the
   identity on every closed cut.
5. **The bundle is self-checked.** It is built only from observations. The escrow read binds to the
   recognised TokenHome's `getTokenAddress()`. The bundle is written only if `verifyBundle`
   accepts it. Otherwise the result is `UNKNOWN` with the verifier's findings.

## Consequences

### Positive

- Canonical ERC20 evidence comes from chain data, not fixtures, and it passes the same `check`
  operators already run.
- Every failure is named: `no-pin`, `witness-divergence`, `insufficient-independent-witnesses`,
  `log-bound-exceeded`, `undecodable-observation`, `unverifiable:<finding>`.

### Negative / accepted cost

- **Full history every run.** Each run scans from the deployment blocks, bounded by
  `--max-facts` (at most 10,000 logs per chain). Larger deployments get `UNKNOWN`
  (`log-bound-exceeded`) until incremental collection exists.
- **A route with no message history is `UNKNOWN`.** The verifier requires at least one message
  record, and that rule was kept rather than relaxed for this case.
- **The messenger is not source-locked.** Teleporter logs are read at the operator-declared
  messenger address under the pinned ABI, and that contract's runtime code is not fingerprinted.
  The bundle records this as an assumption.
- **Native remotes are not collected** (`native-collector-not-implemented` → `UNKNOWN`).
- **No real deployment has been evaluated end to end.** `RELEASE: TECHNICAL_PREVIEW` stands.

## Addendum — 2026-10-09 (Milestone 22)

The collector moved to `@ictt-sentinel/collector`. The watcher runs it every
`ICTT_SENTINEL_ECONOMIC_INTERVAL_MS` (default 15 minutes, minimum 1 minute), separately from the
replay tick because each run reads full history. A run that produces evidence is stored as an
evaluation (subject `canonical-erc20-economic`, payload digest = bundle content hash) with a
verdict event, and is mirrored to the hosted API when one is configured. Every run, evidence or
not, feeds the `ACC-ERC20-CANONICAL` alert rule. The agent binds evidence to
`SOURCE_LOCK_DOCUMENT_DIGEST`, which a CLI test keeps equal to the source-lock document, and names
itself by the content of the code it runs.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Pair destination `TokensWithdrawn` logs with source sends | `TokensWithdrawn` carries no message id. Teleporter's `ReceiveCrossChainMessage` carries the authenticated message, and the model uses that. |
| Pick heights by wall-clock proximity | Proximity says nothing about causality; closure is decided from the facts themselves. |
| Majority across witnesses | Policy says disagreement is `UNKNOWN`; a minority reading is evidence that the view is unsettled. |
| Relax the verifier for empty message history | It would weaken an existing gate. A quiet route is `UNKNOWN` instead. |
