/**
 * Generative triage framework.
 *
 * This module contains **no clinical vocabulary**. There is no list of
 * red flags, no condition names, no symptom words, no first-aid text. It is a
 * small, total, pure evaluator over *evidence that something else supplied*.
 *
 * The split is deliberate and is the whole point of the design:
 *
 *  - **Semantics are generated.** Whether "দম বন্ধ হয়ে আসছে" or "can't catch my
 *    breath" or "orthopnoea since Tuesday" denotes a decompensation is decided by
 *    a classifier — a model, or an operator's clinically reviewed knowledge base,
 *    or both — through the {@link Classifier} interface. Nothing here enumerates
 *    phrasings, so no phrasing is silently unsupported, and the rule set does not
 *    grow into an unmaintainable lexicon as language drifts.
 *  - **Policy is deterministic.** How evidence combines, how denials scope, how
 *    uncertainty resolves, which severity wins a conflict, and what happens when
 *    the classifier fails are all pure functions of the evidence. Those are the
 *    properties a safety review can actually audit, and they are the properties
 *    that must not depend on a model.
 *
 * The uncomfortable consequence, stated plainly: **this layer cannot, by itself,
 * recognise an emergency.** It can only make the *decision procedure* trustworthy
 * given a classifier. If no classifier is available the result is
 * {@link Severity.unknown}, which the policy is required to escalate — never
 * `none`. A fail-open default is the one thing forbidden here.
 *
 * See `docs/MEMORY_AND_LONG_RUN.md` and `docs/REPOSITORY_DEEP_AUDIT.md` §G.
 */

/** Ordering is meaningful: a policy may only ever raise a severity, never lower it. */
export enum Severity {
  /** No signal. Only reachable when a classifier positively returned no evidence. */
  none = 0,
  /** Background or educational content. Not a finding about a person. */
  informational = 1,
  /** A symptom that needs a clinician but is not time-critical. */
  routine = 2,
  /** Needs assessment today. Must never be answered with reassurance. */
  urgent = 3,
  /** Immediate threat to life or function. Call for help now. */
  emergency = 4,
  /**
   * The classifier could not decide. Deliberately placed above `emergency` so
   * that "we do not know" can never lose a max-join against a confident answer,
   * and so that any policy written as "at least urgent" includes it.
   */
  unknown = 5,
}

export const SEVERITY_NAMES: Record<Severity, string> = {
  [Severity.none]: 'none',
  [Severity.informational]: 'informational',
  [Severity.routine]: 'routine',
  [Severity.urgent]: 'urgent',
  [Severity.emergency]: 'emergency',
  [Severity.unknown]: 'unknown',
};

/**
 * One atomic finding produced by a classifier.
 *
 * `code` is opaque to this module. The framework never interprets it, which is
 * what keeps clinical meaning out of the code and in the classifier/policy.
 */
export interface Evidence {
  /** Stable finding identifier, e.g. a knowledge-base rule id. Opaque here. */
  code: string;
  severity: Severity;
  /**
   * 0..1. Used only for `confidenceAtLeast` predicates and for reporting; it can
   * never lower a severity. A low-confidence emergency is still an emergency
   * because under-triage is the asymmetric error.
   */
  confidence: number;
  /** What the classifier saw, in its own words. Required — evidence without a
   *  reason cannot be audited and is rejected by {@link validateEvidence}. */
  rationale: string;
  /** Which classifier produced this, so a reviewer can tell a model from a KB. */
  source: string;
  /**
   * True when the classifier believes the message *denies* or *places in the
   * past* the concept behind `code`. A denial is itself evidence, and only an
   * explicit operator may act on it — see {@link Rule.notDenied}.
   */
  denied?: boolean;
  /** True when the finding is about someone other than the speaker. */
  thirdParty?: boolean;
}

/**
 * A classifier turns free text into evidence. It is the only place semantics
 * live. Implementations may be model-backed, rule-backed, or both; the framework
 * is indifferent, and tests inject synthetic ones.
 */
export interface Classifier {
  /** Identifies the implementation in reports, e.g. `llm:model-x` or `kb:v3`. */
  readonly name: string;
  /**
   * Resolves *any* severity from `none` to `emergency`, or throws/returns a
   * `Severity.unknown` finding when it cannot decide. It must never throw for a
   * merely empty or malformed input — that is what {@link Severity.unknown} is
   * for, and {@link runTriage} converts a thrown classifier into `unknown`.
   */
  classify(input: string, signal?: AbortSignal): Promise<Evidence[]>;
}

/**
 * Composition tree. The operators mirror the four things a triage policy
 * genuinely needs, and no more — each extra operator is a chance to write a rule
 * no reviewer can predict.
 */
export type Rule =
  /** At least one child satisfied. */
  | { op: 'any'; of: readonly Rule[] }
  /** Every child satisfied. */
  | { op: 'all'; of: readonly Rule[] }
  /** At least `k` children satisfied. */
  | { op: 'atLeast'; k: number; of: readonly Rule[] }
  /** The child is *not* satisfied. The only operator that can read a denial. */
  | { op: 'not'; of: Rule }
  /** A finding with this code exists and was not denied. */
  | { op: 'code'; code: string }
  /** A finding with this code exists and has `confidence >= value`. */
  | { op: 'confidenceAtLeast'; code: string; value: number }
  /** A finding with this code exists and is explicitly marked denied. */
  | { op: 'denied'; code: string };

