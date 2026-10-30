#!/usr/bin/env node
/**
 * Offline integration test for the deterministic emergency screen.
 *
 * Unlike `smoke.mjs`, this makes no network calls: it starts the built server
 * over the real MCP stdio transport, as a real MCP client, and exercises
 * `emergency_triage_check` end to end. That is the path an agent actually takes,
 * so it catches what an in-process unit test cannot — a tool that fails to
 * register, a schema the SDK rejects, a handler that throws under the transport,
 * or a stdout write that corrupts a protocol frame.
 *
 *   node packages/mcp-medical/scripts/emergency-e2e.mjs
 *
 * Exits non-zero on the first failure, so it can gate CI without an API key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'dist', 'index.js');

/**
 * [message, expected red-flag level or null for "any decided level"]
 *
 * The screen is the operator red-flag pattern list (src/safety/redflags-bd.ts):
 * an internal signal for the agent, not the answer. These cases assert the
 * contract the agent relies on — a decided level that names its pattern list,
 * the one-line 999 instruction only for a life-threatening match, and the
 * pattern list's own limits — not clinical recognition, which is measured
 * against a live model in `eval/`. A bare definition question may or may not
 * match a pattern; the agent's own reading decides that one, so it is not
 * pinned here.
 */
const CASES = [
  ['my father is not breathing and he is unconscious', 'EMERGENCY'],
  ['I cannot breathe', 'EMERGENCY'],
  ['crushing chest pain radiating to my left arm and sweating', 'EMERGENCY'],
  ['what is a seizure', null],
  ['What is the BD price of Napa Extend 665 mg', 'ROUTINE'],
];

const LEVEL = /Red-flag level: (NONE|INFORMATIONAL|ROUTINE|URGENT|EMERGENCY|UNKNOWN)/i;
const CALL_999 = '🚨 Call 999 now.';
const LIMITS = /Pattern matching, not clinician-reviewed, not a diagnosis/i;

/** @param {string} text */
function decision(text) {
  const match = /<<<TRIAGE_DECISION (\{[\s\S]*?\})>>>/.exec(text);
  return match ? JSON.parse(match[1]) : null;
}

const failures = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, MEDICAL_CONTACT_EMAIL: 'e2e@example.org' },
  stderr: 'pipe',
});

const client = new Client({ name: 'emergency-e2e', version: '1.0.0' });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  console.log(`server published ${names.length} tool(s)`);

  if (names.length !== 34) {
    failures.push(`expected 34 tools over the wire, got ${names.length}`);
  }
  if (names[0] !== 'emergency_triage_check') {
    failures.push(`expected emergency_triage_check first, got ${names[0]}`);
  }

  for (const [message, expected] of CASES) {
    const result = await client.callTool({
      name: 'emergency_triage_check',
      arguments: { message },
    });
    const text = (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    const level = LEVEL.exec(text)?.[1]?.toUpperCase();
    const payload = decision(text);
    const ok = level != null && (expected == null || level === expected);
    if (!payload || payload.decided !== true || !String(payload.classifier).startsWith('kb:')) {
      failures.push(`no decided, pattern-list-attributed verdict for: ${message}`);
    }
    if (!/internal hint, not an answer/i.test(text)) {
      failures.push(`result was not marked as an internal hint for: ${message}`);
    }
    if (!LIMITS.test(text)) {
      failures.push(`result carried no limitations for: ${message}`);
    }
    if (level === 'EMERGENCY' && !text.includes(CALL_999)) {
      failures.push(`an emergency match did not carry the 999 line for: ${message}`);
    }
    if (level !== 'EMERGENCY' && !/do NOT add a 999 line/.test(text)) {
      failures.push(`a non-emergency level did not hold back the 999 line for: ${message}`);
    }
    if (result.isError) {
      failures.push(`tool reported an error for: ${message}`);
    }
    if (text.includes('[truncated')) {
      failures.push(`result was truncated for: ${message} — the 999 line may be lost`);
    }
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(level).padEnd(12)} ${String(expected ?? 'any').padEnd(12)} ${message.slice(0, 52)}`,
    );
    if (!ok) {
      failures.push(`expected ${expected ?? 'a level'}, got ${level} for: ${message}`);
    }
  }

  // An empty argument must be rejected by the schema, not answered with a verdict.
  const empty = await client.callTool({
    name: 'emergency_triage_check',
    arguments: { message: '' },
  });
  const emptyText = (empty.content ?? []).map((part) => part.text ?? '').join('\n');
  if (empty.isError === true) {
    console.log('PASS  empty message rejected by the schema');
  } else {
    failures.push(
      `an empty message produced a verdict instead of a schema error: ${emptyText.slice(0, 120)}`,
    );
  }

  // An over-long message must not lose the severity or its limitations to the budget.
  const long = await client.callTool({
    name: 'emergency_triage_check',
    arguments: {
      message: `${'I have been feeling unwell for a while. '.repeat(120)}I cannot breathe`,
    },
  });
  const longText = long.content.map((part) => part.text).join('\n');
  if (
    !/Red-flag level: EMERGENCY/i.test(longText) ||
    !longText.includes(CALL_999) ||
    !LIMITS.test(longText)
  ) {
    failures.push('a long message lost the level, the 999 line or its limitations');
  } else {
    console.log('PASS  long message keeps the level, the 999 line and its limitations');
  }
} catch (error) {
  failures.push(
    `transport/protocol failure: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await client.close().catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(`\nAll ${CASES.length + 2} end-to-end cases passed over MCP stdio.`);
