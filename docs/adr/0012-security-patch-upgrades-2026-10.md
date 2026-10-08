# ADR-0012 — Security patch upgrades for advisories published after the lock

- **Status:** `ACCEPTED`
- **Date:** 2026-10-09
- **Milestone:** 17
- **Related:** ADR-0005 (toolchain), ADR-0008 (hosted API stack), `scripts/verify-supply-chain.mjs`

## Context

`verify:supply-chain` failed with the lockfile unchanged: advisories were published after the
last green run. The gate offers no suppression, so the only way through is to remove the
vulnerable versions.

| Package | Locked | Advisory | Severity | Fixed in | Reached through |
|---|---|---|---|---|---|
| `brace-expansion` | 5.0.9 | GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr | high, high, moderate | 5.0.12 | `eslint` > `minimatch` (dev) |
| `source-map-js` | 1.2.1 | GHSA-68fv-2mgg-jv7q | high | 1.2.2 | `vite` > `postcss`, `@vitest/coverage-v8` > `magicast` (dev) |
| `fastify` | 5.12.3 | GHSA-4mh8-r7rc-xpvc | moderate | 5.12.5 | `apps/api` (runtime, direct) |
| `fast-uri` | 3.1.7, 4.1.4 | GHSA-hrr3-gc8f-f4qj, GHSA-jvvf-x445-j334 | moderate | 3.1.8, 4.1.5 | `fastify` > `ajv` / `fast-json-stringify` (runtime) |

## Decision

1. **`fastify` 5.12.3 → 5.12.5**, exact pin in `apps/api/package.json`. Patch release with an
   identical dependency set.
2. **Transitive packages are re-resolved inside their parents' existing ranges**
   (`minimatch` `^5.0.8`, `postcss`/`magicast` `^1.2.1`, `ajv` `^3.0.1`,
   `fast-json-stringify`/`@fastify/ajv-compiler` `^4.0.0`). No `overrides`, no parent upgrade, no
   new direct dependency. pnpm takes the newest version in range, which may be above the minimum
   fixed version; the lockfile records exactly what was taken.
3. **Lifecycle review:** none of the new versions declares `preinstall`/`install`/`postinstall`.
   `brace-expansion` declares `prepare`, which a registry install does not run; installs use
   `--ignore-scripts` regardless.
4. SBOM, license inventory and release checksums are regenerated from the lockfile.

## Consequences

- The supply-chain gate is green again without suppressing anything.
- The hosted API runs on a patched `fastify`; its contract is covered by the existing API tests
  and the integration suite.
- Advisories keep arriving against unchanged lockfiles. This gate will go red again without a code
  change, and that is intended: it is the only place the repository learns about them.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Ignore or suppress the advisories | The gate deliberately offers no suppression (CLAUDE.md 7). |
| `pnpm.overrides` for the transitive packages | Not needed: every parent range already admits the fixed version. An override would outlive the reason for it. |
| Upgrade `eslint`/`vite`/`vitest` to newer releases | A larger change than the advisories require. |