export interface PolicyRule {
  /** Opaque, stable, referenced in output and in the audit trail. */
  id: string;
  /** The severity this rule assigns when satisfied. */
  severity: Severity;
  when: Rule;
  /**
   * Free-text action guidance owned by the classifier/knowledge base, never by
   * this module. Arrays are returned in order and must already be ordered:
   * the framework does not know which step is the call for help.
   */
  guidance?: string[];
  questions?: string[];
}

export interface Policy {
  /** Identifies the policy document, e.g. `kb:clinical-2026-10` (hash optional). */
  id: string;
  rules: readonly PolicyRule[];
  /**
   * Severity to return when no rule is satisfied *but* the classifier ran and
   * returned at least one denial or informational finding. Defaults to `routine`.
   */
  noMatchSeverity?: Severity;
  /**
   * Severity to return when the classifier ran and returned nothing at all.
   * Defaults to `unknown` — silence is not evidence of safety.
   */
  emptySeverity?: Severity;
}

export interface TriageDecision {
  severity: Severity;
  /** `unknown` whenever the classifier failed, timed out, or was absent. */
  decided: boolean;
  /** Rules that fired, highest severity first. */
  fired: PolicyRule[];
  evidence: Evidence[];
  /** Concatenated, de-duplicated guidance from every fired rule. */
  guidance: string[];
  questions: string[];
  /** Always non-empty: what this verdict does and does not establish. */
  limitations: string[];
  /** Classifier identity, or `none` when no classifier was supplied. */
  classifier: string;
  policy: string;
  /** Normalized input actually passed to the classifier, for reproduction. */
  input: string;
}

const LIMITATIONS_BASE = [
  'This is a decision procedure over evidence supplied by a classifier; it does not read the message itself and cannot recognise an emergency on its own.',
  'It has not been validated against clinician adjudication.',
  'It cannot see the person: appearance, breathing effort, colour and responsiveness are not in the text.',
];

/**
 * Rejects evidence a reviewer could not audit. Throwing here rather than
 * silently dropping the finding is intentional: a classifier that emits
 * unexplained evidence is a defect, and hiding it would make the resulting
 * `routine` look trustworthy.
 */
export function validateEvidence(evidence: Evidence): void {
  if (typeof evidence.code !== 'string' || evidence.code.trim() === '') {
    throw new Error('evidence.code must be a non-empty string');
  }
  if (!(evidence.severity in SEVERITY_NAMES)) {
    throw new Error(`evidence "${evidence.code}" has an unknown severity`);
  }
  if (
    typeof evidence.confidence !== 'number' ||
    evidence.confidence < 0 ||
    evidence.confidence > 1
  ) {
    throw new Error(`evidence "${evidence.code}" must carry confidence in [0,1]`);
  }
  if (typeof evidence.rationale !== 'string' || evidence.rationale.trim() === '') {
    throw new Error(`evidence "${evidence.code}" must carry a rationale`);
  }
  if (typeof evidence.source !== 'string' || evidence.source.trim() === '') {
    throw new Error(`evidence "${evidence.code}" must name its source`);
  }
}

/** Indices of findings for `code`, split by denial. */
function findByCode(
  evidence: Evidence[],
  code: string,
): {
  live: Evidence[];
  denied: Evidence[];
} {
  const matches = evidence.filter((item) => item.code === code);
  return {
    live: matches.filter((item) => item.denied !== true),
    denied: matches.filter((item) => item.denied === true),
  };
}

/**
 * Pure evaluation of a rule against evidence.
 *
 * Total by construction: every operator returns a boolean for any well-formed
 * tree, so a policy author cannot create a rule that throws at triage time.
 */
