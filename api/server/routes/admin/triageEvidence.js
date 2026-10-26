'use strict';

/**
 * Persisted triage evidence, read out of stored messages.
 *
 * The admin console used to derive a per-message severity from
 * `classifyClinicalMessageRisk()` in `medicalCommand.js`: a hand-written regex
 * lexicon of symptom, drug-brand and Bangla words whose matches raised a
 * severity and picked a "specialty". That is the exact construction the medical
 * package deleted — see `docs/REPOSITORY_DEEP_AUDIT.md` §F-40 — because a word
 * list is not a clinical assessment: it silently fails on every phrasing (and on
 * every language) it does not contain, and it turns "matched a word" into a
 * console row that reads like somebody screened the patient.
 *
 * This module reads the decision a classifier actually produced. The
 * `emergency_triage_check` MCP tool emits a machine-readable sentinel line with
 * its verdict (`renderDecisionSentinel` in
 * `packages/mcp-medical/src/tools/emergency.ts`), the host persists the tool
 * result, and everything here is a pure read of that persisted text:
 *
 *   - no clinical vocabulary, no regex over the patient's words, no defaults;
 *   - severity comes only from a decision that was actually stored;
 *   - a message whose conversation holds no such decision is reported as
 *     `unassessed`, never `routine` and never guessed.
 *
 * Honest limits, because they matter more than the code:
 *   1. If the deployment never invoked `emergency_triage_check` (or the model
 *      was never given the tool), this reports `unassessed` for everything. That
 *      is a true statement about the record and a useful one — it is not a
 *      safety signal either way.
 *   2. A conversation whose only decision was `undecided` (no classifier
 *      available on that run) surfaces as `unknown`, and it is counted
 *      separately as undecided so a partial assessment cannot hide.
 *   3. The sentinel is text inside a tool result, so its integrity depends on the
 *      tool having produced it. Names are matched on the tool call, not on the
 *      text alone, so a model that types the sentinel into a message cannot
 *      fabricate a verdict.
 */

/** Same names as `Severity` in the medical package, as a string union. */
const SEVERITY_ORDER = ['none', 'informational', 'routine', 'urgent', 'emergency', 'unknown'];

/** Severity reported when the conversation recorded no triage decision at all. */
const UNASSESSED = 'unassessed';

/** Basis strings surfaced to the UI, so a row always says where it came from. */
const BASIS_PERSISTED = 'persisted-triage-decision';
const BASIS_NONE = 'none';

const TRIAGE_TOOL_HINT = 'emergency_triage_check';
const SENTINEL_GLOBAL = /<<<TRIAGE_DECISION (\{[\s\S]*?\})>>>/g;

/**
 * Higher ranks first. `unknown` deliberately ranks above `emergency` here only
 * for *sorting of undecided rows*; the headline severity prefers a decision
 * that was actually made (see `summarize`), so a partially assessed emergency
 * is not relabelled "not assessed" by an unrelated undecided call.
 */
function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(String(severity));
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function isKnownSeverity(severity) {
  return SEVERITY_ORDER.includes(String(severity));
}

/**
 * Pulls every sentinel out of one tool output payload, which may be a string or
 * a list of content parts.
 */
function parseSentinels(payload) {
  const texts = [];
  if (typeof payload === 'string') {
    texts.push(payload);
  } else if (Array.isArray(payload)) {
    for (const part of payload) {
      if (typeof part === 'string') texts.push(part);
      else if (part && typeof part.text === 'string') texts.push(part.text);
      else if (part && typeof part.content === 'string') texts.push(part.content);
    }
  } else if (payload && typeof payload === 'object' && typeof payload.text === 'string') {
    texts.push(payload.text);
  }

  const decisions = [];
  for (const text of texts) {
    SENTINEL_GLOBAL.lastIndex = 0;
    let match = SENTINEL_GLOBAL.exec(text);
    while (match != null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && isKnownSeverity(parsed.severity)) {
          decisions.push({
            severity: String(parsed.severity),
            severityCode: typeof parsed.severityCode === 'number' ? parsed.severityCode : null,
            decided: parsed.decided === true,
            classifier: typeof parsed.classifier === 'string' ? parsed.classifier : 'unknown',
            ruleset: typeof parsed.ruleset === 'string' ? parsed.ruleset : '',
          });
        }
      } catch {
        /* A malformed sentinel is not a verdict. Dropping it keeps the row
         * "unassessed" rather than promoting garbage into a severity. */
      }
      match = SENTINEL_GLOBAL.exec(text);
    }
  }
  return decisions;
}

