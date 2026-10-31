import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolSpec } from './types.js';
import type { ServerEnv } from './env.js';
import { describeError, EmptyResultError, UpstreamError } from './errors.js';
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

/**
 * The web_search tool teaches the model an inline citation-marker format whose
 * anchors look like `turn<N><type><M>`. Models generalised it to other tools and
 * wrote anchors such as `turn0disease_knowledge_search0`, which the UI cannot
 * resolve, so the raw text reached the user. Tell the model where markers are
 * valid and how to cite everything else.
 */
export const CITATION_MARKER_PARAGRAPH = `Citation markers: the inline citation markers (anchors of the form turnN + type + index) exist only for web_search results. Use one only by copying it exactly from an "Anchor:" line of a web_search result in this turn. Never build a marker for any other tool: no anchor may contain a tool name (disease_knowledge_search, drug_label, pubmed_search, …). Cite those tools in plain text: the record ID in brackets such as [D0051], "PMID 12345678", or the link from the tool's Sources block.`;

export const UNAVAILABLE_PARAGRAPH = `Unavailable sources: when a tool result says a source is down or not answering, do not call that tool again in this answer and do not wait for it; answer from the other sources (for a medicine: bd_medicine_lookup, the other label source, drug_lookup, web_search). The answer must contain one short, natural sentence in the user's language naming the source that could not be reached (for example "openFDA-র তথ্য এই মুহূর্তে পাওয়া যাচ্ছে না, তাই অন্য উৎস থেকে বলছি।"). Never copy status labels, notes meant for you, tool names or error text into the answer.`;

const DISEASE_KB_PARAGRAPH = `Disease dataset: whenever the user mentions a disease, a symptom or anything related to a disease, you MUST call disease_knowledge_search before answering, with keywords — the disease names and symptoms the user actually mentioned, in English plus the user's Bangla/Banglish words. For a named disease pass only its names, not its symptoms (e.g. ["dengue", "ডেঙ্গু"]); for described symptoms pass the symptoms (e.g. ["fever", "jor", "rash"]). One call returns every record of the local Global Disease Master Chart (about 2,000 records) that contains any keyword — no pages: the top-ranked diseases with every field and every other match as one compact line (ID, name, where it matched, symptoms). Read the whole list, and call again with ids=[...] for the full fields of compact-line records that fit the person's story. It is a compiled table: never take a dose or a treatment choice from it.

Sources: name only sources that appear in a tool result you received in this turn (a Sources block, a record ID such as [D0051], a PMID, a web-search citation, a page a tool returned). Never name WHO, DGHS, CDC, NHS or any guideline from memory; when a search failed or returned nothing, say so and cite only what you have.

${CITATION_MARKER_PARAGRAPH}

${UNAVAILABLE_PARAGRAPH}

`;

export const SERVER_INSTRUCTIONS = `${URGENCY_PARAGRAPH}${DISEASE_KB_PARAGRAPH}Live lookups against public, keyless biomedical APIs: PubMed and Europe PMC, openFDA (drug labels, enforcement, devices, food), RxNorm, DailyMed, LactMed, ChEMBL, PubChem, ClinVar, MedGen, MyGene.info, ClinicalTrials.gov, Open Targets, Monarch Initiative, UniProt, EBI OLS, NLM Clinical Tables, WHO GHO, NPPES and Wikipedia.

Every tool returns live data with a Sources block; cite those URLs rather than the API host, and never present a figure you did not read in a tool result. Zero results, a 404, and a rate limit are answers, not failures: say what was searched and what was not found, and widen the query instead of guessing. Upstreams are free and shared, so prefer few, well-formed calls over many speculative ones.`;

/**
 * Bounds one tool call. Upstream requests already have their own timeouts, but a
 * tool that chains several of them (DailyMed: search, then SPL, then fallbacks)
 * could still add up past the MCP request timeout, and the model would then get
 * only a generic timeout after a long wait. The deadline turns that into a
 * prompt, clear "source unavailable" result.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number | undefined,
  toolName: string,
): Promise<T> {
  if (deadlineMs == null || deadlineMs <= 0) {
    return work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new UpstreamError(
          toolName,
          `did not finish within ${Math.round(deadlineMs / 1000)}s; its upstream sources are too slow or down`,
          { unavailable: true },
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
          const output = await withDeadline(
            tool.handler(args as never, { env, http }),
            env.toolDeadlineMs,
            tool.title || tool.name,
          );
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
