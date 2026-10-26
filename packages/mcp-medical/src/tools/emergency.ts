import { z } from 'zod';
import { composeResult } from '../format.js';
import { defineTool } from '../types.js';
import {
  EMERGENCY_RULESET_VERSION,
  Severity,
  renderDecision,
  triage,
} from '../safety/emergency.js';

/**
 * The triage tool.
 *
 * It contains no clinical rule set. It runs whatever classifier and policy the
 * deployment supplied, and reports the decision together with its limits.
 *
 * The important honesty here: a stdio MCP server is **not given a model**. It
 * cannot classify free text by itself, so with no classifier configured this tool
 * returns `UNKNOWN` — never `ROUTINE`. That is the fail-safe direction, and it is
 * what stops a deployment from believing it has emergency coverage it does not
 * have. Real classification belongs on the host side of the MCP boundary, where
 * the agent's model already lives; see `docs/MEMORY_AND_LONG_RUN.md`.
 *
 * Unlike every other tool, this one cannot be removed by `MEDICAL_TOOL_GROUPS` or
 * `MEDICAL_TOOL_EXCLUDE` — see `selectTools`.
 */
const SOURCES = [
  {
    name: 'WHO — basic emergency care',
    url: 'https://www.who.int/publications/i/item/9789241513081',
  },
];

export const emergencyTools = [
  defineTool({
    name: 'emergency_triage_check',
    group: 'clinical',
    title: 'Emergency triage decision procedure (classifier-backed)',
    description:
      'Evaluate a message through the deterministic triage policy and return the resulting severity, the evidence behind it, ordered guidance from the policy author, and the assessment’s limits. Call it before any lookup whenever the message describes symptoms, an injury, an ingestion, or emotional distress. This server holds no clinical rule set: severity comes from a classifier (a model or a clinically reviewed knowledge base) and the decision procedure is the auditable pure function in src/safety/triage.ts. Returns severity emergency | urgent | routine | informational | none | unknown. UNKNOWN means no classifier was available — it is a fail-safe, never a clearance, and it must be treated as urgent until a human decides otherwise. Every result includes its own limitations; carry them into the answer.',
    inputSchema: {
      message: z
        .string()
        .min(1)
        .max(8_000)
        .describe(
          "The user's own words about what is happening, verbatim and untranslated — including Bangla or mixed-language text. Do not summarise or clean up the message: negation ('no pain'), time framing ('three years ago') and uncertainty are part of the input a classifier is asked to read.",
        ),
    },
    handler: async (args, ctx) => {
      const decision = await triage(args.message, {
        timeoutMs: Math.min(ctx.env.requestTimeoutMs, 20_000),
      });

      const inEmergencyBand = decision.severity >= Severity.emergency;

      const notices: string[] = [];
      if (!decision.decided) {
        notices.push(
          'No classifier produced an assessment, so this is not a result — it is the absence of one. Treat the situation as urgent, tell the user you cannot screen it here, and do not present this as reassurance.',
          'This server has no model and therefore no clinical knowledge of its own. Do not fill the gap by inventing first aid or a diagnosis here.',
        );
      } else if (inEmergencyBand) {
        notices.push(
          'Deliver the call-for-help line and the guidance in this reply, in the order the policy gives them, before any lookup.',
          'Do not diagnose, do not add, stop or change any medicine, and do not tell a possibly-affected person to drive themselves.',
        );
      } else {
        notices.push(
          'A non-emergency severity is not a clearance. If the person is worsening, hard to wake, struggling to breathe, or you are unsure, escalate instead of reassuring.',
        );
      }

      return composeResult({
        headline: `Triage severity: ${Severity[decision.severity].toUpperCase()} (ruleset ${EMERGENCY_RULESET_VERSION})`,
        sections: [renderDecision(decision)],
        sources: SOURCES,
        notices,
        env: ctx.env,
      });
    },
  }),
];