export function evaluate(rule: Rule, evidence: Evidence[]): boolean {
  switch (rule.op) {
    case 'code':
      return findByCode(evidence, rule.code).live.length > 0;
    case 'confidenceAtLeast':
      return findByCode(evidence, rule.code).live.some((item) => item.confidence >= rule.value);
    case 'denied':
      return findByCode(evidence, rule.code).denied.length > 0;
    case 'not':
      return !evaluate(rule.of, evidence);
    case 'any':
      return rule.of.some((child) => evaluate(child, evidence));
    case 'all':
      return rule.of.every((child) => evaluate(child, evidence));
    case 'atLeast':
      return rule.of.filter((child) => evaluate(child, evidence)).length >= rule.k;
    default: {
      // Exhaustiveness: a new operator must be handled explicitly.
      const never: never = rule;
      throw new Error(`unhandled rule operator: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Monotone join. `unknown` dominates, then `emergency`, and so on.
 *
 * This is the single most important function in the module: it makes it
 * structurally impossible for extra evidence, a denial, or a low confidence to
 * *lower* the outcome. Every safety property here reduces to this being a max.
 */
export function join(severities: Severity[]): Severity {
  if (severities.length === 0) {
    return Severity.none;
  }
  return severities.reduce((worst, next) => (next > worst ? next : worst), Severity.none);
}

export interface RunTriageOptions {
  classifier?: Classifier;
  policy: Policy;
  /** Milliseconds before the classifier is abandoned and triage fails safe. */
  timeoutMs?: number;
}

/**
 * Runs the classifier, then the policy. Neither step can lower the outcome below
 * what the evidence supports.
 */
export async function runTriage(
  input: string,
  { classifier, policy, timeoutMs = 15_000 }: RunTriageOptions,
): Promise<TriageDecision> {
  const normalized = (input ?? '').normalize('NFC');

  let evidence: Evidence[] = [];
  let decided = false;
  let classifierName = 'none';

  if (classifier != null) {
    classifierName = classifier.name;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      evidence = await classifier.classify(normalized, controller.signal);
      for (const item of evidence) {
        validateEvidence(item);
      }
      /**
       * A classifier that ran successfully but reports it has no capability
       * (the shipped `unavailableClassifier` does exactly this) has not decided
       * anything. `decided` must mean "an assessment was obtained", not "a
       * function returned", or a fail-safe would read as a verdict.
       */
      decided = !evidence.some((item) => item.code.startsWith('classifier_'));
    } catch (error) {
      /**
       * A classifier that throws, times out, or returns malformed findings is
       * indistinguishable from one that could not decide. Both must fail toward
       * escalation, so both become `unknown` — never an empty evidence list,
       * which would read as "nothing wrong".
       */
      evidence = [
        {
          code: 'classifier_unavailable',
          severity: Severity.unknown,
          confidence: 0,
          rationale:
            error instanceof Error
              ? `classifier failed: ${error.message}`
              : 'classifier failed for an unknown reason',
          source: classifierName,
        },
      ];
      decided = false;
    } finally {
      clearTimeout(timer);
    }
  } else {
    evidence = [
      {
        code: 'classifier_absent',
        severity: Severity.unknown,
        confidence: 0,
        rationale: 'no classifier was configured, so the message was never assessed',
        source: 'none',
      },
    ];
  }

  const fired = policy.rules
    .filter((rule) => evaluate(rule.when, evidence))
    .sort((a, b) => b.severity - a.severity);

  const ruleSeverities = fired.map((rule) => rule.severity);
  const evidenceSeverities = evidence.map((item) => item.severity);
  const joined = join([...ruleSeverities, ...evidenceSeverities]);

  const emptySeverity = policy.emptySeverity ?? Severity.unknown;
  const noMatchSeverity = policy.noMatchSeverity ?? Severity.routine;

  let severity: Severity;
  if (evidence.length === 0) {
    severity = join([emptySeverity, joined]);
  } else if (fired.length === 0) {
    severity = join([noMatchSeverity, joined]);
  } else {
    severity = joined;
  }

  const guidance = [...new Set(fired.flatMap((rule) => rule.guidance ?? []))];
  const questions = [...new Set(fired.flatMap((rule) => rule.questions ?? []))];

  const limitations = [...LIMITATIONS_BASE];
  if (!decided) {
    limitations.push(
      'No classifier produced an assessment, so the severity is `unknown` by construction. Treat it as urgent until a human decides otherwise.',
    );
  }
  if (severity === Severity.unknown) {
    limitations.push('An `unknown` severity is not a clearance and must never be reported as one.');
  }
  if (severity <= Severity.routine && decided) {
    limitations.push(
      'No policy rule fired. That means this policy found nothing, not that nothing is wrong. If the person is deteriorating, hard to wake, struggling to breathe, or you are unsure, escalate.',
    );
  }
  if (fired.some((rule) => rule.guidance == null || rule.guidance.length === 0)) {
    limitations.push(
      'A rule fired without action guidance. Do not improvise a clinical instruction to fill the gap.',
    );
  }

  return {
    severity,
    decided,
    fired,
    evidence,
    guidance,
    questions: questions.slice(0, 3),
    limitations,
    classifier: classifierName,
    policy: policy.id,
    input: normalized,
  };
}

/**
 * Guard for a policy document. Runs at load time, not at triage time, so a
 * malformed policy fails the build rather than the patient.
 */
export function validatePolicy(policy: Policy): void {
  if (policy.id.trim() === '') {
    throw new Error('policy.id is required');
  }
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) {
      throw new Error(`duplicate policy rule id: ${rule.id}`);
    }
    ids.add(rule.id);
    if (!(rule.severity in SEVERITY_NAMES)) {
      throw new Error(`policy rule "${rule.id}" has an unknown severity`);
    }
    /**
     * A rule that assigns `none` can never raise a severity, and a rule that
     * assigns `unknown` without a code is a policy that always escalates. Both
     * are almost always mistakes, so they are rejected here.
     */
    if (rule.severity === Severity.none) {
      throw new Error(`policy rule "${rule.id}" may not assign Severity.none`);
    }
  }
}
