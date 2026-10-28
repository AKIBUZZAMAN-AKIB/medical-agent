import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resultHints } from './language.js';
import type { ToolSpec } from './types.js';
import type { ServerEnv } from './env.js';
import { describeError, EmptyResultError } from './errors.js';
import { selectTools } from './tools/index.js';
import { HttpClient } from './http.js';
import { loadEnv } from './env.js';
import { triageMode } from './tools/emergency.js';

const SERVER_NAME = 'medical';

/**
 * Standing instructions the host client shows the model alongside the tool list.
 * They describe what the server is for and how to read its output; the safety
 * rules that govern a real answer live in the agent's own instructions, because
 * they are a property of the agent, not of the tool layer.
 */
/**
 * The first paragraph follows the triage mode (see tools/emergency.ts). In the
 * default `signal` mode the red-flag check is an optional hint and the server
 * no longer tells the model to run it first or to hold back lookups.
 */
const TRIAGE_PARAGRAPH =
  triageMode() === 'signal'
    ? `Research before answering. For every health question, look things up first (disease_knowledge_search, pubmed_search / europe_pmc_search, drug_label, web_search on trusted sources) and answer with specific, practical help — emergencies included. \`emergency_triage_check\` is an optional internal red-flag signal: it returns a level and matched danger patterns, never an answer. On a life-threatening red flag, open the reply with one short 999 line and then give full, detailed help; never answer with a bare "go to a doctor".

`
    : `Call \`emergency_triage_check\` first, with the user's own words, on any message that describes symptoms, an injury, an ingestion, or emotional distress. It evaluates a deterministic triage policy over evidence from a classifier. This server has no model, so with no classifier configured it returns UNKNOWN — undecided, never ROUTINE — which must be treated as urgent and is never a clearance. Do not run a lookup before it, and never present an undecided result as reassurance.

`;

const SERVER_INSTRUCTIONS = `${TRIAGE_PARAGRAPH}Live lookups against public, keyless biomedical APIs: PubMed and Europe PMC, openFDA (drug labels, enforcement, devices, food), RxNorm, DailyMed, LactMed, ChEMBL, PubChem, ClinVar, MedGen, MyGene.info, ClinicalTrials.gov, Open Targets, Monarch Initiative, UniProt, EBI OLS, NLM Clinical Tables, WHO GHO, NPPES and Wikipedia.

Every tool returns live data with a Sources block; cite those URLs rather than the API host, and never present a figure you did not read in a tool result. Zero results, a 404, and a rate limit are answers, not failures: say what was searched and what was not found, and widen the query instead of guessing. Upstreams are free and shared, so prefer few, well-formed calls over many speculative ones.`;

export interface CreatedServer {
  server: McpServer;
  env: ServerEnv;
  tools: ToolSpec[];
}

/** Builds the server with its tool catalogue registered. Exported for tests. */
export function createMedicalServer(env: ServerEnv = loadEnv()): CreatedServer {
  const tools = selectTools(env);
  const http = new HttpClient({ env });
  const server = new McpServer(
    { name: SERVER_NAME, version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly ?? true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const output = await tool.handler(args as never, { env, http });
          const hints = resultHints(args);
          const text = hints.length ? `${output.text}\n\n---\n${hints.join('\n')}` : output.text;
          return {
            content: [{ type: 'text' as const, text }],
            isError: output.isError === true,
          };
        } catch (error) {
          /**
           * An empty result is a real answer and must not be flagged as a tool
           * failure, or the model retries the same query forever.
           */
          if (error instanceof EmptyResultError) {
            const hints = resultHints(args);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No result. ${error.message}${hints.length ? `\n\n---\n${hints.join('\n')}` : ''}`,
                },
              ],
              isError: false,
            };
          }
          const message = describeError(error);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  return { server, env, tools };
}
