import { replayOffline, type ReplayCursor } from './offline-replay.js';
import { buildIdentity, sourceLockHash } from './identity.js';
import { aggregate } from '@ictt-sentinel/invariant-core';
import {
  buildBundle,
  hashCore,
  renderHtml,
  verifyBundle,
  assertBundleShareable,
  type EvidenceBundle,
} from '@ictt-sentinel/evidence';
import {
  QUICKSTART_SCENARIOS,
  SCENARIO_SUMMARY,
  quickstartAggregation,
  quickstartBundleDraft,
  type QuickstartScenario,
} from '@ictt-sentinel/testkit';
import { EXIT, type ExitCode, exitCodeForVerdict } from './exit-codes.js';
import { emitHuman, emitJson, type Writer } from './output.js';
import { writeAtomic } from './atomic-write.js';

/**
 * Command implementations.
 *
 * Every command returns an exit code rather than calling `process.exit`, so the
 * whole surface is testable in-process and a Ctrl-C in the middle cannot leave a
 * half-finished side effect behind an early exit.
 *
 * There is no signer, no transaction sender, no pause and no retry here, and no
 * argument that could add one.
 */

export interface CommandContext {
  readonly writer: Writer;
  readonly json: boolean;
  readonly evidenceDir: string;
  readonly version: string;
  readonly isTty: boolean;
}

const isScenario = (s: string): s is QuickstartScenario =>
  (QUICKSTART_SCENARIOS as readonly string[]).includes(s);

/** `init` - never asks for, prints or stores a secret. */
export const init = (ctx: CommandContext): ExitCode => {
  const guidance = {
    createdNothing: true,
    next: [
      'Copy .env.example to .env.local and fill it in with your own editor.',
      'This tool never reads, writes, prints or asks for a secret value.',
      'A manifest records the NAME of an environment variable, never its value.',
      'Run: ictt-sentinel doctor  (checks presence, not values)',
    ],
    envExample: '.env.example',
  };
  if (ctx.json) emitJson(ctx.writer, 'init', guidance);
  else {
    emitHuman(ctx.writer, 'ictt-sentinel init');
    emitHuman(ctx.writer, '  No files were written and no secret was requested.');
    for (const line of guidance.next) emitHuman(ctx.writer, `  - ${line}`);
  }
  return EXIT.ok;
};

/**
 * `discover` - produces a CANDIDATE draft and a diff.
 *
 * It never writes over an approved manifest. Discovery is not approval: a
 * permissionlessly registered remote showing up on chain says nothing about
 * whether the operator trusts it (docs/DATA_MODEL.md 3.3).
 */
export const discover = (ctx: CommandContext, scenario: string | null = null): ExitCode => {
  if (scenario !== null && !isScenario(scenario)) return unknownScenario(ctx, scenario);
  const draft = scenario === null ? null : quickstartBundleDraft(scenario);
  const result = {
    approvedManifestModified: false,
    mode: scenario === null ? 'unconfigured' : 'fictional-offline-fixture',
    candidateDraft:
      draft === null
        ? null
        : {
            deploymentId: draft.core.deploymentId,
            baseline: { state: 'candidate' },
            observedChains: draft.core.chains,
            registeredRemotes: draft.core.census.registeredRemotes,
          },
    diff: { added: draft?.core.census.registeredRemotes ?? [], removed: [], changed: [] },
    missing: [
      'A reviewed deployment manifest and live registration collector are required for production discovery.',
    ],
    note: 'Candidates require explicit operator review. This command cannot approve one. The draft is a discovery projection, not an importable deployment manifest.',
    exitCode: EXIT.requiredUnknown,
  };
  if (ctx.json) emitJson(ctx.writer, 'discover', result);
  else emitHuman(ctx.writer, JSON.stringify(result));
  return EXIT.requiredUnknown;
};

