/**
 * Behavioural evaluation runner for the medical agent's safety rules.
 *
 * This measures the one thing the unit suite cannot: whether a model actually
 * follows the instructions. The instructions carry the safety boundary, and a
 * rule that is present in the prompt but ignored in the reply is not a rule.
 *
 *   MEDICAL_EVAL_API_KEY=... \
 *   MEDICAL_EVAL_MODEL=gpt-4o \
 *   node packages/mcp-medical/eval/run.mjs
 *
 * Optional: MEDICAL_EVAL_BASE_URL (defaults to the OpenAI API), MEDICAL_EVAL_GROUPS
 * (comma-separated risk classes, blank = all), MEDICAL_EVAL_CONCURRENCY.
 *
 * Tools are deliberately NOT wired in. Two reasons. First, the tools' own
 * behaviour is covered by the unit suite and the live smoke run; what is under
 * test here is the reply text. Second, a case that needs a tool should assert
 * that the agent says what it can and defers what it cannot — which is exactly
 * the behaviour worth measuring when a tool is unavailable. Cases are written so
 * that a tool-less harness is a fair test, and the ones that would need live
 * data (the fabricated citation, the lactation summary) assert the honest
 * fallback instead of the researched answer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RISK_CLASSES, grade, systemPrompt } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const instructions = readFileSync(path.resolve(here, '..', 'agent', 'instructions.md'), 'utf8');

const baseUrl = (process.env.MEDICAL_EVAL_BASE_URL ?? 'https://api.openai.com/v1').replace(
  /\/$/,
  '',
);
const model = process.env.MEDICAL_EVAL_MODEL ?? 'gpt-4o';
const apiKey = process.env.MEDICAL_EVAL_API_KEY;
const groups = (process.env.MEDICAL_EVAL_GROUPS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

if (apiKey == null || apiKey.length === 0) {
  console.error(
    'MEDICAL_EVAL_API_KEY is not set. This runner calls a real model; there is no\n' +
      'offline substitute, because the thing under test is the reply.',
  );
  process.exit(2);
}

const selected = groups.length > 0 ? CASES.filter((entry) => groups.includes(entry.risk)) : CASES;
if (selected.length === 0) {
  console.error(
    `No cases matched MEDICAL_EVAL_GROUPS. Known risk classes: ${RISK_CLASSES.join(', ')}`,
  );
  process.exit(2);
}

/**
 * Replaces the seed's date placeholder, so the prompt under test is the one
 * that ships apart from a fixed date.
 */
const system = systemPrompt(instructions);

async function runCase(entry) {
  const messages = [{ role: 'system', content: system }];
  let reply = '';
  for (const turn of entry.turns) {
    messages.push({ role: 'user', content: turn.user });
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 900 }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${detail.slice(0, 300)}`);
    }
    const payload = await response.json();
    reply = payload.choices?.[0]?.message?.content ?? '';
    messages.push({ role: 'assistant', content: reply });
  }
  return reply;
}

const results = [];
for (const entry of selected) {
  process.stdout.write(`  ${entry.id} … `);
  let reply = '';
  try {
    reply = await runCase(entry);
    const failures = grade(entry, reply);
    results.push({ entry, failures, reply });
    console.log(failures == null ? 'pass' : `FAIL (${failures.length})`);
  } catch (error) {
    results.push({ entry, failures: [`run failed: ${error.message}`], reply });
    console.log('ERROR');
  }
}

const failed = results.filter((result) => result.failures != null);
const byClass = new Map();
for (const result of results) {
  const bucket = byClass.get(result.entry.risk) ?? { pass: 0, fail: 0 };
  if (result.failures == null) {
    bucket.pass += 1;
  } else {
    bucket.fail += 1;
  }
  byClass.set(result.entry.risk, bucket);
}

console.log(`\n${model} · ${results.length - failed.length}/${results.length} passed\n`);
for (const [risk, bucket] of [...byClass].sort()) {
  const total = bucket.pass + bucket.fail;
  const share = Math.round((bucket.pass / total) * 100);
  console.log(`  ${risk.padEnd(20)} ${bucket.pass}/${total}  (${share}%)`);
}

if (failed.length > 0) {
  console.log('\nFailures:');
  for (const result of failed) {
    console.log(`\n  ${result.entry.id} [${result.entry.risk}]`);
    for (const failure of result.failures ?? []) {
      console.log(`    - ${failure}`);
    }
    console.log('    reply:');
    for (const line of result.reply.split('\n')) {
      console.log(`      ${line}`);
    }
  }
  process.exitCode = 1;
}
