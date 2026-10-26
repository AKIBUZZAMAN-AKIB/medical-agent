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

/** [message, expected disposition, rule ids that must appear in the result] */
/**
 * Cases assert the *honesty* contract, not clinical recognition.
 *
 * This server has no model, so every message must come back UNKNOWN — undecided,
 * never ROUTINE. Asserting "emergency" here would require the server to hold a
 * hand-written lexicon, which is exactly what this change removed. Clinical
 * recognition is measured against a live model in `eval/`.
 */
const CASES = [
  ['my father is not breathing and he is unconscious', 'UNKNOWN'],
  ['I cannot breathe', 'UNKNOWN'],
  ['crushing chest pain radiating to my left arm and sweating', 'UNKNOWN'],
  ['what is a seizure', 'UNKNOWN'],
  ['What is the BD price of Napa Extend 665 mg', 'UNKNOWN'],
];

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

  if (names.length !== 33) {
    failures.push(`expected 33 tools over the wire, got ${names.length}`);
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

    const severity = /Triage severity: (NONE|INFORMATIONAL|ROUTINE|URGENT|EMERGENCY|UNKNOWN)/i.exec(
      text,
    )?.[1];
    const ok = severity?.toUpperCase() === expected.toUpperCase();
    if (expected === 'UNKNOWN' && !/undecided/i.test(text)) {
      failures.push(`UNKNOWN was not reported as undecided for: ${message || '(empty)'}`);
    }
    if (!/Limits of this assessment/i.test(text)) {
      failures.push(`result carried no limitations for: ${message || '(empty)'}`);
    }
    if (result.isError) {
      failures.push(`tool reported an error for: ${message}`);
    }
    if (text.includes('[truncated')) {
      failures.push(`result was truncated for: ${message} — the call-first line may be lost`);
    }
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(severity).padEnd(12)} ${expected.toUpperCase().padEnd(12)} ${message.slice(0, 52)}`,
    );
    if (!ok) {
      failures.push(`expected ${expected}, got ${severity} for: ${message || '(empty)'}`);
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
  if (!/Triage severity: UNKNOWN/i.test(longText) || !/Limits of this assessment/i.test(longText)) {
    failures.push('a long message lost the severity or its limitations');
  } else {
    console.log('PASS  long message keeps the severity and its limitations');
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
console.log(`\nAll ${CASES.length + 1} end-to-end cases passed over MCP stdio.`);
