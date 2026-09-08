#!/usr/bin/env node
// Bounded local release budgets. These measure pure accepted-observation to
// evidence work; RPC and production database latency are deliberately excluded.

import { performance } from 'node:perf_hooks';
import { buildBundle, replayProof, verifyBundle } from '../packages/evidence/dist/index.js';
import { proofInput, quickstartBundleDraft } from '../packages/testkit/dist/index.js';

const fail = [];
const measure = (fn) => {
  const started = performance.now();
  const value = fn();
  return { value, elapsedMs: performance.now() - started };
};

globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const first = measure(() => buildBundle(quickstartBundleDraft('healthy')));
if (!verifyBundle(first.value).verified) fail.push('first evidence did not verify');

const latencies = [];
for (let index = 0; index < 500; index += 1) {
  latencies.push(measure(() => replayProof(proofInput({}))).elapsedMs);
}
latencies.sort((a, b) => a - b);
const detectionP95Ms = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;

const replay = measure(() => {
  let critical = 0;
  for (let index = 0; index < 10_000; index += 1) {
    const result = replayProof(proofInput({}));
    if (result.aggregation.contributions.some((item) => item.critical)) critical += 1;
  }
  return critical;
});
globalThis.gc?.();
const heapDeltaMiB = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
const rssMiB = process.memoryUsage().rss / 1024 / 1024;

const budgets = {
  firstEvidenceMs: 500,
  detectionP95Ms: 50,
  fullReplay10kMs: 5_000,
  heapDeltaMiB: 128,
  rssMiB: 512,
};
const metrics = {
  firstEvidenceMs: first.elapsedMs,
  detectionP95Ms,
  fullReplay10kMs: replay.elapsedMs,
  heapDeltaMiB,
  rssMiB,
};
for (const [name, budget] of Object.entries(budgets)) {
  if (metrics[name] > budget) fail.push(`${name} ${metrics[name].toFixed(2)} > ${budget}`);
}
console.log(JSON.stringify({ workload: '10k-pure-replay', metrics, budgets }, null, 2));
if (fail.length > 0) {
  console.error(`release:benchmark FAILED - ${fail.join('; ')}`);
  process.exit(1);
}
console.log('release:benchmark OK');
