import {
  type Classifier,
  type Evidence,
  type Policy,
  Severity,
  evaluate,
  join,
  runTriage,
  validateEvidence,
  validatePolicy,
} from '../safety/triage.js';
import {
  EMPTY_POLICY,
  EMERGENCY_RULESET_VERSION,
  renderDecision,
  triage,
  unavailableClassifier,
} from '../safety/emergency.js';

/**
 * Tests for the triage framework.
 *
 * There is deliberately **no clinical vocabulary in this file**. The framework's
 * job is the decision procedure, so the tests drive it with synthetic finding
 * codes ("alpha", "beta") and assert the properties that make the procedure
 * trustworthy regardless of what a classifier supplies:
 *
 *   - monotonicity: adding evidence can never lower a severity;
 *   - fail-safe: an absent, throwing, timing-out or malformed classifier is
 *     undecided and escalates, never `none`/`routine`;
 *   - denial scoping: a denial is inert unless a policy explicitly reads it;
 *   - totality: every operator evaluates for any well-formed tree;
 *   - load-time validation: a malformed policy fails before triage, not during.
 *
 * Whether a real classifier recognises a real emergency is a separate question,
 * measured by `eval/` against a live model. Conflating the two is how a lexicon
 * ends up being mistaken for clinical validation.
 */

/** A classifier whose findings are fixed, so the policy is the only variable. */
function fixed(evidence: Evidence[], name = 'test:fixed'): Classifier {
  return { name, classify: async () => evidence };
}

function finding(over: Partial<Evidence> = {}): Evidence {
  return {
    code: 'alpha',
    severity: Severity.urgent,
    confidence: 0.9,
    rationale: 'synthetic finding for the policy engine',
    source: 'test:fixed',
    ...over,
  };
}

const rule = (over: Partial<Policy['rules'][number]> = {}) => ({
  id: 'r1',
  severity: Severity.emergency,
  when: { op: 'code', code: 'alpha' } as const,
  guidance: ['step one', 'step two'],
  questions: ['q1'],
  ...over,
});

describe('join — monotone worst-case', () => {
  it('never returns less than its strongest input', () => {
    const values = Object.values(Severity).filter(
      (value): value is Severity => typeof value === 'number',
    );
    for (const a of values) {
      for (const b of values) {
        expect(join([a, b])).toBeGreaterThanOrEqual(a);
        expect(join([a, b])).toBeGreaterThanOrEqual(b);
      }
    }
  });

  it('treats unknown as top so an undecided classifier cannot lose', () => {
    expect(join([Severity.emergency, Severity.unknown])).toBe(Severity.unknown);
    expect(join([Severity.none, Severity.unknown])).toBe(Severity.unknown);
  });

  it('returns none only for an empty list', () => {
    expect(join([])).toBe(Severity.none);
  });
});

describe('evaluate — totality and operators', () => {
  const evidence = [finding(), finding({ code: 'beta', severity: Severity.routine })];

  it('evaluates every operator on every input without throwing', () => {
    const codes = ['alpha', 'beta', 'absent'];
    const trees = codes.flatMap((code) => [
      { op: 'code', code } as const,
      { op: 'denied', code } as const,
      { op: 'confidenceAtLeast', code, value: 0.5 } as const,
      { op: 'not', of: { op: 'code', code } as const } as const,
      { op: 'any', of: [{ op: 'code', code } as const] } as const,
      { op: 'all', of: [{ op: 'code', code } as const] } as const,
      { op: 'atLeast', k: 2, of: [{ op: 'code', code } as const] } as const,
    ]);
    for (const tree of trees) {
      for (const input of [[], evidence, [finding({ denied: true })]]) {
        expect(typeof evaluate(tree, input)).toBe('boolean');
      }
    }
  });

  it('implements atLeast by exact count', () => {
    const tree = {
      op: 'atLeast',
      k: 2,
      of: [
        { op: 'code', code: 'alpha' },
        { op: 'code', code: 'beta' },
        { op: 'code', code: 'absent' },
      ],
    } as const;
    expect(evaluate(tree, evidence)).toBe(true);
    expect(evaluate({ ...tree, k: 3 }, evidence)).toBe(false);
  });

  it('honours the confidence threshold without letting low confidence lower severity', () => {
    const low = [finding({ confidence: 0.1 })];
    expect(evaluate({ op: 'confidenceAtLeast', code: 'alpha', value: 0.5 }, low)).toBe(false);
    expect(evaluate({ op: 'code', code: 'alpha' }, low)).toBe(true);
  });
});