/** `doctor` - readiness, reported as presence only. Never a secret value. */
export const doctor = (
  ctx: CommandContext,
  env: Readonly<Record<string, string | undefined>>,
): ExitCode => {
  const required = [
    'ICTT_SENTINEL_HOME_RPC_PRIMARY',
    'ICTT_SENTINEL_HOME_RPC_SECONDARY',
    'DATABASE_URL',
  ];
  const checks = [
    ...required.map((name) => ({
      check: `env:${name}`,
      // Presence only. The value is never read into the report, logged or hashed.
      status: env[name] === undefined || env[name] === '' ? 'missing' : 'present',
      detail: 'presence only; the value is never displayed',
    })),
    { check: 'chain-identity', status: 'unknown', detail: 'requires a configured endpoint' },
    {
      check: 'provider-independence',
      status: 'unknown',
      detail: 'needs >= 2 distinct provider groups',
    },
    { check: 'finality-policy', status: 'unknown', detail: 'accepted-quorum semantics per chain' },
    {
      check: 'archive-history',
      status: 'unknown',
      detail: 'archive witness must be declared in policy',
    },
    { check: 'fingerprint', status: 'unknown', detail: 'runtime code hash is operator-attested' },
    { check: 'database', status: 'unknown', detail: 'run migrations before first evaluation' },
  ];
  const anyMissing = checks.some((c) => c.status === 'missing');

  if (ctx.json) emitJson(ctx.writer, 'doctor', { checks, ready: false, telemetry: false });
  else {
    emitHuman(ctx.writer, 'ictt-sentinel doctor');
    for (const c of checks) emitHuman(ctx.writer, `  [${c.status}] ${c.check} - ${c.detail}`);
  }
  // A missing prerequisite is a configuration problem, not a verdict.
  return anyMissing ? EXIT.invalidConfig : EXIT.requiredUnknown;
};

/** `replay` - bounded, resumable, pinned. Offline against a fixture here. */
export const replay = (
  ctx: CommandContext,
  scenario: string,
  cursor: ReplayCursor = { maxFacts: 100, resume: false },
): ExitCode => {
  const evaluated = check({ ...ctx, json: false, writer: silentWriter }, scenario);
  if (typeof evaluated === 'number') return evaluated;
  const progress = replayOffline(evaluated.bundle, ctx.evidenceDir, cursor);
  const exitCode = progress.complete ? evaluated.exitCode : EXIT.requiredUnknown;
  const result = {
    scenario,
    mode: 'fictional-offline-fixture',
    pinnedBlocks: evaluated.bundle.core.chains,
    contentHash: evaluated.bundle.contentHash,
    ...progress,
    exitCode,
  };
  if (ctx.json) emitJson(ctx.writer, 'replay', result);
  else emitHuman(ctx.writer, JSON.stringify(result));
  return exitCode;
};

export interface CheckResult {
  readonly exitCode: ExitCode;
  readonly bundle: EvidenceBundle;
}

/** `check` - evaluate and produce the verdict, without writing anything. */
export const check = (ctx: CommandContext, scenario: string): CheckResult | ExitCode => {
  if (!isScenario(scenario)) return unknownScenario(ctx, scenario);

  const verdict = aggregate(quickstartAggregation(scenario));
  const draft = quickstartBundleDraft(scenario);
  const bundle = buildBundle({
    ...draft,
    core: {
      ...draft.core,
      producer: buildIdentity(),
      sourceLock: { ...draft.core.sourceLock, sourceLockHash: sourceLockHash() },
    },
    presentation: { ...draft.presentation, toolVersion: ctx.version },
  });
  const exitCode = exitCodeForVerdict(verdict);

  if (ctx.json) {
    emitJson(ctx.writer, 'check', {
      assuranceMode: bundle.core.assurance.assuranceMode,
      deploymentId: bundle.core.deploymentId,
      protocolStatus: verdict.protocolStatus,
      dataStatus: verdict.dataStatus,
      claimMode: verdict.claimMode,
      coverage: verdict.coverage,
      reasonCodes: verdict.reasonCodes,
      criticalRuleIds: verdict.criticalRuleIds,
      unknownRuleIds: verdict.unknownRuleIds,
      contentHash: bundle.contentHash,
      exitCode,
    });
  } else {
    emitHuman(ctx.writer, `ictt-sentinel check --fixture ${scenario}`);
    emitHuman(ctx.writer, `  assurance_mode  : ${bundle.core.assurance.assuranceMode}`);
    emitHuman(ctx.writer, `  protocol_status : ${verdict.protocolStatus}`);
    emitHuman(ctx.writer, `  data_status     : ${verdict.dataStatus}`);
    emitHuman(ctx.writer, `  claim_mode      : ${verdict.claimMode}`);
    emitHuman(ctx.writer, `  coverage        : ${verdict.coverage}`);
    emitHuman(ctx.writer, `  reasons         : ${verdict.reasonCodes.join(', ') || 'none'}`);
    if (verdict.unknownRuleIds.length > 0) {
      // Reported even beside a CRITICAL: other checks being blind matters too.
      emitHuman(ctx.writer, `  also unresolved : ${verdict.unknownRuleIds.join(', ')}`);
    }
  }
  return { exitCode, bundle };
};

