#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMedicalServer } from './server.js';

async function main(): Promise<void> {
  const { server, tools } = createMedicalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  /**
   * stdout belongs to the protocol; diagnostics go to stderr so a stray log
   * line can never corrupt a frame and take the session down.
   */
  process.stderr.write(
    `[mcp-medical] serving ${tools.length} tool(s) over stdio: ${tools.map((tool) => tool.name).join(', ')}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[mcp-medical] failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
