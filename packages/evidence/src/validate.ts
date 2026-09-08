/** Small closed runtime schema: untrusted JSON never enters the engine on a type cast. */
type Shape = 's' | 'n' | 'b' | 'any' | { readonly [k: string]: Shape } | readonly [Shape];
const strings: Shape = ['s'];
const nullable = (shape: Shape): Shape => ({ $nullable: shape });
const schema: Shape = {
  contentHash: 's',
  presentation: { generatedAt: 's', locale: 's', toolVersion: 's' },
  core: {
    producer: { producer: 's', schemaVersion: 's', buildCommit: 's', artifactChecksum: 's' },
    sourceLock: {
      commitSha: 's',
      sourceLockHash: 's',
      adapterId: 's',
      adapterVersion: 'n',
      adapterEpoch: 's',
    },
    baseline: { manifestHash: 's', policyHash: 's' },
    deploymentId: 's',
    fingerprints: [
      {
        role: 's',
        blockchainId: 's',
        runtimeCodeHash: 's',
        address: 's',
        implementationAddress: nullable('s'),
        implementationCodeHash: nullable('s'),
        proxyAdmin: nullable('s'),
        beacon: nullable('s'),
        recognised: 'b',
      },
    ],
    chains: [
      {
        blockchainId: 's',
        evmChainId: 's',
        blockNumber: 's',
        blockHash: 's',
        blockTimestamp: 's',
        acceptanceEvidence: 's',
        finalityBasis: 's',
      },
    ],
    quorum: {
      votes: [
        {
          endpointId: 's',
          trustDomain: 's',
          providerGroup: 's',
          blockchainId: 's',
          agreedBlockHash: 's',
          agreed: 'b',
        },
      ],
      independentGroups: 'n',
      requiredGroups: 'n',
      note: 's',
    },
    rawFacts: [{ evmChainId: 's', blockHash: 's', txHash: 's', logIndex: 'n', digest: 's' }],
    historicalBlocks: {
      $optional: [
        {
          blockchainId: 's',
          blockNumber: 's',
          blockHash: 's',
          acceptanceEvidence: 's',
          votes: [
            {
              endpointId: 's',
              trustDomain: 's',
              providerGroup: 's',
              blockchainId: 's',
              agreedBlockHash: 's',
              agreed: 'b',
            },
          ],
        },
      ],
    },
    stateCalls: [
      {
        blockchainId: 's',
        target: 's',
        calldataDigest: 's',
        resultDigest: 's',
        blockNumber: 's',
        blockHash: 's',
        observationPath: 's',
        result: 's',
        calldata: 's',
        provenance: 's',
      },
    ],
    census: {
      completeness: 's',
      registeredRemotes: strings,
      missingRemotes: strings,
      remotesWithoutRpc: strings,
    },
    messages: [
      {
        sourceBlockchainId: 's',
        destinationBlockchainId: 's',
        teleporterMessengerAddress: 's',
        registryProtocolVersion: 'n',
        messageId: 's',
        state: 's',
        timeline: [{ kind: 's', factDigest: 's' }],
        sendAttempts: 'n',
        executionAttempts: 'n',
        envelopeIds: strings,
        economicEffectCount: 'n',
      },
    ],
    rules: [
      {
        ruleId: 's',
        ruleVersion: 's',
        result: 's',
        reasonCodes: strings,
        inputs: 'any',
        intermediates: 'any',
        unit: 's',
        floor: nullable('s'),
        ceil: nullable('s'),
        dust: nullable('s'),
      },
    ],
    verdict: {
      protocolStatus: 's',
      dataStatus: 's',
      claimMode: 's',
      coverage: 's',
      reasonCodes: strings,
      criticalRuleIds: strings,
      unknownRuleIds: strings,
    },
    completeness: {
      observedAt: 's',
      expiresAt: 's',
      fresh: 'b',
      missingEvidence: strings,
      contradictoryEvidence: strings,
    },
    assurance: { assuranceMode: 's', assumptions: strings, exclusions: strings, nonGoals: strings },
    previousBundleHash: nullable('s'),
    replay: { input: 'any', evaluation: 'any' },
  },
};
function matches(value: unknown, shape: Shape): boolean {
  if (shape === 'any') return value !== undefined;
  if (shape === 's') return typeof value === 'string';
  if (shape === 'b') return typeof value === 'boolean';
  if (shape === 'n') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (Array.isArray(shape))
    return Array.isArray(value) && value.every((v) => matches(v, shape[0] as Shape));
  const fields = shape as Record<string, Shape>;
  if (fields['$nullable']) return value === null || matches(value, fields['$nullable']);
  if (fields['$optional']) return value === undefined || matches(value, fields['$optional']);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((k) => Object.hasOwn(fields, k)) &&
    Object.entries(fields).every(([k, s]) => matches(record[k], s))
  );
}
export const validBundleShape = (value: unknown): value is import('./schema.js').EvidenceBundle =>
  matches(value, schema);
