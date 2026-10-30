/**
 * Specialist sub-agent blueprint generator.
 *
 * Renders a persistable `agent_dyn_*` specification from what the calling agent
 * supplies: the specialty label (in the user's own words and language), the
 * clinical focus, and optionally the danger signs, context questions and tool
 * subset it chose. The tool holds no clinical profiles, matches no keywords and
 * enumerates nothing clinical; fields the caller leaves empty come back empty
 * with a notice saying so. Tool names are read from the live registry, so the
 * catalogue cannot drift from the server. Urgency is judged by the model from
 * the whole case, never by this tool.
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
      'Render a persistable LibreChat `agent_dyn_*` specialist sub-agent specification from the specialty label and clinical focus you supply, plus any danger signs, context-seeking questions and tool subset you choose. This tool holds no clinical profiles, no keyword matcher and no danger-sign list of its own: unmatched or unspecified fields come back empty with a notice saying so, never filled in from an author-authored table. Available MCP tool names are read from the live registry so the catalogue cannot drift.',
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
      danger_signs: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Danger signs that should make this sub-agent advise hospital or urgent in-person care, chosen by the calling agent from the evidence it gathered for this case. Omitted = the blueprint ships none and says so; nothing is invented here.',
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
      const dangerSigns = cleanList(args.danger_signs);
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

      if (dangerSigns.length > 0) {
        sections.push(
          [
            heading('Danger Signs Needing Urgent Care (caller-supplied)'),
            bulletList(dangerSigns),
          ].join('\n'),
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
          dangerSigns,
          contextQuestions: contextQuestions.length > 0 ? contextQuestions : [],
          safetyInvariants: [
            'Never diagnose; give a dose only as an official guideline or the drug label states it, with the source',
            'Judge urgency from the whole case and say plainly when hospital care is needed, where and how fast; no scripted emergency-call line',
            'Never cite unverified sources or retired FDA pregnancy letter categories',
          ],
        },
        null,
        2,
      );
      sections.push([heading('LibreChat Agent Registration Payload'), blueprintJson].join('\n'));

      const notices: string[] = [
        'This blueprint contains no clinical vocabulary of its own. Everything clinical in it was supplied by the caller; fields the caller left empty came back empty on purpose.',
        'The rendered sub-agent judges urgency itself from the whole case, never from a word list.',
      ];
      if (dangerSigns.length === 0) {
        notices.push(
          'No danger signs were supplied, so this sub-agent spec has none. Do not read that as "no danger signs exist" — derive them from the facts of this case.',
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
            name: 'LibreChat Agents documentation',
            url: 'https://www.librechat.ai/docs/features/agents',
          },
        ],
        notices,
        env,
      });
    },
  }),
];
