import { resolve } from 'node:path';
import {
  ConfigError,
  loadManifest,
  loadPolicy,
  type LoadedDocument,
  type Manifest,
  type Policy,
} from '@ictt-sentinel/config';
import { PINNED_COMMIT_SHA } from '@ictt-sentinel/ictt-adapters';
import {
  assertBundleShareable,
  buildBundle,
  canonicalStringify,
  decodeReplayInput,
  renderHtml,
  replayEvaluation,
  verifyBundle,
  type EvidenceBundle,
} from '@ictt-sentinel/evidence';
import { run, parseArgs, type RunOptions } from './run.js';
import { EXIT, exitCodeForVerdict, type ExitCode } from './exit-codes.js';
import { emitHuman, emitJson } from './output.js';
import { buildIdentity, sourceLockHash } from './identity.js';
import { writeAtomic } from './atomic-write.js';
import { replayOffline, InvalidCheckpointError } from './offline-replay.js';
import {
  createRuntime,
  decodePins,
  InputError,
  readDocument,
  type Pin,
  type Runtime,
} from './runtime.js';
import { deployments, doctorConfigured, witnessId } from './doctor.js';
import { discoverConfigured } from './discovery.js';

/** Bind observations to the actual reviewed files, never merely a claimed digest. */
export const bindBundle = (
  bundle: EvidenceBundle,
  manifest: LoadedDocument<Manifest>,
  policy: LoadedDocument<Policy>,
  pins: readonly Pin[] | null,
): readonly string[] => {
  const faults: string[] = [];
  const require = (ok: boolean, reason: string) => {
    if (!ok) faults.push(reason);
  };
  const { core } = bundle;
  const { context: input, native } = decodeReplayInput(core.replay.input);
  const m = manifest.value;
  require(m.spec.baseline.state === 'approved', 'approved-baseline-required');
  require(core.baseline.manifestHash === manifest.digest &&
    core.baseline.policyHash === policy.digest, 'configuration-digest-mismatch');
  require(core.deploymentId === m.metadata.name, 'deployment-identity-mismatch');
  require(core.sourceLock.commitSha === PINNED_COMMIT_SHA &&
    core.sourceLock.sourceLockHash === sourceLockHash(), 'source-lock-mismatch');
  require((native === null ? 'canonical-erc20' : 'native') ===
    m.spec.asset.mode, 'asset-mode-mismatch');
  require(core.quorum.requiredGroups >=
    policy.value.spec.quorum.minIndependentTrustDomains, 'policy-quorum-mismatch');
  require(core.chains.length === 1 + m.spec.remotes.length, 'chain-roster-mismatch');
  const observed = Date.parse(core.completeness.observedAt),
    expires = Date.parse(core.completeness.expiresAt);
  require(expires > observed &&
    expires - observed <=
      policy.value.spec.evidence.expiresAfterSeconds * 1000, 'policy-expiry-mismatch');
  for (const { chain, contract } of deployments(m)) {
    const pin = core.chains.find((c) => c.blockchainId === chain.blockchainId);
    require(pin !== undefined &&
      pin.evmChainId === String(chain.evmChainId) &&
      BigInt(pin.blockNumber) >= BigInt(contract.deploymentBlock), 'chain-pin-mismatch');
    require(core.quorum.requiredGroups >=
      chain.quorum.independentTrustDomains, 'chain-quorum-mismatch');
    if (pin)
      require(observed / 1000 >= Number(pin.blockTimestamp) &&
        observed / 1000 - Number(pin.blockTimestamp) <=
          policy.value.spec.evidence.maxAgeSeconds, 'pin-observation-age-mismatch');
    const fp = core.fingerprints.find(
      (f) => f.blockchainId === chain.blockchainId && f.address === contract.address,
    );
    require(fp !== undefined &&
      fp.recognised &&
      fp.role === contract.role &&
      fp.runtimeCodeHash === contract.fingerprint.runtimeCodeHash &&
      (fp.implementationAddress ?? undefined) === contract.proxy.implementation &&
      (fp.proxyAdmin ?? undefined) === contract.proxy.admin &&
      (contract.proxy.kind === 'beacon' ? fp.beacon !== null : fp.beacon === null) &&
      (fp.implementationCodeHash === null ||
        contract.fingerprint.allowedImplementationHashes.includes(
          fp.implementationCodeHash,
        )), 'approved-fingerprint-mismatch');
    for (const vote of core.quorum.votes.filter((v) => v.blockchainId === chain.blockchainId))
      require(chain.endpoints.some(
        (ep) =>
          witnessId(m.metadata.name, ep.id) === vote.endpointId &&
          ep.trustDomain === vote.trustDomain &&
          ep.providerGroup === vote.providerGroup,
      ), 'witness-identity-mismatch');
  }
  require(input.remotes.length === m.spec.remotes.length, 'remote-roster-mismatch');
  for (const r of input.remotes)
    require(m.spec.remotes.some(
      (approved) =>
        approved.chain.blockchainId === r.remoteBlockchainId &&
        approved.tokenRemote.address === r.remoteAddress &&
        approved.tokenRemote.expectedDecimals === r.scale.remoteDecimals &&
        m.spec.asset.homeDecimals === r.scale.homeDecimals,
    ), 'remote-scale-or-address-mismatch');
  if (pins !== null)
    require(pins.length === core.chains.length &&
      pins.every((p) =>
        core.chains.some(
          (c) =>
            c.blockchainId === p.blockchainId &&
            c.blockNumber === p.blockNumber &&
            c.blockHash === p.blockHash,
        ),
      ), 'requested-pin-mismatch');
  return faults;
};

