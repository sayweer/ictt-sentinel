# Security Policy

This file covers **vulnerability disclosure**.

The threat model, the reasoning behind the keyless architecture, secret handling and the incident
runbook live in [`docs/SECURITY.md`](docs/SECURITY.md), which is the single source of truth for
those topics. This file does not repeat them.

---

## Project status

`ictt-sentinel` is a **technical preview**. There is no tagged release, no published package and no
hosted service. This policy is in force regardless, because the repository itself — configuration,
settings, documentation and CI — is an attack surface.

## Supported versions

| Version | Status | Security fixes |
| --- | --- | --- |
| `main` | Active development | Yes |
| Tagged release | None yet | — |

This table is updated at the first tagged release. Until a versioning policy is published, only
`main` is supported.

## Reporting a vulnerability

**Please do not open a public issue for a security report.**

Use a private channel:

1. **Preferred** — GitHub Security Advisories: *Security → Report a vulnerability* on this
   repository.
2. Otherwise, contact the repository owner directly and privately.

Never include live credentials, production RPC URLs or customer data in a report. A redacted
reproduction is always sufficient; if it is not, say so and we will arrange a channel.

### Report template

```
Summary:
  The issue in one sentence.

Affected component:
  File, package or setting path, plus a commit SHA if known.

Class:
  [ ] Keyless guarantee broken (signer or chain-write surface)
  [ ] RPC allowlist bypass or generic passthrough
  [ ] Secret disclosure (log, evidence bundle, error message, telemetry)
  [ ] Incorrect verdict (UNKNOWN presented as OK, or any fail-open path)
  [ ] Evidence integrity (reproducibility lost, hash collision or mismatch)
  [ ] Alerting path (webhook SSRF, payload disclosure)
  [ ] Supply chain (dependency, lifecycle script, container image)
  [ ] Other:

Impact:
  What does an attacker gain?
  Specifically: can this produce a false GREEN verdict?

Reproduction:
  Minimal steps. Where relevant, include pinned block references and the
  manifest/policy hash rather than live endpoints.

Environment:
  Version or commit, Node version, platform.

Suggested fix (optional):
```

### Response targets

| Step | Target |
| --- | --- |
| Acknowledgement of receipt | 3 business days |
| Initial assessment and triage | 10 business days |
| Fix plan, or a reasoned decision not to fix | 30 days |
| Coordinated disclosure | After the fix, agreed with the reporter |

These are **targets, not a service level agreement**. The project is not in production and carries
no commercial support commitment.

## Scope

### In scope

- Any breach of the keyless guarantee: a signer, a private key, `sendTransaction`, or any other
  chain-write surface.
- Bypassing the query-only RPC allowlist, or introducing a generic `request(method, params)`
  surface.
- A secret reaching a log, an evidence bundle, a crash report, telemetry, a browser bundle or the
  repository.
- **Fail-open behaviour**: `UNKNOWN` presented as `OK` or healthy, an unrecognised fingerprint
  passing silently, or a stale result reported as current.
- Breaking evidence reproducibility, or producing two different inputs that yield one content hash.
- SSRF on the alerting path, or secret disclosure through an alert payload.
- A webhook influencing a fact, a checkpoint or a verdict rather than only collection order.
- Tenant isolation failure in the hosted API.
- Supply chain: dependency integrity, install lifecycle scripts, container image provenance.
- Bypassing the guardrails declared in `.claude/settings.json`.

### Out of scope

The following are **deliberate design limits**, documented and tested as such. They are not
vulnerabilities (see [`docs/SECURITY.md`](docs/SECURITY.md) §7 and
[`docs/adr/0004-icm-assurance-scope.md`](docs/adr/0004-icm-assurance-scope.md)):

- RPC providers that share an upstream returning the same wrong answer **together**. Quorum counts
  independent trust domains; it is not a cryptographic or Byzantine guarantee, and this repository
  never claims otherwise.
- A break in Warp, ICM or validator protocol security. This tool observes a protocol; it does not
  replace its security.
- Abuse of admin, minter or proxy-upgrade authority by its **legitimate holder**.
- The absence of automatic intervention. There is **no auto-pause and no circuit breaker**, by
  design; a scan asserts that no such surface exists anywhere in the repository.
- The absence of independent BLS aggregate signature or predicate verification
  (`INDEPENDENT_ICM_VERIFICATION` = `UNSUPPORTED`).
- Vulnerabilities in third-party RPC providers, PostgreSQL or Docker themselves.
- Social engineering, physical access, and denial of service.

## The invariant security promise

**This tool does not sign, does not submit transactions, and cannot stop a bridge.**

- It never holds or requests a private key, mnemonic, seed, wallet or keystore.
- There is no `sendTransaction` and no chain-write surface of any kind.
- It never calls mint, burn, retry, pause or upgrade, and it has no auto-pause.
- No state-changing JSON-RPC method may be added to the allowlist.

This is an architectural decision, not a configuration choice:
[`docs/adr/0001-keyless-read-only.md`](docs/adr/0001-keyless-read-only.md). **A contribution that
breaks this promise is rejected regardless of how useful it appears.**

It is enforced mechanically rather than by review alone. `pnpm run boundaries:check` scans the whole
repository for signing and chain-write surfaces, and `pnpm run lab` reports a forbidden-surface
counter that must be zero for the release gate to pass.

The presence of these environment variables is a **build error**, not a warning:

```
BRIDGE_PRIVATE_KEY   MINTER_PRIVATE_KEY   PAUSER_PRIVATE_KEY   MULTISIG_SIGNER_KEY
```

## Repository guardrails are not a sandbox

The permission rules in `.claude/settings.json` are a **guardrail**: they reduce accidents and
carelessness during AI-assisted development. They are **not an isolation boundary and not a
security sandbox.**

Consequently:

- **Production credentials are never given to an assistant process.** Production RPC keys,
  control-plane tokens and customer data are not exposed to an agent session running against this
  repository.
- Development uses testnet or local credentials only.
- The presence of a deny rule does not **prove** a file is unreachable; it prevents reading it
  through the normal tool path.
- Where real isolation is required, use a devcontainer, a separate user account or a separate
  machine.

## Upstream issue tracking

This project **observes** a third-party contract family. External issues we track, and our position
on each, are recorded in [`docs/PROTOCOL_SOURCE_LOCK.md`](docs/PROTOCOL_SOURCE_LOCK.md) §8 and
[`docs/SECURITY.md`](docs/SECURITY.md) §8.

An unverified external claim is never presented here as a confirmed production vulnerability, and is
never used as a sales argument.
