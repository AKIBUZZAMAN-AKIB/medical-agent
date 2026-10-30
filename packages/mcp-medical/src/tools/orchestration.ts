/**
 * Specialist sub-agent blueprint generator.
 *
 * This file used to hold `SPECIALTY_PROFILES`: five hand-written profiles, each
 * with a `keywords: RegExp` of clinical vocabulary (dengue/fever/platelet,
 * heart/bp/egfr, pregnan/breastfeed, migraine/stroke, and a catch-all that matched everything)
 * plus a fixed `redFlags`, `contextQuestions` and `recommendedTools` list. The
 * "dynamic specialist" was therefore not dynamic at all: the specialist was
 * whichever profile happened to be listed first whose regex matched, and every
 * clinical statement the sub-agent was told to make was author-invented text
 * keyed on that match.
 *
 * It has been removed deliberately, for the same reason the emergency keyword
 * lists were removed from this package:
 *
 *  - The caller already knows the specialty. It arrives as `args.specialty`, in
 *    the user's own words and language. A regex list of English (and no Bangla)
 *    disease words could only ever *disagree* with the person who asked.
 *  - A red-flag list is a clinical claim. Copying five hand-written claim sets
 *    into every spawned specialist is not a safety guarantee; it is untraceable
 *    clinical content with no author, no review and no version.
 *  - First-match-wins over an ordered array makes behaviour depend on array
 *    order — invisible, untestable, and impossible to audit.
 *
 * What the tool does now: it renders a blueprint from what it is *given* — the
 * specialty label, the clinical focus, and (optionally) the red flags, context
 * questions and tool subset that the calling agent chose. It matches nothing,
 * enumerates nothing clinical, and says so in its own output. Tool names are
 * read from the live registry, so the catalogue cannot drift from the server.
 *
 * Consequence, stated where it cannot be missed: with no `red_flags` supplied,
 * the blueprint contains **no red-flag triggers** and says so, instead of
 * silently substituting an author's list. Urgency is not decided by this tool
 * or by any word list: the model reads the whole message and judges it.
 */
import { z } from 'zod';
import { bulletList, composeResult, definitionList, heading } from '../format.js';
import { defineTool } from '../types.js';

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

function cleanList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

