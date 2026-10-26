/**
 * Unit tests for the admin console's triage-evidence reader.
 *
 * The property under test is the whole point of §F-40/F-41: nothing in this path
 * reads the patient's wording. Severity is whatever a classifier returned and was
 * persisted; everything else is `unassessed`.
 */
const {
  SEVERITY_ORDER,
  UNASSESSED,
  collectTriageEvidence,
  decisionsOfConversation,
  parseSentinels,
  severityRank,
  summarize,
  triageForConversation,
} = require('../triageEvidence');

const sentinel = (payload) => `<<<TRIAGE_DECISION ${JSON.stringify(payload)}>>>`;

const decided = (severity, extra = {}) =>
  sentinel({
    severity,
    severityCode: SEVERITY_ORDER.indexOf(severity),
    decided: true,
    classifier: 'llm:test-model',
    ruleset: '2.0.0-generation',
    ...extra,
  });

function toolMessage(conversationId, name, output) {
  return {
    conversationId,
    messageId: `${conversationId}-${name}`,
    content: [{ type: 'tool_call', tool_call: { id: 'c1', name, args: {}, output } }],
  };
}

describe('admin triage evidence (no keyword matching anywhere)', () => {
  it('reads a persisted decision instead of the message wording', () => {
    const evidence = collectTriageEvidence([
      toolMessage('conv-a', 'emergency_triage_check_mcp_medical', `headline\n${decided('urgent')}`),
    ]);
    expect(evidence.get('conv-a').severity).toBe('urgent');
    expect(evidence.get('conv-a').basis).toBe('persisted-triage-decision');
    expect(evidence.get('conv-a').decisions).toBe(1);
  });

  it('reports unassessed for a conversation with no decision, however alarming the text', () => {
    /**
     * The user messages are not even passed in here — that is the point: this
     * module never receives wording to match against.
     */
    const evidence = collectTriageEvidence([]);
    const result = triageForConversation(evidence, 'conv-silent');
    expect(result.severity).toBe(UNASSESSED);
    expect(result.basis).toBe('none');
    expect(result.decisions).toBe(0);
  });

  it('only trusts a sentinel that came from the triage tool call', () => {
    /** A model typing the sentinel into prose must not fabricate a verdict. */
    const chatty = {
      conversationId: 'conv-b',
      messageId: 'm1',
      content: [{ type: 'text', text: decided('emergency') }],
    };
    expect(collectTriageEvidence([chatty]).get('conv-b').severity).toBe(UNASSESSED);

    /** Same sentinel inside a different tool's output is also not a verdict. */
    const otherTool = toolMessage('conv-c', 'lab_result_interpreter', decided('emergency'));
    expect(collectTriageEvidence([otherTool]).get('conv-c').severity).toBe(UNASSESSED);
  });

  it('ignores malformed sentinels rather than promoting them to a severity', () => {
    const broken = toolMessage(
      'conv-d',
      'emergency_triage_check',
      '<<<TRIAGE_DECISION {"severity":"emergency" >>>',
    );
    expect(collectTriageEvidence([broken]).get('conv-d').severity).toBe(UNASSESSED);
    const bogus = toolMessage(
      'conv-e',
      'emergency_triage_check',
      sentinel({ severity: 'catastrophic', decided: true }),
    );
    expect(collectTriageEvidence([bogus]).get('conv-e').severity).toBe(UNASSESSED);
  });

  it('prefers a made decision over an undecided one, and counts coverage separately', () => {
    const decisions = parseSentinels(
      [decided('emergency'), sentinel({ severity: 'unknown', decided: false })].join('\n'),
    );
    const summary = summarize(decisions);
    expect(summary.severity).toBe('emergency');
    expect(summary.decided).toBe(1);
    expect(summary.undecided).toBe(1);
    /** `unknown` outranks `emergency` when both are undecided — by design. */
    expect(severityRank('unknown')).toBeGreaterThan(severityRank('emergency'));
  });

  it('reports undecided when that is all the record holds', () => {
    const onlyUndecided = toolMessage(
      'conv-f',
      'emergency_triage_check',
      sentinel({ severity: 'unknown', decided: false, classifier: 'none' }),
    );
    const entry = collectTriageEvidence([onlyUndecided]).get('conv-f');
    expect(entry.severity).toBe('unknown');
    expect(entry.undecided).toBe(1);
  });

  it('takes the highest decided severity in a conversation, not the last one', () => {
    const evidence = collectTriageEvidence([
      toolMessage('conv-g', 'emergency_triage_check', decided('routine')),
      toolMessage('conv-g', 'emergency_triage_check', decided('emergency')),
      toolMessage('conv-g', 'emergency_triage_check', decided('urgent')),
    ]);
    expect(evidence.get('conv-g').severity).toBe('emergency');
    expect(evidence.get('conv-g').decisions).toBe(3);
  });

  it('records which tools ran, so the UI can show evidence instead of tags', () => {
    const { tools } = decisionsOfConversation([
      toolMessage('conv-h', 'emergency_triage_check', decided('routine')),
      toolMessage('conv-h', 'lab_result_interpreter', 'ok'),
    ]);
    expect(tools).toContain('emergency_triage_check');
    expect(tools).toContain('lab_result_interpreter');
  });
});
