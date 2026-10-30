import { z } from 'zod';
import {
  EMERGENCY_RULESET_VERSION,
  Severity,
  type TriageDecision,
  renderDecision,
  triage,
} from '../safety/emergency.js';
import { RED_FLAG_LIMITATIONS, RED_FLAG_POLICY, redFlagClassifier } from '../safety/redflags-bd.js';
import { composeResult } from '../format.js';
import { defineTool } from '../types.js';

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
/**
 * Machine-readable copy of the decision.
 *
 * The console has to report *what a classifier decided*, and it must not
 * re-derive that from the user's wording — re-deriving it is exactly the
 * keyword matcher this package deleted. Printing the decision in a parseable
 * one-line sentinel lets the host record it verbatim when it persists the tool
 * result, so admin surfaces can read a verdict instead of guessing one.
 *
 * Format is a contract: `<<<TRIAGE_DECISION {json}>>>`, one line, JSON with
 * `severity`, `severityCode`, `decided`, `classifier`, `ruleset`. It is additive
 * — a consumer that cannot find it must report "not assessed", never `routine`.
 */
export const TRIAGE_DECISION_SENTINEL_PREFIX = '<<<TRIAGE_DECISION ';
export const TRIAGE_DECISION_SENTINEL_SUFFIX = '>>>';

export function renderDecisionSentinel(decision: TriageDecision): string {
  const payload = {
    severity: Severity[decision.severity],
    severityCode: decision.severity,
    decided: decision.decided,
    classifier: decision.classifier,
    ruleset: EMERGENCY_RULESET_VERSION,
  };
  return `${TRIAGE_DECISION_SENTINEL_PREFIX}${JSON.stringify(payload)}${TRIAGE_DECISION_SENTINEL_SUFFIX}`;
}

const SOURCES = [
  {
    name: 'WHO — basic emergency care',
    url: 'https://www.who.int/publications/i/item/9789241513081',
  },
];

/**
 * How much say the triage result has over the answer.
 *
 * - `signal` (default since 2026-10-28, "max-help mode"): the result is an
 *   internal hint only — a level and the red flags that matched. It carries no
 *   canned "go to hospital" text, never asks to be run first and never stops the
 *   agent from researching. On a life-threatening red flag the agent writes ONE
 *   short 999 line at the top and then gives full, researched help.
 * - `control`: the original behaviour — policy guidance delivered verbatim,
 *   before any lookup. Set MEDICAL_TRIAGE_MODE=control to restore it.
 *
 * The rule set (../safety/redflags-bd.ts) and the decision engine
 * (../safety/triage.ts) are unchanged in both modes.
 */
export type TriageMode = 'signal' | 'control';
export function triageMode(): TriageMode {
  return (process.env.MEDICAL_TRIAGE_MODE ?? '').trim().toLowerCase() === 'control'
    ? 'control'
    : 'signal';
}

const SIGNAL_DESCRIPTION =
  "Optional internal red-flag signal. Returns a level (emergency | urgent | routine | informational | none | unknown) and the danger patterns that matched in the message (English, Bangla, Banglish). It is NOT an answer and contains no advice: it never replaces research and never needs to run first. Use it, if you like, to decide whether the reply opens with one short 999 line. Pass the user's own words verbatim.";

const CONTROL_DESCRIPTION =
  'Evaluate a message through the deterministic triage policy and return the resulting severity, the evidence behind it, ordered guidance from the policy author, and the assessment’s limits. Call it before any lookup whenever the message describes symptoms, an injury, an ingestion, or emotional distress. This server holds no clinical rule set: severity comes from a classifier (a model or a clinically reviewed knowledge base) and the decision procedure is the auditable pure function in src/safety/triage.ts. Returns severity emergency | urgent | routine | informational | none | unknown. UNKNOWN means no classifier was available — it is a fail-safe, never a clearance, and it must be treated as urgent until a human decides otherwise. Every result includes its own limitations; carry them into the answer.';

