#!/usr/bin/env node
/**
 * Throughput and latency benchmark for the deterministic emergency screen.
 *
 * The screen runs inline on the critical path of every symptom message, before
 * any lookup. That makes its cost a latency floor for the whole agent, so it is
 * measured rather than assumed.
 *
 *   node packages/mcp-medical/scripts/benchmark-emergency.mjs [iterations]
 *
 * Prints p50/p95/p99 and throughput. Numbers are for this machine only; the
 * report in docs/REPOSITORY_DEEP_AUDIT.md records the hardware it was run on.
 * This measures CPU cost of the rule engine, not the MCP transport or an LLM.
 */
import { performance } from 'node:perf_hooks';
import { triage } from '../dist/safety/emergency.js';

const iterations = Number.parseInt(process.argv[2] ?? '2000', 10);

const MESSAGES = [
  'I cannot breathe',
  'my father is not breathing and he is unconscious',
  'crushing chest pain radiating to my left arm and sweating',
  'her face is drooping and her speech is slurred',
  'my husband collapsed and I cannot wake him',
  'he is bleeding heavily and it will not stop',
  'my son is having a seizure',
  'her throat is closing after peanuts, she has an epipen',
  'my child swallowed rat poison',
  'I want to kill myself tonight',
  'she is 34 weeks pregnant and bleeding heavily',
  'my baby is 2 months old with fever',
  'my father is chocking and cant breath',
  'শ্বাস নিতে পারছি না',
  'no chest pain but I cannot breathe',
  'what is a seizure',
  'my father died of a heart attack 10 years ago',
  'What is the BD price of Napa Extend 665 mg',
];

const WORST_CASE = `${'I have been feeling unwell for a while and I am not sure what is going on. '.repeat(90)}I cannot breathe`;

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function run(label, samples) {
  const durations = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const message = samples[i % samples.length];
    const t0 = performance.now();
    triage(message);
    durations.push(performance.now() - t0);
  }
  const elapsed = performance.now() - start;
  durations.sort((a, b) => a - b);
  return {
    label,
    iterations,
    elapsedMs: Number(elapsed.toFixed(1)),
    throughput: Math.round((iterations / elapsed) * 1000),
    p50: Number(percentile(durations, 50).toFixed(3)),
    p95: Number(percentile(durations, 95).toFixed(3)),
    p99: Number(percentile(durations, 99).toFixed(3)),
    max: Number(durations[durations.length - 1].toFixed(3)),
    mean: Number((durations.reduce((sum, d) => sum + d, 0) / durations.length).toFixed(3)),
  };
}

// Warm the JIT so the first-iteration cost does not dominate the percentile tail.
for (let i = 0; i < 200; i++) {
  triage(MESSAGES[i % MESSAGES.length]);
}

const results = [run('mixed real messages', MESSAGES), run('worst case (~3.6 KB)', [WORST_CASE])];

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpuCount: (await import('node:os')).cpus().length,
      results,
      note: 'Deterministic rule engine only. Excludes MCP transport, network, and any model.',
    },
    null,
    2,
  ),
);