describe('denial scoping', () => {
  const denied = [finding({ denied: true })];

  it('makes a denied finding inert for code/confidence predicates', () => {
    expect(evaluate({ op: 'code', code: 'alpha' }, denied)).toBe(false);
    expect(evaluate({ op: 'confidenceAtLeast', code: 'alpha', value: 0.1 }, denied)).toBe(false);
    expect(evaluate({ op: 'denied', code: 'alpha' }, denied)).toBe(true);
  });

  it('lets a policy read the denial explicitly, and only explicitly', () => {
    expect(evaluate({ op: 'not', of: { op: 'code', code: 'alpha' } }, denied)).toBe(true);
    expect(evaluate({ op: 'code', code: 'alpha' }, [finding()])).toBe(true);
  });

  it('does not let a denial in one code suppress a different code', () => {
    const mixed = [finding({ code: 'alpha', denied: true }), finding({ code: 'beta' })];
    expect(evaluate({ op: 'code', code: 'beta' }, mixed)).toBe(true);
  });
});

describe('runTriage — fail-safe behaviour', () => {
  it('fails toward unknown, not routine, when no classifier is supplied', async () => {
    const decision = await runTriage('anything', { policy: EMPTY_POLICY });
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.decided).toBe(false);
    expect(decision.classifier).toBe('none');
    expect(decision.limitations.join(' ')).toMatch(/must never be reported as one/i);
  });

  it('fails safe when the classifier throws', async () => {
    const broken: Classifier = {
      name: 'test:throws',
      classify: async () => {
        throw new Error('upstream exploded');
      },
    };
    const decision = await runTriage('anything', { classifier: broken, policy: EMPTY_POLICY });
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.decided).toBe(false);
    expect(decision.evidence[0].rationale).toMatch(/upstream exploded/);
  });

  it('fails safe when the classifier times out', async () => {
    const slow: Classifier = {
      name: 'test:slow',
      classify: async (_input, signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return [];
      },
    };
    const decision = await runTriage('anything', {
      classifier: slow,
      policy: EMPTY_POLICY,
      timeoutMs: 10,
    });
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.decided).toBe(false);
  });

  it('rejects malformed evidence instead of silently trusting it', async () => {
    const malformed: Classifier = {
      name: 'test:malformed',
      classify: async () => [
        { code: 'x', severity: 99, confidence: 2, rationale: '', source: '' } as never,
      ],
    };
    const decision = await runTriage('anything', { classifier: malformed, policy: EMPTY_POLICY });
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.decided).toBe(false);
  });

  it('fails safe when the classifier returns an empty list', async () => {
    const decision = await runTriage('anything', {
      classifier: fixed([]),
      policy: { ...EMPTY_POLICY, id: 'p' },
    });
    // Empty evidence is not evidence of safety.
    expect(decision.severity).toBe(Severity.unknown);
  });
});

describe('runTriage — policy semantics', () => {
  it('applies the acting rule, in the author’s order, without reordering', async () => {
    const policy: Policy = { id: 'p', rules: [rule()] };
    const decision = await runTriage('x', { classifier: fixed([finding()]), policy });
    expect(decision.fired.map((r) => r.id)).toEqual(['r1']);
    expect(decision.guidance).toEqual(['step one', 'step two']);
    expect(decision.questions).toEqual(['q1']);
  });

  it('orders fired rules by descending severity', async () => {
    const policy: Policy = {
      id: 'p',
      rules: [
        rule({ id: 'low', severity: Severity.routine, when: { op: 'code', code: 'alpha' } }),
        rule({
          id: 'high',
          severity: Severity.emergency,
          when: { op: 'any', of: [{ op: 'code', code: 'alpha' }] },
        }),
      ],
    };
    const decision = await runTriage('x', { classifier: fixed([finding()]), policy });
    expect(decision.fired.map((r) => r.id)).toEqual(['high', 'low']);
    expect(decision.severity).toBe(Severity.emergency);
  });

  it('is monotone: adding evidence never lowers the outcome', async () => {
    const policy: Policy = { id: 'p', rules: [rule()] };
    const base = await runTriage('x', { classifier: fixed([finding()]), policy });
    const more = await runTriage('x', {
      classifier: fixed([finding(), finding({ code: 'beta', severity: Severity.emergency })]),
      policy,
    });
    expect(more.severity).toBeGreaterThanOrEqual(base.severity);
  });

  it('uses noMatchSeverity when a classifier ran but no rule fired', async () => {
    const policy: Policy = {
      id: 'p',
      rules: [rule({ when: { op: 'code', code: 'never' } })],
      noMatchSeverity: Severity.routine,
    };
    // Evidence severity is part of the join, so use informational evidence:
    // no rule fires, and the floor is the policy's noMatchSeverity.
    const decision = await runTriage('x', {
      classifier: fixed([finding({ severity: Severity.informational })]),
      policy,
    });
    expect(decision.severity).toBe(Severity.routine);
    expect(decision.fired).toEqual([]);
    expect(decision.limitations.join(' ')).toMatch(/not that nothing is wrong/i);
  });

  it('does not let noMatchSeverity hide an unknown classifier', async () => {
    const policy: Policy = {
      id: 'p',
      rules: [],
      noMatchSeverity: Severity.none,
      emptySeverity: Severity.unknown,
    };
    const decision = await runTriage('x', { policy });
    expect(decision.severity).toBe(Severity.unknown);
  });

  it('flags a rule that fired without guidance instead of improvising one', async () => {
    const policy: Policy = { id: 'p', rules: [rule({ guidance: undefined })] };
    const decision = await runTriage('x', { classifier: fixed([finding()]), policy });
    expect(decision.guidance).toEqual([]);
    expect(decision.limitations.join(' ')).toMatch(/do not improvise/i);
  });

  it('records the classifier, policy and input for reproduction', async () => {
    const decision = await runTriage('  Some   input  ', {
      classifier: fixed([finding()], 'kb:v7'),
      policy: { id: 'policy-2026-10', rules: [rule()] },
    });
    expect(decision.classifier).toBe('kb:v7');
    expect(decision.policy).toBe('policy-2026-10');
    expect(decision.input).toBe('  Some   input  ');
  });
});

