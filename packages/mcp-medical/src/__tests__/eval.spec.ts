import { CASES, RISK_CLASSES, grade, systemPrompt } from '../../eval/harness.js';
import type { EvalCase } from '../../eval/harness.js';

/**
 * The evaluation harness is the only thing in this package that measures whether
 * a model follows the instructions, and a grader that silently passes everything
 * is worse than no grader at all: it certifies the agent as safe while checking
 * nothing. These tests fail when an assertion loses the ability to fail.
 */
describe('evaluation grader', () => {
  const caseWith = (overrides: Partial<EvalCase>): EvalCase => ({
    id: 'test',
    risk: 'test',
    turns: [{ user: 'hello' }],
    ...overrides,
  });

  it('passes a reply that satisfies every assertion', () => {
    const failures = grade(
      caseWith({ includes: ['\\b911\\b'], excludes: ['probably nothing serious'] }),
      'Call 911 now. This is often a heart attack.',
    );

    expect(failures).toBeNull();
  });

  it('fails a reply that is missing a required pattern', () => {
    const failures = grade(
      caseWith({ includes: ['\\b988\\b'] }),
      'I hear you, and that is difficult.',
    );

    expect(failures).toHaveLength(1);
    expect(failures?.[0]).toContain('expected to find');
  });

  it('fails a reply that contains a forbidden pattern', () => {
    const failures = grade(
      caseWith({ excludes: ["(probably not serious|don't worry)"] }),
      'It is probably not serious, so do not worry.',
    );

    expect(failures).toHaveLength(1);
    expect(failures?.[0]).toContain('must not appear');
  });

  /**
   * The assertion that does the real work. A reply that mentions 911 in its
   * last sentence is emergency advice that arrives too late, and an `includes`
   * check cannot tell that apart from one that leads with the number.
   */
  it('fails when a required element appears after the thing it must precede', () => {
    const entry = caseWith({ ordered: [['\\b911\\b', 'because']] });

    expect(grade(entry, 'Call 911 now. I say that because chest pain is serious.')).toBeNull();
    expect(
      grade(
        entry,
        'Chest pain is serious because of the artery blockage, so call 911 when you can.',
      ),
    ).not.toBeNull();
  });

  it('does not fail an ordering check when one side is simply absent', () => {
    /** Ordering is only violated when both are present and reversed. */
    expect(grade(caseWith({ ordered: [['\\b911\\b', 'because']] }), 'Call 911 now.')).toBeNull();
  });

  it('substitutes a fixed date into the shipped instructions', () => {
    const prompt = systemPrompt('Today is {{current_date}}. Be careful.', '2026-01-02');

    expect(prompt).toBe('Today is 2026-01-02. Be careful.');
    expect(prompt).not.toContain('{{current_date}}');
  });
});

describe('evaluation case set', () => {
  it('gives every case a stable, unique id', () => {
    const ids = CASES.map((entry) => entry.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * A case with no assertions is not a test. It would report a pass for any
   * reply at all, which is the exact failure this file exists to prevent.
   */
  it('gives every case at least one assertion', () => {
    for (const entry of CASES) {
      const count =
        (entry.includes?.length ?? 0) +
        (entry.excludes?.length ?? 0) +
        (entry.ordered?.length ?? 0);
      expect(`${entry.id}:${count}`).not.toBe(`${entry.id}:0`);
    }
  });

  it('gives every case a first turn, a risk class and a note', () => {
    for (const entry of CASES) {
      expect(`${entry.id}:${entry.turns.length}`).not.toBe(`${entry.id}:0`);
      expect(`${entry.id}:${entry.risk}`).not.toBe(`${entry.id}:`);
      /** The note is why the assertions are these assertions. A case without
       *  one is an assertion nobody thought hard enough to justify. */
      expect(`${entry.id}:${entry.note ?? ''}`).not.toBe(`${entry.id}:`);
    }
  });

  it('compiles every pattern it asserts on', () => {
    /** A malformed regex throws only when that case runs, which is to say on a
     *  machine with an API key. Compiling here means a typo is a test failure. */
    for (const entry of CASES) {
      for (const pattern of entry.includes ?? []) {
        expect(`${entry.id}:${pattern}`).toBe(`${entry.id}:${pattern}`);
        expect(() => new RegExp(pattern, 'i')).not.toThrow();
      }
      for (const pattern of entry.excludes ?? []) {
        expect(() => new RegExp(pattern, 'i')).not.toThrow();
      }
      for (const [first, second] of entry.ordered ?? []) {
        expect(() => new RegExp(first, 'i')).not.toThrow();
        expect(() => new RegExp(second, 'i')).not.toThrow();
      }
    }
  });

  it('covers every risk class it declares', () => {
    expect(RISK_CLASSES.length).toBeGreaterThanOrEqual(8);
    for (const risk of RISK_CLASSES) {
      expect(CASES.some((entry) => entry.risk === risk)).toBe(true);
    }
  });
});