/** `evidence export` - atomic, restrictive, secret-free or it does not write. */
export const evidenceExport = (ctx: CommandContext, scenario: string): ExitCode => {
  const result = check({ ...ctx, json: false, writer: silentWriter }, scenario);
  if (typeof result === 'number') return result;

  // Refuses rather than scrubs: a bundle that needed scrubbing was built wrong.
  assertBundleShareable(result.bundle);

  const json = `${JSON.stringify(result.bundle, null, 2)}\n`;
  const written = writeAtomic(ctx.evidenceDir, `${scenario}.evidence.json`, json);
  const html = writeAtomic(ctx.evidenceDir, `${scenario}.evidence.html`, renderHtml(result.bundle));

  if (ctx.json) {
    emitJson(ctx.writer, 'evidence export', {
      contentHash: result.bundle.contentHash,
      files: [written.path, html.path],
      bytes: written.bytes,
    });
  } else {
    emitHuman(ctx.writer, `wrote ${written.path}`);
    emitHuman(ctx.writer, `wrote ${html.path}`);
    emitHuman(ctx.writer, `content hash ${result.bundle.contentHash}`);
  }
  // Exporting evidence reports the verdict it contains, not merely "written".
  return result.exitCode;
};

/** `evidence verify` - re-run the engine offline and compare. */
export const evidenceVerify = (
  ctx: CommandContext,
  bundle: EvidenceBundle,
  scenario: string | null,
): ExitCode => {
  if (scenario !== null && !isScenario(scenario)) return unknownScenario(ctx, scenario);
  const replayInputs =
    scenario !== null && isScenario(scenario)
      ? { aggregation: quickstartAggregation(scenario) }
      : null;
  const result = verifyBundle(bundle, replayInputs);

  if (ctx.json) {
    emitJson(ctx.writer, 'evidence verify', {
      verified: result.verified,
      findings: result.findings,
      recomputedHash: result.recomputedHash,
      trustBoundary: result.trustBoundary,
    });
  } else {
    emitHuman(ctx.writer, result.verified ? 'verified' : 'NOT verified');
    for (const f of result.findings) emitHuman(ctx.writer, `  ${f.failure}: ${f.detail}`);
    emitHuman(ctx.writer, 'What this does NOT establish:');
    for (const t of result.trustBoundary) emitHuman(ctx.writer, `  - ${t}`);
  }
  return result.verified ? exitCodeForVerdict(bundle.core.verdict) : EXIT.requiredUnknown;
};

/** Recompute a bundle's hash without trusting the one it carries. */
export const recomputeHash = (bundle: EvidenceBundle): string => hashCore(bundle.core);

const silentWriter: Writer = { out: () => undefined, err: () => undefined };

const unknownScenario = (ctx: CommandContext, scenario: string): ExitCode => {
  emitHuman(
    ctx.writer,
    `unknown fixture ${JSON.stringify(scenario)}; expected one of: ${QUICKSTART_SCENARIOS.join(', ')}`,
  );
  if (ctx.json)
    emitJson(ctx.writer, 'error', { error: 'unknown-fixture', exitCode: EXIT.invalidConfig });
  for (const s of QUICKSTART_SCENARIOS) emitHuman(ctx.writer, `  ${s}: ${SCENARIO_SUMMARY[s]}`);
  return EXIT.invalidConfig;
};