function toolNamesOf(content) {
  const names = [];
  if (!Array.isArray(content)) return names;
  for (const part of content) {
    if (part && part.type === 'tool_call') {
      const name = String(part.tool_call?.name || '');
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Walks the messages of one conversation and returns every triage decision the
 * record actually contains.
 */
function decisionsOfConversation(messages) {
  const decisions = [];
  const tools = new Set();
  for (const message of messages) {
    for (const name of toolNamesOf(message.content)) {
      tools.add(name);
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || part.type !== 'tool_call') continue;
      const name = String(part.tool_call?.name || '');
      if (!name.includes(TRIAGE_TOOL_HINT)) continue;
      for (const decision of parseSentinels(part.tool_call?.output)) {
        decisions.push({ ...decision, toolName: name, messageId: message.messageId });
      }
    }
  }
  return { decisions, tools: [...tools] };
}

/**
 * Headline severity for a set of decisions.
 *
 * A made decision always outranks an undecided one: reporting `unknown` over a
 * stored `emergency` would hide the finding, and reporting `emergency` over a
 * stored `routine` would invent one. Undecided calls are surfaced separately in
 * `undecided` so coverage is never implied.
 */
function summarize(decisions) {
  if (decisions.length === 0) {
    return {
      severity: UNASSESSED,
      basis: BASIS_NONE,
      decisions: 0,
      decided: 0,
      undecided: 0,
      classifiers: [],
    };
  }
  const decided = decisions.filter((d) => d.decided === true && d.severity !== 'unknown');
  const undecided = decisions.filter((d) => !(d.decided === true && d.severity !== 'unknown'));
  const pool = decided.length > 0 ? decided : undecided;
  const top = pool.reduce((best, item) =>
    severityRank(item.severity) >= severityRank(best.severity) ? item : best,
  );
  return {
    severity: top.severity,
    basis: BASIS_PERSISTED,
    decisions: decisions.length,
    decided: decided.length,
    undecided: undecided.length,
    classifiers: [...new Set(decisions.map((d) => d.classifier))],
  };
}

/**
 * Groups messages by conversation and returns a Map of conversationId to
 * `{ severity, basis, decisions, decided, undecided, classifiers, tools }`.
 */
function collectTriageEvidence(messages = []) {
  const byConversation = new Map();
  for (const message of messages) {
    const key = message?.conversationId;
    if (!key) continue;
    const bucket = byConversation.get(key) || [];
    bucket.push(message);
    byConversation.set(key, bucket);
  }

  const evidence = new Map();
  for (const [conversationId, bucket] of byConversation.entries()) {
    const { decisions, tools } = decisionsOfConversation(bucket);
    evidence.set(conversationId, { ...summarize(decisions), tools });
  }
  return evidence;
}

/**
 * The single question the console asks: what did the record say about this
 * conversation? Absent evidence yields `unassessed` with basis `none`.
 */
function triageForConversation(evidence, conversationId) {
  return (
    evidence.get(conversationId) || {
      severity: UNASSESSED,
      basis: BASIS_NONE,
      decisions: 0,
      decided: 0,
      undecided: 0,
      classifiers: [],
      tools: [],
    }
  );
}

module.exports = {
  BASIS_NONE,
  BASIS_PERSISTED,
  SEVERITY_ORDER,
  UNASSESSED,
  collectTriageEvidence,
  decisionsOfConversation,
  isKnownSeverity,
  parseSentinels,
  severityRank,
  summarize,
  triageForConversation,
};
