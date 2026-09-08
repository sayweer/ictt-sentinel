import { describe, expect, it, vi } from 'vitest';
import { buildBundle } from '@ictt-sentinel/evidence';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import {
  acknowledge,
  checkTargetUrl,
  decodeNotification,
  dedupKey,
  dispatch,
  observe,
  open,
  project,
  recover,
  sanitize,
  shouldNotify,
  type AlertIdentity,
  type AlertTarget,
} from '../src/index.js';

const at = (minute: number) => new Date(`2026-06-01T00:${String(minute).padStart(2, '0')}:00.000Z`);
const identity = (overrides: Partial<AlertIdentity> = {}): AlertIdentity => ({
  deploymentId: 'acme-usdc',
  ruleId: 'accounting-reconciliation',
  reasonCode: 'ACC_A01_EXCESS',
  from: 'OK',
  to: 'WARN',
  evidenceDigest: 'a'.repeat(64),
  ...overrides,
});

describe('alert identity and lifecycle', () => {
  it('deduplicates an exact transition and changes for every identity component', () => {
    const base = identity();
    expect(dedupKey(base)).toBe(dedupKey({ ...base }));
    for (const changed of [
      identity({ deploymentId: 'other' }),
      identity({ ruleId: 'other' }),
      identity({ reasonCode: 'OTHER' }),
      identity({ from: 'NONE' }),
      identity({ to: 'CRITICAL' }),
      identity({ evidenceDigest: 'b'.repeat(64) }),
    ]) {
      expect(dedupKey(changed)).not.toBe(dedupKey(base));
    }
  });

  it('folds breach, repeat, escalation, acknowledgement and recovery without hiding verdicts', () => {
    const first = open({ identity: identity(), observedAt: at(0) });
    expect(first).toMatchObject({ state: 'first_seen', occurrences: 1, currentVerdict: 'WARN' });
    expect(shouldNotify(null, first)).toBe(true);

    const repeated = observe(first, { identity: identity(), observedAt: at(1) });
    expect(repeated).toMatchObject({ state: 'repeated', occurrences: 2 });
    expect(shouldNotify(first, repeated)).toBe(false);

    const escalated = observe(repeated, {
      identity: identity({ from: 'WARN', to: 'CRITICAL', evidenceDigest: 'b'.repeat(64) }),
      observedAt: at(2),
    });
    expect(escalated).toMatchObject({ state: 'escalated', currentVerdict: 'CRITICAL' });
    expect(shouldNotify(repeated, escalated)).toBe(true);

    const acknowledged = acknowledge(escalated, 'operator-1', at(3));
    expect(acknowledged).toMatchObject({
      state: 'acknowledged',
      currentVerdict: 'CRITICAL',
      acknowledgedBy: 'operator-1',
    });
    expect(shouldNotify(escalated, acknowledged)).toBe(false);

    const recovered = recover(acknowledged, 'OK', at(4));
    expect(recovered).toMatchObject({ state: 'recovered', currentVerdict: 'OK' });
    expect(shouldNotify(acknowledged, recovered!)).toBe(true);
  });
});

describe('notification boundary', () => {
  const context = {
    dedupKey: 'd'.repeat(64),
    deploymentId: 'acme-usdc',
    ruleId: 'accounting-reconciliation',
    state: 'first_seen' as const,
    severity: 'CRITICAL' as const,
    occurrences: 1,
    reasonCodes: ['ACC_A01_EXCESS', 'free form is dropped'],
    observedAt: at(0).toISOString(),
    expiresAt: at(5).toISOString(),
    fresh: true,
    evidenceHash: 'e'.repeat(64),
    evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
  };
  const target: AlertTarget = {
    targetId: 'primary-oncall',
    kind: 'generic-webhook',
    secretRef: 'ALERT_WEBHOOK_URL',
    minSeverity: 'WARN',
  };

  it('constructs an allowlisted, secret-free payload and distrusts stored summary fields', () => {
    const payload = sanitize(context);
    const decoded = decodeNotification({
      ...payload,
      summary: 'https://private.example/?token=leak',
      evidence: { ...payload.evidence, retrievePath: 'https://private.example/' },
    });
    expect(decoded).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain('manifest');
    expect(payload.reasonCodes).toEqual(['ACC_A01_EXCESS']);
    expect(payload.evidence.retrievePath).toBe(`/v1/alerts/${context.dedupKey}`);
  });

  it('keeps the verdict unchanged when every notifier fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('failed at https://user:password@host'));
    const result = await dispatch('CRITICAL', [target], () => 'https://hooks.example.com/notify', {
      payload: sanitize(context),
      transport: { post },
      timeoutMs: 100,
      signal: new AbortController().signal,
    });
    expect(result.verdict).toBe('CRITICAL');
    expect(result.degraded).toBe(true);
    expect(result.reports[0]).toMatchObject({
      outcome: 'error',
      reason: 'failed at [redacted]',
    });
  });

  it('refuses local, credentialed, non-TLS and non-default-port targets', () => {
    for (const url of [
      'http://hooks.example.com',
      'https://127.0.0.1/hook',
      'https://metadata.example/hook',
      'https://user:password@hooks.example.com/hook',
      'https://hooks.example.com:8443/hook',
    ]) {
      expect(checkTargetUrl(url).ok).toBe(false);
    }
    expect(checkTargetUrl('https://hooks.example.com/hook').ok).toBe(true);
  });
});

describe('sharing consent', () => {
  const bundle = buildBundle(quickstartBundleDraft('healthy'));

  it('defaults to a projection that sends nothing and emits only approved fields for metadata', () => {
    expect(project('local-only', bundle)).toEqual({ level: 'local-only', body: null });
    const metadata = project('sanitized-metadata', bundle);
    expect(metadata.body).toMatchObject({
      deploymentId: bundle.core.deploymentId,
      evidenceHash: bundle.contentHash,
      protocolStatus: 'OK',
    });
    expect(JSON.stringify(metadata)).not.toContain(bundle.core.fingerprints[0]?.address);
  });

  it('shares the complete verified bundle only at the explicit full level', () => {
    expect(project('approved-full', bundle)).toEqual({ level: 'approved-full', body: bundle });
  });
});
