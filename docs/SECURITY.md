# Security — ictt-sentinel

**Last reviewed:** 2026-09-09

This product is a security tool, which means **it is itself an attack surface**. The rules below
take precedence over any product feature.

For vulnerability disclosure, see [`SECURITY.md`](../SECURITY.md) at the repository root. This
document is the threat model.

---

## 1. Keyless operation — non-negotiable

### Things that will never exist here

- Private keys, mnemonics, seeds, signers, wallets, keystores — **never created, requested, stored
  or read**
- `sendTransaction`, a signer interface, or any other chain-write surface
- Calls to mint, burn, retry, pause or upgrade
- Auto-pause or any automatic circuit breaker

Environment variables that must **never** be present:

```
BRIDGE_PRIVATE_KEY
MINTER_PRIVATE_KEY
PAUSER_PRIVATE_KEY
MULTISIG_SIGNER_KEY
```

The presence of any of them is treated as a **build error**, not a warning.

### Why

Automated response can cause **very high impact** damage through a wrong pause or a wrong retry. If
a response layer is ever needed it belongs in a separate, opt-in system under a multisig policy —
not in this product. See [`adr/0001-keyless-read-only.md`](adr/0001-keyless-read-only.md).

This is enforced mechanically, not by review alone: `pnpm run boundaries:check` scans the entire
repository for signing and chain-write surfaces, and the fault lab reports a forbidden-surface
counter that must be zero for a release to pass.

## 2. The RPC surface

- **A public generic `request(method, params)` surface is forbidden.**
- Access is **query-only, through an allowlist**: every JSON-RPC method name that is read must
  appear in a fixed list in code. Anything outside that list cannot be called.