/** Compact rendering for `signal` mode: level + matched red flags, no guidance text. */
export function renderSignal(decision: TriageDecision): string {
  const flags = decision.evidence.filter(
    (e) => !e.denied && (e.severity === Severity.emergency || e.severity === Severity.urgent),
  );
  const lines = [
    `Red-flag level: ${Severity[decision.severity].toUpperCase()}` +
      (decision.decided ? '' : ' (not assessed)'),
  ];
  if (flags.length > 0) {
    lines.push('', 'Matched danger patterns:');
    for (const f of flags) lines.push(`- ${f.code} [${Severity[f.severity]}]: ${f.rationale}`);
  } else {
    lines.push(
      '',
      'No danger pattern from the fixed list matched. That says nothing either way about the person.',
    );
  }
  const denied = decision.evidence.filter((e) => e.denied);
  if (denied.length > 0) {
    lines.push('', 'Mentioned but denied / in the past:');
    for (const d of denied) lines.push(`- ${d.code}: ${d.rationale}`);
  }
  lines.push(
    '',
    `Pattern list: ${decision.policy}. Pattern matching, not clinician-reviewed, not a diagnosis.`,
  );
  return lines.join('\n');
}

function signalNotices(decision: TriageDecision): string[] {
  const notices = [
    (decision.decided && decision.severity >= Severity.emergency
      ? ''
      : 'Not a life-threatening red flag: do NOT add a 999 line; give full help and list the danger signs that would make it an emergency. ') +
      'This is an internal hint, not the answer. Do NOT copy it to the user and do NOT reply with a generic "go to a doctor / hospital". Now research the question (disease_knowledge_search, pubmed_search / europe_pmc_search, drug_label, web_search on WHO/CDC/NIH/NICE/NHS/DGHS) and give full, specific, practical help.',
    "Write the whole reply in the language of the user's latest message: Bangla script or Banglish -> Bangla (বাংলা); English -> English. This tool's English text does not change that.",
  ];
  if (decision.decided && decision.severity >= Severity.emergency) {
    notices.unshift(
      'Life-threatening red flag matched: open the reply with ONE short line, copied exactly — Bangla: "🚨 এখনই 999-এ কল করুন।" / English: "🚨 Call 999 now." (the number is always 999 — write it with English digits "999" even in Bangla; for self-harm also Kaan Pete Roi 09612-119911) — then go straight into detailed first-aid steps for right now, what to do on the way / while waiting, danger signs, possible causes and what to tell the hospital. No further referral boilerplate after that line.',
    );
  }
  return notices;
}

export const emergencyTools = [
  defineTool({
    name: 'emergency_triage_check',
    group: 'clinical',
    title:
      triageMode() === 'signal'
        ? 'Red-flag signal (optional, internal hint only)'
        : 'Emergency triage decision procedure (classifier-backed)',
    description: triageMode() === 'signal' ? SIGNAL_DESCRIPTION : CONTROL_DESCRIPTION,
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
      /** Operator knowledge base (Bangladesh red flags, en/bn/Banglish) is the
       *  deployment's classifier + policy; see src/safety/redflags-bd.ts. */
      const decision = await triage(args.message, {
        classifier: redFlagClassifier,
        policy: RED_FLAG_POLICY,
        timeoutMs: Math.min(ctx.env.requestTimeoutMs, 20_000),
      });
      decision.limitations.push(...RED_FLAG_LIMITATIONS);

      if (triageMode() === 'signal') {
        return composeResult({
          headline: `Red-flag signal: ${Severity[decision.severity].toUpperCase()} (internal hint, not an answer)`,
          sections: [renderSignal(decision), renderDecisionSentinel(decision)],
          sources: SOURCES,
          notices: signalNotices(decision),
          env: ctx.env,
        });
      }

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
        sections: [renderDecision(decision), renderDecisionSentinel(decision)],
        sources: SOURCES,
        notices,
        env: ctx.env,
      });
    },
  }),
];