describe('validatePolicy — fails at load, not at triage', () => {
  it('rejects duplicate rule ids', () => {
    expect(() => validatePolicy({ id: 'p', rules: [rule(), rule()] })).toThrow(/duplicate/i);
  });

  it('rejects a rule that assigns none, which could only lower a severity', () => {
    expect(() => validatePolicy({ id: 'p', rules: [rule({ severity: Severity.none })] })).toThrow(
      /may not assign/i,
    );
  });

  it('rejects an unknown severity', () => {
    expect(() => validatePolicy({ id: 'p', rules: [rule({ severity: 42 as Severity })] })).toThrow(
      /unknown severity/i,
    );
  });

  it('accepts the shipped empty policy', () => {
    expect(() => validatePolicy(EMPTY_POLICY)).not.toThrow();
  });
});

describe('validateEvidence — no unauditable findings', () => {
  it('requires a rationale and a source', () => {
    expect(() => validateEvidence(finding({ rationale: '' }))).toThrow(/rationale/);
    expect(() => validateEvidence(finding({ source: '' }))).toThrow(/source/);
  });

  it('requires confidence in range', () => {
    expect(() => validateEvidence(finding({ confidence: 1.5 }))).toThrow(/confidence/);
  });
});

describe('generative contract — no built-in clinical vocabulary', () => {
  it('ships a policy with no rules and no clinical content', () => {
    expect(EMPTY_POLICY.rules).toEqual([]);
    const serialized = JSON.stringify(EMPTY_POLICY).toLowerCase();
    for (const forbidden of ['chest', 'stroke', 'bleed', 'seizure', 'breath']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('contains no clinical vocabulary in the framework source either', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    for (const file of ['../safety/triage.ts', '../safety/emergency.ts']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8').toLowerCase();
      for (const forbidden of [
        'chest pain',
        'cardiac arrest',
        'anaphyla',
        'seizure',
        'hemorrhag',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('has no imports in the pure evaluator, so evaluation cannot reach a network', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, '../safety/triage.ts'), 'utf8');
    expect(source).not.toMatch(/^import\s/m);
  });

  it('leaves semantics to the classifier, and says so in the output', async () => {
    const decision = await triage('any message');
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.limitations.join(' ')).toMatch(/does not read the message itself/i);
    expect(decision.limitations.join(' ')).toMatch(
      /not been validated against clinician adjudication/i,
    );
  });

  it('falls back to the unavailable classifier rather than inventing a verdict', async () => {
    const decision = await triage('x', { classifier: unavailableClassifier });
    expect(decision.severity).toBe(Severity.unknown);
    expect(decision.decided).toBe(false);
  });
});

describe('renderDecision', () => {
  it('never reorders guidance, and states the severity first', async () => {
    const decision = await runTriage('x', {
      classifier: fixed([finding()]),
      policy: { id: 'p', rules: [rule({ guidance: ['bbbb', 'aaaa'] })] },
    });
    const rendered = renderDecision(decision);
    expect(rendered.split('\n')[0]).toMatch(/triage severity: EMERGENCY/i);
    expect(rendered.indexOf('bbbb')).toBeLessThan(rendered.indexOf('aaaa'));
  });

  it('marks an undecided verdict as undecided in the first line', async () => {
    const rendered = renderDecision(await triage('x'));
    expect(rendered.split('\n')[0]).toMatch(/undecided/i);
  });

  it('always carries the ruleset version and the determination boundary', async () => {
    const rendered = renderDecision(await triage('x'));
    expect(rendered).toContain(EMERGENCY_RULESET_VERSION);
    expect(rendered).toMatch(/policy evaluation is deterministic; semantics are not/);
  });
});