export const orchestrationTools = [
  defineTool({
    name: 'specialist_subagent_blueprint',
    group: 'orchestration',
    title: 'Specialist sub-agent blueprint renderer (no built-in clinical profiles)',
    description:
      'Render a persistable LibreChat `agent_dyn_*` specialist sub-agent specification from the specialty label and clinical focus you supply, plus any red flags, context-seeking questions and tool subset you choose. This tool holds no clinical profiles, no keyword matcher and no red-flag list of its own: unmatched or unspecified fields come back empty with a notice saying so, never filled in from an author-authored table. Available MCP tool names are read from the live registry so the catalogue cannot drift.',
    readOnly: true,
    inputSchema: {
      specialty: z
        .string()
        .min(2)
        .describe(
          'The specialty or domain label for the sub-agent, in the requester\'s own words and language (e.g. "Tropical Infectious Diseases & Dengue", "Nephrology", "নিউরোলজি"). Used verbatim as the agent label; never matched against a list.',
        ),
      clinical_focus: z
        .string()
        .min(3)
        .describe('Specific patient question or clinical problem this sub-agent must investigate'),
      red_flags: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Red-flag escalation triggers for this sub-agent, chosen by the calling agent from the evidence it gathered (for example the danger signs it found in the case). Omitted = the blueprint ships no red-flag triggers and says so; nothing is invented here.',
        ),
      context_questions: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Context-seeking questions the sub-agent should ask. Omitted = none are emitted; this tool does not carry a question bank.',
        ),
      tools: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'MCP tool names to grant the sub-agent. Omitted = the blueprint lists the live catalogue grouped by family and leaves the choice to the caller. Unknown names are reported back rather than dropped silently.',
        ),
    },
    async handler(args, { env }) {
      /* Resolved lazily: the registry imports this module, so a static import
       * would be a cycle. Reading it per call also means the blueprint always
       * reflects the tools this server actually published. */
      const { allTools, describeToolGroups, selectTools } = await import('./index.js');
      const catalog = selectTools(env, allTools);
      const catalogNames = new Set(catalog.map((tool) => tool.name));

      const requestedTools = cleanList(args.tools);
      const unknownTools = requestedTools.filter((name) => !catalogNames.has(name));
      const grantedTools = requestedTools.filter((name) => catalogNames.has(name));
      const redFlags = cleanList(args.red_flags);
      const contextQuestions = cleanList(args.context_questions);

      const cleanSlug = slugify(args.specialty);
      const agentId = `agent_dyn_${cleanSlug || 'specialist'}`;

      const sections: string[] = [
        [
          heading('Dynamic Specialist Sub-Agent Specification'),
          definitionList([
            ['Agent ID', agentId],
            ['Specialty Label (requester-supplied)', args.specialty.trim()],
            ['Assigned Clinical Focus', args.clinical_focus.trim()],
            [
              'Granted MCP Tools',
              grantedTools.length > 0
                ? grantedTools.join(', ')
                : 'Not chosen by this tool — see the live catalogue below',
            ],
          ]),
        ].join('\n'),
      ];

      if (redFlags.length > 0) {
        sections.push(
          [heading('Red-Flag Escalation Triggers (caller-supplied)'), bulletList(redFlags)].join(
            '\n',
          ),
        );
      }

      if (contextQuestions.length > 0) {
        sections.push(
          [
            heading('Context-Seeking Questions (caller-supplied)'),
            bulletList(contextQuestions),
          ].join('\n'),
        );
      }

      if (grantedTools.length === 0) {
        sections.push(
          [
            heading('Live MCP Tool Catalogue (choose the subset for this sub-agent)'),
            describeToolGroups(catalog),
          ].join('\n'),
        );
      }

      const blueprintJson = JSON.stringify(
        {
          id: agentId,
          name: `${args.specialty.trim()} Specialist Sub-Agent`,
          category: 'medical-specialist',
          mcpTools: grantedTools.length > 0 ? grantedTools : [],
          redFlagTriggers: redFlags,
          contextQuestions: contextQuestions.length > 0 ? contextQuestions : [],
          safetyInvariants: [
            'Never diagnose or prescribe/adjust doses',
            'Judge urgency from the whole message and escalate a life-threatening situation with a concrete time window',
            'Never cite unverified sources or retired FDA pregnancy letter categories',
          ],
        },
        null,
        2,
      );
      sections.push([heading('LibreChat Agent Registration Payload'), blueprintJson].join('\n'));

      const notices: string[] = [
        'This blueprint contains no clinical vocabulary of its own. Everything clinical in it was supplied by the caller; fields the caller left empty came back empty on purpose.',
        'The rendered sub-agent has no keyword-based emergency screen. It must judge urgency itself from the whole message, never from a word list.',
      ];
      if (redFlags.length === 0) {
        notices.push(
          'No red-flag triggers were supplied, so this sub-agent spec has none. Do not read that as "no red flags exist" — derive them from the facts of this case.',
        );
      }
      if (unknownTools.length > 0) {
        notices.push(
          `These requested tool names are not published by this server and were not granted: ${unknownTools.join(', ')}.`,
        );
      }

      return composeResult({
        headline: `Rendered dynamic sub-agent blueprint \`${agentId}\` from the requester's own specialty label (no profile matched, no keyword list consulted).`,
        sections,
        sources: [
          {
            name: 'HealthBench Clinical Evaluation Rubric (Arora et al., OpenAI 2025)',
            url: 'https://arxiv.org/abs/2505.08775',
          },
        ],
        notices,
        env,
      });
    },
  }),
];