export const runAsync = async (
  options: RunOptions,
  signal: AbortSignal = new AbortController().signal,
  injected?: Runtime,
): Promise<ExitCode> => {
  // Legacy fictional commands and independent offline verification remain usable without config.
  if (!options.argv.some((a) => ['--manifest', '--policy', '--pins', '--offline'].includes(a)))
    return run(options);
  const values = new Map<string, string>();
  const rest: string[] = [];
  let offline = false;
  const json = options.argv.includes('--json');
  const output = (command: string, value: object) => {
    if (json) emitJson(options.writer, command, value);
    else emitHuman(options.writer, JSON.stringify(value));
  };
  try {
    for (let i = 0; i < options.argv.length; i++) {
      const a = options.argv[i];
      if (a === '--offline') {
        if (offline) throw new InputError();
        offline = true;
      } else if (a !== undefined && ['--manifest', '--policy', '--pins'].includes(a)) {
        const value = options.argv[++i];
        if (values.has(a) || value === undefined || value.startsWith('-')) throw new InputError();
        values.set(a, value);
      } else if (a !== undefined) rest.push(a);
    }
    const args = parseArgs(rest);
    if (
      args.unknownFlags.length ||
      args.fixture !== null ||
      args.help ||
      args.version ||
      !['check', 'replay', 'discover', 'doctor', 'evidence'].includes(args.command) ||
      (args.command === 'evidence' && args.sub !== 'export') ||
      (args.command === 'doctor' &&
        (offline || args.file !== null || args.resume || args.maxFacts !== 100))
    )
      throw new InputError();
    const manifestPath = values.get('--manifest'),
      policyPath = values.get('--policy');
    if (!manifestPath || !policyPath) throw new InputError();
    const manifest = loadManifest(readDocument(manifestPath)),
      policy = loadPolicy(readDocument(policyPath));
    const pinsFile = values.get('--pins');
    const pins = pinsFile === undefined ? null : decodePins(JSON.parse(readDocument(pinsFile)));
    const root = resolve(args.evidenceDir ?? options.evidenceDir);
    // Fixed output names must never alias either input baseline.
    for (const name of [
      'candidate.manifest.json',
      'discovery.json',
      'discovery-checkpoint.json',
      'replay-checkpoint.json',
      'replayed.evidence.json',
      'replayed.evidence.html',
    ])
      if (
        [manifestPath, policyPath, args.file, pinsFile].some(
          (p) => p !== undefined && p !== null && resolve(p) === resolve(root, name),
        )
      )
        throw new InputError();
    signal.throwIfAborted();
    const runtime = injected ?? createRuntime(options.env, policy.value);
    if (args.command === 'doctor') {
      if (
        !pins ||
        pins.length !== deployments(manifest.value).length ||
        !deployments(manifest.value).every((d) =>
          pins.some((p) => p.blockchainId === d.chain.blockchainId),
        )
      )
        throw new InputError();
      const result = await doctorConfigured(
        manifest.value,
        policy.value,
        pins,
        options.env,
        runtime,
        signal,
      );
      const code = result.presence.some((p) => !p.present)
        ? EXIT.invalidConfig
        : result.ready
          ? EXIT.ok
          : EXIT.requiredUnknown;
      output('doctor', { ...result, exitCode: code });
      return code;
    }
    if (args.command === 'discover' && args.file === null) {
      if (offline || !pins) throw new InputError();
      const result = await discoverConfigured(manifest, policy.value, pins, runtime, signal, root, {
        maxFacts: args.maxFacts,
        resume: args.resume,
      });
      output('discover', result);
      return EXIT.requiredUnknown;
    }
    if (args.file === null) throw new InputError();
    const candidate: unknown = JSON.parse(readDocument(args.file));
    const verified = verifyBundle(candidate);
    if (!verified.verified) {
      output(args.command, { ...verified, exitCode: EXIT.requiredUnknown });
      return EXIT.requiredUnknown;
    }
    const bundle = candidate as EvidenceBundle;
    const faults = bindBundle(bundle, manifest, policy, pins);
    if (faults.length) {
      output(args.command, { verified: false, faults, exitCode: EXIT.requiredUnknown });
      return EXIT.requiredUnknown;
    }
    if (args.command === 'discover') throw new InputError('Use pinned registration discovery.');
    const replayed = replayEvaluation(bundle.core.replay.input);
    const stale =
      !offline &&
      (runtime.now() >= Date.parse(bundle.core.completeness.expiresAt) ||
        runtime.now() - Date.parse(bundle.core.completeness.observedAt) >
          policy.value.spec.evidence.maxAgeSeconds * 1000 ||
        runtime.now() < Date.parse(bundle.core.completeness.observedAt));
    const replay =
      args.command === 'replay' || args.resume || args.maxFacts !== 100
        ? replayOffline(bundle, root, { maxFacts: args.maxFacts, resume: args.resume })
        : null;
    let code = exitCodeForVerdict(replayed.verdict);
    if ((stale || (replay !== null && !replay.complete)) && code !== EXIT.critical)
      code = EXIT.requiredUnknown;
    const files: string[] = [];
    if (args.command === 'evidence') {
      signal.throwIfAborted();
      const exported = buildBundle({
        ...bundle,
        core: { ...bundle.core, producer: buildIdentity() },
      });
      assertBundleShareable(exported);
      files.push(
        writeAtomic(root, 'replayed.evidence.json', `${JSON.stringify(exported, null, 2)}\n`).path,
      );
      files.push(writeAtomic(root, 'replayed.evidence.html', renderHtml(exported)).path);
      output('evidence export', {
        contentHash: exported.contentHash,
        files,
        historical: offline,
        stale,
        exitCode: code,
      });
    } else
      output(args.command, {
        contentHash: bundle.contentHash,
        historical: offline,
        stale,
        evaluatedVerdict: replayed.verdict,
        currentStatus: stale ? 'UNKNOWN' : replayed.verdict.protocolStatus,
        replay,
        proofDigestInput: canonicalStringify(replayed.evaluation),
        trustBoundary: verified.trustBoundary,
        exitCode: code,
      });
    return code;
  } catch (e) {
    const invalid =
      e instanceof InputError ||
      e instanceof ConfigError ||
      e instanceof InvalidCheckpointError ||
      e instanceof SyntaxError ||
      (e instanceof Error &&
        'code' in e &&
        ['ENOENT', 'EACCES', 'EISDIR'].includes(String(e.code)));
    const code = signal.aborted
      ? EXIT.internalError
      : invalid
        ? EXIT.invalidConfig
        : EXIT.internalError;
    output('error', {
      error: signal.aborted ? 'cancelled' : invalid ? 'invalid-config-or-input' : 'internal-error',
      exitCode: code,
    });
    return code;
  }
};
