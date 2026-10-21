/**
 * One import surface for the evaluation harness.
 *
 * The runner and the unit suite both come through here, so a case and the
 * grader that judges it can never drift onto different module instances or
 * different shapes. Types live alongside in harness.d.ts.
 */
export { CASES, RISK_CLASSES } from './cases.mjs';
export { grade, systemPrompt } from './grade.mjs';
