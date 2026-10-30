#!/usr/bin/env node
/**
 * Offline integration test: the server must not decide urgency by keyword.
 *
 * It starts the built server over the real MCP stdio transport, as a real MCP
 * client, and checks what an agent actually receives:
 *
 * - the published catalogue has no triage / red-flag tool,
 * - the server instructions leave urgency to the model and say a definition
 *   question gets no 999 line,
 * - an offline tool called with emergency-sounding words returns no forced
 *   EMERGENCY label or 999 instruction.
 *
 *   node packages/mcp-medical/scripts/urgency-e2e.mjs
 *
 * No network, no API key, no model. Exits non-zero on the first failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'dist', 'index.js');

const EXPECTED_TOOLS = 33;
const FORCED_LABEL = /[Rr]ed-flag level|TRIAGE_DECISION|\bEMERGENCY\b|🚨|Call 999 now|এখনই 999/u;

/** Messages that a keyword list would have flagged. */
const MESSAGES = [
  'what is a seizure',
  'heart attack ki',
  'amar baba buke tibro betha, ghame vije jacche',
  'my father is not breathing and he is unconscious',
];

const failures = [];
let checks = 0;

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
  checks += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures.push(label);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, MEDICAL_CONTACT_EMAIL: 'e2e@example.org' },
  stderr: 'pipe',
});
const client = new Client({ name: 'urgency-e2e', version: '1.0.0' });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  check(
    names.length === EXPECTED_TOOLS,
    `${EXPECTED_TOOLS} tools over the wire (got ${names.length})`,
  );
  check(
    !names.some((name) => /triage|red_?flag|emergency/i.test(name)),
    'no triage, red-flag or emergency tool is published',
  );

  const instructions = client.getInstructions() ?? '';
  check(
    /Judge how urgent it is yourself/i.test(instructions),
    'server instructions leave urgency to the model',
  );
  check(
    /no keyword or red-flag list/i.test(instructions),
    'server instructions say there is no keyword list',
  );
  check(
    /"what is a seizure"[^.]*no 999 line/i.test(instructions),
    'server instructions give a definition question no 999 line',
  );
  check(
    !/emergency_triage_check/.test(instructions),
    'server instructions do not mention a triage tool',
  );

  for (const message of MESSAGES) {
    const result = await client.callTool({
      name: 'specialist_subagent_blueprint',
      arguments: { specialty: 'General Medicine', clinical_focus: message },
    });
    const text = (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    check(result.isError !== true && text.length > 0, `tool answered for: ${message}`);
    check(!FORCED_LABEL.test(text), `no forced emergency label or 999 line for: ${message}`);
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
console.log(`\nAll ${checks} end-to-end checks passed over MCP stdio.`);
