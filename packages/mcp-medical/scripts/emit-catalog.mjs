/**
 * Writes `dist/tool-catalog.json`: the published tool list, in registry order.
 *
 * The server registry (`src/tools/index.ts` → `allTools`) is the single source of
 * truth for what this MCP server exposes. The admin console needs that list, but
 * it runs in the CommonJS API process — where an ESM dynamic import is not
 * available under jest's VM — so the build emits a plain JSON snapshot instead of
 * a second hand-written array. A hand-written array is what drifted: it claimed
 * 32 tools while 33 were published.
 *
 * Runs as part of `npm run build`, after `tsc`, so the JSON can never describe a
 * different set of tools than the dist it ships beside.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

const { allTools } = await import(pathToFileURL(join(distDir, 'tools', 'index.js')).href);

const catalog = allTools.map((tool) => ({
  name: tool.name,
  group: tool.group,
  description: tool.description ?? '',
}));

const outFile = join(distDir, 'tool-catalog.json');
writeFileSync(
  outFile,
  `${JSON.stringify({ generatedFrom: 'src/tools/index.ts#allTools', tools: catalog }, null, 2)}\n`,
);

const groups = new Set(catalog.map((tool) => tool.group));
console.log(`[emit-catalog] wrote ${catalog.length} tools in ${groups.size} groups to ${outFile}`);
