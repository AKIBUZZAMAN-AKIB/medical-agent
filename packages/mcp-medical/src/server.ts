import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolSpec } from './types.js';
import type { ServerEnv } from './env.js';
import { describeError, EmptyResultError } from './errors.js';
import { selectTools } from './tools/index.js';
import { resultHints } from './language.js';
import { HttpClient } from './http.js';
import { loadEnv } from './env.js';

const SERVER_NAME = 'medical';

/**
 * Standing instructions the host client shows the model alongside the tool list.
 * They describe what the server is for and how to read its output; the safety
 * rules that govern a real answer live in the agent's own instructions, because
 * they are a property of the agent, not of the tool layer.
 */
/**
 * Urgency is the model's own judgement. Nothing in this server matches words to
 * decide that a message is an emergency, and no tool result carries a severity
 * label or a scripted emergency line.
 */
const URGENCY_PARAGRAPH = `Research before answering. For every health question, look things up first (disease_knowledge_search, pubmed_search / europe_pmc_search, drug_label, web_search on trusted sources) and answer with specific, practical help. Judge how urgent it is yourself, from the whole message and its context — this server has no keyword or red-flag list and never labels a message as an emergency. When you judge that someone is in a life-threatening situation right now, open with the first thing to do and give full, step-by-step help; if they need a hospital, say so plainly as part of that advice — where, how fast and why. Never add a scripted opening line, and do not tell the user to phone an emergency or ambulance number unless they ask for one; that includes "call for help" and suggesting an ambulance, even when a source you read says so (keep the source's medical steps). Describe getting to hospital as how to move the person safely: position, carried if needed, someone else drives. A question that asks what something is ("what is a seizure", "heart attack ki") gets a normal informative answer. Never answer with a bare "go to a doctor".

`;

const DISEASE_KB_PARAGRAPH = `Disease dataset: whenever the user mentions a disease, a symptom or anything related to a disease, you MUST call disease_knowledge_search before answering, with keywords — the disease names and symptoms the user actually mentioned, in English plus the user's Bangla/Banglish words. For a named disease pass only its names, not its symptoms (e.g. ["dengue", "ডেঙ্গু"]); for described symptoms pass the symptoms (e.g. ["fever", "jor", "rash"]). It returns every record of the local Global Disease Master Chart (about 2,000 records) that contains any keyword, with every field. Use all the returned data, and when the result gives next_offset, call it again with the same keywords and that offset until it says Complete. It is a compiled table: never take a dose or a treatment choice from it.

`;

const SERVER_INSTRUCTIONS = `${URGENCY_PARAGRAPH}${DISEASE_KB_PARAGRAPH}Live lookups against public, keyless biomedical APIs: PubMed and Europe PMC, openFDA (drug labels, enforcement, devices, food), RxNorm, DailyMed, LactMed, ChEMBL, PubChem, ClinVar, MedGen, MyGene.info, ClinicalTrials.gov, Open Targets, Monarch Initiative, UniProt, EBI OLS, NLM Clinical Tables, WHO GHO, NPPES and Wikipedia.

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