- No state-changing method (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_*`,
  `miner_*`, `admin_*`) may enter the allowlist.

**Reasoning:** a generic passthrough would breach the keyless guarantee indirectly, through the
operator's own RPC credential, and would create an SSRF-style pivot point.

## 3. Secret handling

- A secret **value** is never written to a log, an evidence bundle, a crash report, telemetry, a
  browser bundle or an error message.
- A manifest holds the environment variable **name**; the value is resolved at runtime from the
  operator's secret provider.
- Real `.env` files, credential stores, shell history and the process environment are never read or
  printed, and a user is **never** asked to paste a secret.
- Research PDFs and their derivatives are covered by `.gitignore` and never enter the repository.

Expected secrets, read access only. The complete list with descriptions is in **`.env.example`**,
which is the single source of truth:

```
ICTT_SENTINEL_HOME_RPC_PRIMARY / _SECONDARY / _ARCHIVE
ICTT_SENTINEL_REMOTE_<NAME>_RPC_PRIMARY / _SECONDARY / _ARCHIVE
ICTT_SENTINEL_GLACIER_API_KEY          # optional, only raises a rate limit
ICTT_SENTINEL_WEBHOOK_SHARED_SECRET
ICTT_SENTINEL_SLACK_WEBHOOK_URL
ICTT_SENTINEL_PAGERDUTY_ROUTING_KEY
ICTT_SENTINEL_CONTROL_PLANE_URL / _TOKEN
POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD / DATABASE_URL
```

A manifest's `secretRef` field can only resolve names carrying the **`ICTT_SENTINEL_` prefix**,
which stops a manifest from pointing the resolver at an arbitrary process variable. No name
containing `PRIVATE_KEY`, `SIGNER_KEY`, `MNEMONIC`, `WALLET` or `KEYSTORE` resolves — not even
under the correct prefix.

## 4. Containers and distribution

- Containers run **rootless** with a **read-only filesystem**, all capabilities dropped and
  `no-new-privileges`.
- An **egress allowlist** option, so an agent can only reach the RPC and hosted endpoints it
  declares.
- Agent to hosted plane: **mTLS or a short-lived scoped token**.
- **Exact dependency pins** plus a committed lockfile; an SBOM; signed releases and images; a
  reproducible build.
- Package lifecycle scripts are inspected before installation and disabled by default in `.npmrc`.
- `sudo`, global installs, `curl | sh` and remote-code-executing `npx`/`pnpx` are **forbidden**.

## 5. Hosted plane

- **Tenant isolation**, least privilege, an append-only audit log, and a retention policy.
- Manifest and policy changes require **review and approval**.
- **Data minimisation** for PII and private RPC responses in evidence bundles.
- The hosted plane does not need raw private-L1 logs; the operator may choose a metadata-only mode,
  and `local-only` is the default.
- Idempotency key, payload hash, timestamp and replay protection on every ingest.

## 6. The alerting path

- **Webhook SSRF protection**: an alert target passes a scheme and host check, and egress to
  internal addresses (link-local, RFC1918, the cloud metadata endpoint) is refused.
- Alert payloads are checked for secret leakage; a notifier receives a sanitised summary, a reason,
  a severity, a freshness window and an evidence reference — never the bundle.
- **A webhook can write neither a verdict nor a canonical fact.** It is a latency hint only.
- A notifier failure never changes a verdict. An outage of Slack is an alerting incident, not
  evidence that a bridge is healthy.

## 7. Threat model — what is protected, and what is not

| Threat | Status | Approach |
| --- | --- | --- |
| Unauthorised remote registration / trusted-remote drift | **In scope** | `CFG-D02-UNAPPROVED-CANDIDATE`; candidate drift kept distinct from approval |
| Bytecode or proxy implementation drift | **In scope** | `CFG-D01-BASELINE-DRIFT`; unrecognised fingerprints fail closed |
| Unauthorised minter / allowlist drift | **In scope** | `CFG-N01-UNEXPECTED-MINTER-ROLE`, `CFG-N02-UNAUTHORISED-NATIVE-MINT` |
| Remote mint without corresponding home accounting | **In scope** | `ACC-A01-EXCESS-REMOTE-REPRESENTATION`, `ACC-A04-UNAUTHORISED-MINT` |
| Message delivered but never executed | **In scope** | Delivery and execution are separate states; `DELIVERED` is never `EXECUTED_SUCCESS` |
| RPC provider fault presented as health | **In scope** | Witness divergence and incomplete history resolve to `UNKNOWN` |
| Providers sharing an upstream failing together | **OUT OF SCOPE** | Observable, not preventable; the result is `UNKNOWN`, never a silent pass |
| A break in Warp or validator security | **OUT OF SCOPE** | See [`adr/0004-icm-assurance-scope.md`](adr/0004-icm-assurance-scope.md) |
| Abuse of admin or upgrade authority by its holder | **Partial** | The drift is visible; it cannot be prevented |
| Disclosure of the product's own secrets | **In scope** | §3, §4; target is zero incidents |
| Transitive shared provider or trust relationships | **In scope** | A linked failure domain counts as one witness, never two |
| An accepted block hash changing afterwards | **In scope** | Raised as an integrity incident; no rollback and no green verdict |
| Malicious API body, token or tenant traversal | **In scope** | Schema validation, auth, tenant grants, body and rate bounds, property tests |
| A checkpoint advancing past its committed facts | **In scope** | Facts and checkpoint share one transaction; asserted by crash and restart tests |
| Disk, outbox or notifier failure | **In scope** | The verdict is unchanged; delivery retries and health reports `degraded` |
| Build or dependency supply-chain drift | **In scope** | Exact lockfile, SCA, licence inventory, SBOM, checksums, reproducible build |
| CPU, memory or database resource exhaustion | **Partial** | Bounded locally; production capacity planning belongs to the operator |

Reason codes are defined in `packages/invariant-core/src/reasons.ts`; each carries its own runbook
reference. The operator-facing triage order is in [`RUNBOOK.md`](RUNBOOK.md).

## 8. Position on `teleporterV2` and issue #1443

`icm-contracts/avalanche/teleporterV2/` contains only `WarpAdapter.sol` and is **outside the
official audit scope**. `ava-labs/icm-services#1443` (2026-08-13, **open**, no assignee or pull
request) claims that missing caller authorisation in that file allows a forged TeleporterV2 payload
and an unauthorised remote mint.

**Our position:**

- This is **not presented as a confirmed production vulnerability.** The issue itself notes that the
  code may be unversioned, unaudited and out of scope.
- An unverified vulnerability claim is **never** used to create sales pressure.
- The product lesson stands regardless: **sender and origin authorisation, application payload
  validation and fingerprint checks come before any accounting alarm.**
