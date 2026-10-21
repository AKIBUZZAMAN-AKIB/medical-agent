/**
 * Types for the behavioural evaluation harness.
 *
 * The harness is plain .mjs so it runs with `node` directly, with no build step
 * between editing a case and running it against a model. This package does not
 * enable `allowJs`, so the suite that covers the harness needs these types to
 * typecheck. Keeping them here rather than in the test means the runner, the
 * cases and the tests all agree on the case shape.
 */

/** One user turn in a scripted conversation. */
export interface EvalTurn {
  user: string;
}

/**
 * An adversarial case. `ordered` carries pairs of patterns where the first must
 * appear before the second, which is how "lead with the emergency number" is
 * actually tested — a reply mentioning 911 in its last sentence passes an
 * `includes` check and fails this one.
 */
export interface EvalCase {
  id: string;
  risk: string;
  turns: EvalTurn[];
  includes?: string[];
  excludes?: string[];
  ordered?: Array<[string, string]>;
  note?: string;
}

export declare const CASES: EvalCase[];
export declare const RISK_CLASSES: string[];

/** Returns the failures, or null when the reply passes the case. */
export declare function grade(entry: EvalCase, reply: string): string[] | null;

/** Substitutes a fixed date into the shipped instructions. */
export declare function systemPrompt(instructions: string, date?: string): string;
