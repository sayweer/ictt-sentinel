# Contributing

Thank you for looking at `ictt-sentinel`.

Setup and day-to-day commands are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). The binding
security and working rules are in [`CLAUDE.md`](CLAUDE.md); this guide does not repeat them.

Before anything else, please read [the security promise](SECURITY.md#the-invariant-security-promise).
It is the one rule with no exceptions: **this tool never signs, never submits a transaction, and
cannot stop a bridge.** A contribution that weakens that promise is rejected regardless of how
useful it appears.

---

## 1. What a good contribution looks like

The most valuable contributions to a tool like this are, roughly in order:

1. **A scenario it gets wrong.** A case where the product reports `OK` and should not, or reports
   `CRITICAL` and should not. Add it to the fault lab (§4) with its provenance.
2. **A source-locked correction.** Contract semantics we read incorrectly, cited against the pinned
   upstream commit in [`docs/PROTOCOL_SOURCE_LOCK.md`](docs/PROTOCOL_SOURCE_LOCK.md).
3. **A tightened boundary.** A gate that can be bypassed, or a check that passes vacuously.
4. **Operator documentation.** A runbook step that does not work in practice.

Feature requests that widen the claim surface — new asset modes, new protocol families, automated
intervention — need an ADR (§8) before code.

## 2. Before you open a pull request

Run the gates. Not "it looked fine locally" — actually run them:

```bash
pnpm install --frozen-lockfile
pnpm run verify        # the full cumulative gate
pnpm run lab           # the deterministic fault lab and its release counters
git diff --check
```

`pnpm run verify` needs a PostgreSQL instance for the integration suite. There is no mock path and
no skip path; see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the local container.

In the pull request description, state:

- what changed and why, in one paragraph;
- the exact commands you ran and their exit codes;
- anything you could not verify, and why.

An honest "I could not run the container smoke on this machine" is worth more than silence.

## 3. Diff discipline

- **Surgical changes only.** Touch what the change requires and nothing else.
- Do not refactor what is not broken. Leave neighbouring comments, formatting and unrelated code
  alone.
- Match the surrounding style. You might write it differently; the existing structure wins.
- Clean up orphans **your** change created — an import, variable or function it left unused. Do not
  remove pre-existing dead code: mention it instead.
- The test for every line: can it be traced directly to the stated purpose of the change? If not,
  remove it.
- Preserve existing work. No overwriting, no automatic rollback, no bulk rewrite.

## 4. Tests and gates

Details: [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md).

Non-negotiable:

- Deleting a test, `skip`, `only`, `|| true`, a silent fallback, or a mock added to make a gate go
  green is **forbidden**.
- **A test that did not run is not a pass.** A skipped test is not a pass.
- TypeScript strictness is never lowered. `@ts-ignore` and `@ts-expect-error` need a written reason.
- Every new invariant rule needs at least one **positive and one negative** fixture.

### The fault lab

`tests/lab/` holds the adversarial corpus: each scenario is a hostile or degraded condition, carried
as data with its provenance, pinned inputs, and expected protocol status, data status, reason codes,
exit code and digest rule. It drives the real engines; a scenario that stubbed the code under test
would only prove the stub agrees with itself.

Five counters gate a release, and all five must be zero:

| Counter | Meaning |
| --- | --- |
| False negatives | A proven breach the product did not call |
| False OKs | Anything green in the gap, RPC, fingerprint or unsupported corpora |
| Digest drift | The same pinned input producing a different verdict or digest twice |
| Forbidden surface | Any signing, chain-write or auto-pause surface in the repository |
| Secret canary leak | A planted credential reaching any outbound surface |

If you fix a bug, add the scenario that would have caught it.

## 5. Architecture boundaries

- Dependencies point **inward only**. The permitted edges are declared in each `package.json` under
  `ictt-sentinel.mayDependOn` and enforced by `pnpm run verify:config` and
  `pnpm run boundaries:check`.
- `domain`, `invariant-core` and `state-machine` stay **pure**: no network, no database, no
  `process.env`, no framework, no wall-clock, no randomness. Time and randomness are injected.
- **Applications never copy a business rule.** Rules live in `invariant-core`; an application calls
  them.
- A new package must declare `ictt-sentinel.layer` and `mayDependOn`.

## 6. Dependencies

- **Exact pins are mandatory.** `^`, `~`, `latest` and `*` are rejected by the gate. The lockfile is
  committed.
- A new dependency is a review topic: why it is needed, what the alternative is, its maintenance
  status, its transitive weight, and its licence.
- **Install lifecycle scripts are inspected before installation.** `.npmrc` keeps them disabled.
- Every SDK or dependency upgrade needs an **ADR and tests**
  ([`docs/PROTOCOL_SOURCE_LOCK.md`](docs/PROTOCOL_SOURCE_LOCK.md) §7).
- Global installs, `curl | sh`, and remote-code-executing `npx`/`pnpx` are not used.
- `pnpm run verify:supply-chain` regenerates the SBOM and licence inventory and compares them
  against the committed artifacts. If your change touches dependencies, run
  `pnpm run supply-chain:write` and commit the result.

Licences must be permissive. Copyleft is accepted only when scoped to a build-time package that
reaches no shipped artifact, recorded explicitly in `scripts/verify-supply-chain.mjs` with its
reasoning.

## 7. Database migrations

- A schema change arrives as its own migration file. An applied migration is **immutable**: if the
  file changes, the runner raises a drift error rather than repairing the checksum, because the
  database has already taken the old shape.
- **The append-only ledger is never broken.** An orphaned record is marked `orphaned`, not deleted,
  and derived state is rolled back instead.
- No column carrying a token amount may be `DOUBLE PRECISION` or any other float type.
- Event identity is at least `(chainKey, blockHash, txHash, logIndex)`.
- If a migration risks data loss, say so explicitly in the pull request and record it in
  [`docs/DECISIONS.md`](docs/DECISIONS.md).

## 8. Architecture decision records

Write an ADR when a decision:

- is expensive to reverse (architecture, truth anchor, trust boundary);
- changes a security or evidence limit;
- affects a dependency version, an SDK, or the source lock;
- will prompt someone to ask "why was it done this way?" later.

File: `docs/adr/NNNN-kebab-title.md`. Sections: **Context → Decision → Reasoning → Consequences
(accepted benefit and accepted cost) → Alternatives and why they were rejected → Review trigger.**

Add the new ADR to the [`docs/DECISIONS.md`](docs/DECISIONS.md) index. Do not edit an accepted ADR:
write a new one and mark the old one `Superseded`.

## 9. Commits

- This repository does **not** require conventional commits. A message that is meaningful and
  describes the change honestly is enough.
- One logical change per commit.
- **No automated-tool attribution.** Commit messages, pull requests, tags and release notes must not
  carry co-author or "generated with" trailers for an AI assistant. This is a standing project rule.
- Review `git status` before committing. If you see anything that could be a credential, open it and
  check.

## 10. Language and claim hygiene

The only thing this product has to sell is that **it does not manufacture false certainty.** That
applies to code, documentation, log lines and UI text alike.

**Never used:** `proof of reserves`, `solvent`, `guaranteed`, `safe`, `tamper-proof`, `exact supply`
in a native context, or "multi-RPC quorum is a Byzantine proof".

**Used instead:** "observed onchain coverage at pinned blocks", "reconciled under stated
assumptions", "reported native supply upper bound is covered", "evidence reproducible from the
listed RPC and block references".

Two rules with no exceptions:

- `UNKNOWN` is never rendered as `OK`, healthy or green, anywhere.
- A rate or volume anomaly is never presented under a collateral heading.

The console and the alerting layer both assert this mechanically: forbidden phrasing fails a test
rather than a review.

## 11. Formatting

- Prettier configuration is in `.prettierrc.json`. Markdown is listed in `.prettierignore` because
  the tables in these documents are hand-aligned and should not be reflowed.
- `.editorconfig` enforces LF, UTF-8 and two-space indentation.
- Avoid invisible characters. A narrow no-break space once reached a formatting helper here and was
  caught only by a test; where a non-obvious character is genuinely needed, write it as an escape.

## 12. How this repository is developed

The history is organised as numbered milestones, each closing with a report in `docs/milestones/`
that records the exact commands, their exit codes, the acceptance criteria one by one, the decisions
taken and the risks left open. That structure explains the shape of the repository and is the best
place to understand why something is the way it is.

You do not need to follow that process to contribute. A focused pull request against `main`, with
the gates run and the results stated, is exactly right.

## 13. Licence

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the same licence as the project.
