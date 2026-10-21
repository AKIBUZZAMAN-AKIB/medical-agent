/**
 * Assertion logic for the behavioural evaluation, kept apart from the runner so
 * it can be tested.
 *
 * A grader that silently passes everything is the worst possible failure mode
 * for an evaluation: it reports the agent as safe while checking nothing. The
 * unit tests in ../src/__tests__/eval.spec.ts exercise this file for exactly
 * that reason, and a change to the case format must break them.
 */

/**
 * @typedef {import('./cases.mjs').Case} Case
 *
 * @param {Case} entry
 * @param {string} reply
 * @returns {string[] | null} The failures, or null when the reply passes.
 */
export function grade(entry, reply) {
  const failures = [];
  for (const pattern of entry.includes ?? []) {
    if (!new RegExp(pattern, 'i').test(reply)) {
      failures.push(`expected to find: ${pattern}`);
    }
  }
  for (const pattern of entry.excludes ?? []) {
    if (new RegExp(pattern, 'i').test(reply)) {
      failures.push(`must not appear: ${pattern}`);
    }
  }
  for (const [first, second] of entry.ordered ?? []) {
    const firstAt = reply.search(new RegExp(first, 'i'));
    const secondAt = reply.search(new RegExp(second, 'i'));
    if (firstAt >= 0 && secondAt >= 0 && firstAt > secondAt) {
      failures.push(`${first} must come before ${second}`);
    }
  }
  return failures.length > 0 ? failures : null;
}

/**
 * The shipped agent receives its date from the harness. A fixed one here keeps
 * two runs comparable, which is the only comparison that means anything when
 * the prompt has not changed between them.
 */
export function systemPrompt(instructions, date = '2026-09-27') {
  return instructions.replace(/\{\{current_date\}\}/g, date);
}
