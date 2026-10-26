/**
 * Emergency triage entry point.
 *
 * This file used to hold a hand-authored lexicon of clinical red flags
 * (~1,800 lines of symptom words, misspellings and per-category playbooks) with a
 * rule table layered on top. It has been removed deliberately.
 *
 * Why: an enumerated word list is a *maintained* asset, not a safety guarantee.
 * Every phrasing it does not contain is silently unsupported, it cannot be
 * reviewed for clinical validity as a whole, it rots as language drifts, and it
 * gives a false sense of coverage — a reviewer sees 39 concepts and assumes 39
 * concepts were considered clinically rather than improvised.
 *
 * What replaces it: semantics come from a {@link Classifier} — a model, or an
 * operator's clinically reviewed knowledge base, or the two together — and the
 * decision procedure is the pure, auditable policy engine in `./triage.ts`.
 * Nothing in this package enumerates symptom words any more.
 *
 * The consequence, stated where it cannot be missed: **with no classifier wired
 * in, this returns `unknown`, not `routine`.** That is the correct fail-safe, and
 * it is asserted by `src/__tests__/triage.spec.ts`.
 */
import {
  type Classifier,
  type Policy,
  type PolicyRule,
  Severity,
  runTriage,
  type TriageDecision,
  join,
  validatePolicy,
} from './triage.js';

export { Severity, runTriage, join, validatePolicy };
export type { Classifier, Policy, PolicyRule, TriageDecision };
export const EMERGENCY_RULESET_VERSION = '2.0.0-generation';

/**
 * A classifier that never produces a verdict.
 *
 * This is the default so that a deployment which has not configured a classifier
 * fails toward escalation rather than toward silence. It is a provider, not a
 * fallback rule set: it contributes no clinical knowledge at all.
 */
export const unavailableClassifier: Classifier = {
  name: 'none',
  async classify() {
    return [
      {
        code: 'classifier_absent',
        severity: Severity.unknown,
        confidence: 0,
        rationale: 'this server has no model, so the message was never assessed',
        source: 'none',
      },
    ];
  },
};

/**
 * Wraps a host-supplied function as a classifier.
 *
 * The host is where a model lives. LibreChat has one; a stdio MCP server does
 * not, which is why the MCP tool ships with {@link unavailableClassifier} and the
 * real classification belongs on the host side of the boundary.
 */
export function fromHostClassifier(
  name: string,
  classify: (
    input: string,
    signal?: AbortSignal,
  ) => Promise<
    Parameters<Classifier['classify']>[0] extends never
      ? never
      : Awaited<ReturnType<Classifier['classify']>>
  >,
): Classifier {
  return { name, classify };
}

/**
 * The empty policy.
 *
 * It contains no rules because rules encode clinical judgement, and clinical
 * judgement is not invented in this repository. It evaluates honestly: no rule
 * fires, the joined severity comes from the evidence, and the limitations say so.
 *
 * An operator replaces this wholesale with a clinically reviewed document
 * (see `docs/MEMORY_AND_LONG_RUN.md` §4 and the `MEDICAL_TRIAGE_POLICY` env var).
 */
export const EMPTY_POLICY: Policy = {
  id: 'empty-no-clinical-rules',
  rules: [],
  noMatchSeverity: Severity.unknown,
  emptySeverity: Severity.unknown,
};

export interface TriageOptions {
  classifier?: Classifier;
  policy?: Policy;
  timeoutMs?: number;
}

/**
 * Runs triage. Exported for tests, the MCP tool, and host integration.
 *
 * There is intentionally no default that guesses. Without a classifier the
 * verdict is `unknown`, and `decided` is false so a caller cannot mistake it for
 * an assessment.
 */
export async function triage(
  input: string,
  { classifier, policy = EMPTY_POLICY, timeoutMs }: TriageOptions = {},
): Promise<TriageDecision> {
  validatePolicy(policy);
  return runTriage(input, { classifier, policy, timeoutMs });
}

/**
 * Renders a decision for a model to read. Ordering is whatever the policy put in
 * `guidance`; this function never reorders clinical content, because the
 * framework does not know which step is the call for help.
 */
export function renderDecision(decision: TriageDecision): string {
  const lines: string[] = [
    `Triage severity: ${Severity[decision.severity].toUpperCase()}` +
      (decision.decided ? '' : ' (undecided — no classifier)'),
    `policy: ${decision.policy} · classifier: ${decision.classifier}`,
  ];

  if (decision.fired.length > 0) {
    lines.push('', 'Rules satisfied (highest severity first):');
    for (const rule of decision.fired) {
      lines.push(`- ${rule.id} -> ${Severity[rule.severity]}`);
    }
  } else {
    lines.push(
      '',
      'No policy rule was satisfied. This is a statement about this policy and this classifier, not about the person.',
    );
  }

  if (decision.guidance.length > 0) {
    lines.push('', 'Guidance, in the policy author’s order:');
    decision.guidance.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  if (decision.questions.length > 0) {
    lines.push(
      '',
      `Answer these only if it does not delay the steps above: ${decision.questions.join(' ')}`,
    );
  }

  if (decision.evidence.length > 0) {
    lines.push('', 'Evidence:');
    for (const item of decision.evidence) {
      lines.push(
        `- ${item.code} [${Severity[item.severity]}, confidence ${item.confidence.toFixed(2)}, ${item.source}]${item.denied ? ' (denied)' : ''}: ${item.rationale}`,
      );
    }
  }

  lines.push('', 'Limits of this assessment:');
  decision.limitations.forEach((limitation) => lines.push(`- ${limitation}`));
  lines.push(
    '',
    `ruleset ${EMERGENCY_RULESET_VERSION} · policy evaluation is deterministic; semantics are not`,
  );
  return lines.join('\n');
}