- If a `teleporterV2` fingerprint is observed, the result is `UNSUPPORTED -> UNKNOWN`, never a silent
  `OK`.

## 9. Language and legal exposure

The words `proof of reserves`, `solvent`, `guaranteed`, `safe` and `tamper-proof` claim more than
the evidence supports.

**Language we use:**

- "Observed onchain coverage at pinned blocks"
- "Canonical ICTT accounting reconciled under stated assumptions"
- "Reported native supply upper bound is covered"
- "Evidence reproducible from the listed RPC and block references"

**Language we do not use:**

- "This token carries no risk"
- "We cryptographically proved the true total supply" (in a native context)
- "The alarm prevents every exploit"
- "Multi-RPC quorum is a Byzantine proof"

Reading `balanceOf` is evidence of onchain coverage. It is **not** evidence of legal
recoverability.

This is enforced, not merely intended: the alerting layer and the console both refuse to render
forbidden phrasing, and a test fails rather than a reviewer catching it.

## 10. Incident runbook summary

The full procedure is in [`INCIDENT_RUNBOOK.md`](INCIDENT_RUNBOOK.md). In outline:

### A CRITICAL accounting breach

1. Reproduce the alarm using the **block hash and a second independent RPC**.
2. **Separate a data-quality fault from an economic one.**
3. Extract the relevant transfer and message timeline.
4. Re-read home accounting, physical escrow and remote supply **at the pinned blocks**.
5. Check for fingerprint, upgrade, minter and admin drift.
6. Send the evidence to the operator, the security owner and the multisig runbook owner.
7. **Any pause or limit decision is made by humans through the multisig process. The sentinel does
   not sign.**
8. Archive the evidence bundle with its hash, the rule version and the incident note.

### An UNKNOWN data state

1. **Do not turn the status green.**
2. Check the RPC provider family and archive depth.
3. Replay the gap range against an alternative or archive RPC.
4. Resolve the reorg, finality and watermark position.
5. **Hold the economic verdict until the evidence is complete.**

## 11. Trust metrics

- Every rule carries a source-code or audit basis and the **date it was last reviewed**.
- The **fail-closed rate** on unrecognised fingerprints.
- Coverage of the rule regression corpus, and the five fault-lab release counters.
- The number of auditors and partners who accept the evidence schema.
- **Security incidents and secret exposures: target zero.**

## 12. Development environment: agent guardrails are not a sandbox

This repository carries permission rules for Claude Code in `.claude/settings.json` (details in
[`DEVELOPMENT.md`](DEVELOPMENT.md) §3). The file declares:

- `permissions.defaultMode: "default"` — every tool call goes through the normal approval path.
- `permissions.disableBypassPermissionsMode: "disable"` — the bypass mode cannot be turned on.
- `permissions.deny` — read rules covering `.env` files and their variants, `secrets/**`, `*.pem`,
  `*.key`, `~/.ssh/**`, `~/.aws/**` and the assistant's own credential file.
- `enableAllProjectMcpServers: false` — no MCP server is trusted implicitly.
- `attribution.commit`, `attribution.pr`, `attribution.sessionUrl` — assistant attribution is
  removed from anything that reaches Git or GitHub.

> **Project settings are NOT a real security sandbox.**

They are a **guardrail**: they reduce accidents, carelessness and unintended commands. They are not
an isolation boundary, not a trust boundary, and not a control against a motivated attacker.

The binding rules that follow from this:

- **Production credentials are never given to an assistant process.** Production RPC keys,
  control-plane tokens and customer data are not exposed to an agent session running against this
  repository. Development uses testnet or local credentials only.
- The presence of a `deny` rule does not **prove** a file is unreachable; it prevents reading it
  through the normal tool path.
- Where real isolation is required, use a devcontainer, a separate user account or a separate
  machine. Weakening a setting is never the answer to a missing capability.
- The settings are themselves an attack surface. Writes to `.claude/**` require human approval, and
  every change in the direction of relaxation is reviewed.

This distinction is held to the same honesty standard as the product's own trust boundary in §7: we
do not present a guarantee we are not providing.
