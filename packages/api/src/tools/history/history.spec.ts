import {
  createConversationHistoryTool,
  createConversationTranscriptTool,
  extractMessageText,
} from './runtime';
import { registerConversationHistoryTools, getConversationHistoryToolDefinitions } from './index';
import { CONVERSATION_HISTORY_TOOL_NAME, CONVERSATION_TRANSCRIPT_TOOL_NAME } from './definitions';

const USER = 'user-1';
const OTHER_USER = 'user-2';

function convo(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'c1',
    user: USER,
    title: 'Warfarin dosing',
    updatedAt: new Date('2026-09-20T10:00:00Z'),
    createdAt: new Date('2026-09-20T09:00:00Z'),
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    user: USER,
    isCreatedByUser: true,
    text: 'what is the warfarin dose',
    createdAt: new Date('2026-09-20T09:00:00Z'),
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getConvosByCursor: jest.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
    getConvo: jest.fn().mockResolvedValue(null),
    getMessages: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Parameters<typeof createConversationHistoryTool>[0];
}

describe('extractMessageText', () => {
  it('prefers the legacy text column', () => {
    expect(extractMessageText({ text: 'from text', content: [{ text: 'from content' }] })).toBe(
      'from text',
    );
  });

  it('flattens structured content parts when text is absent', () => {
    expect(
      extractMessageText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\n\nsecond');
  });

  it('returns empty string for a tool-call-only turn', () => {
    expect(extractMessageText({ content: [{ type: 'tool_use', name: 'drug_label' }] })).toBe('');
  });
});

describe('conversation_history', () => {
  it('scopes every read to the authenticated user', async () => {
    const getConvosByCursor = jest.fn().mockResolvedValue({ conversations: [], nextCursor: null });
    const tool = createConversationHistoryTool({
      ...deps({ getConvosByCursor }),
      userId: USER,
    });

    await tool.invoke({ query: 'insulin' });

    expect(getConvosByCursor).toHaveBeenCalled();
    for (const call of getConvosByCursor.mock.calls) {
      expect(call[0]).toBe(USER);
    }
  });

  it('lists sessions newest first with dates and ids', async () => {
    const getConvosByCursor = jest.fn().mockResolvedValue({
      conversations: [
        convo({
          conversationId: 'c2',
          title: 'Insulin',
          updatedAt: new Date('2026-09-25T08:00:00Z'),
        }),
        convo(),
      ],
      nextCursor: null,
    });
    const tool = createConversationHistoryTool({ ...deps({ getConvosByCursor }), userId: USER });

    const output = await tool.invoke({});

    expect(output).toContain('c2');
    expect(output).toContain('Insulin');
    expect(output).toContain('2026-09-25T08:00:00.000Z');
    expect(output).toContain('c1');
  });

  it('applies a date range and reports that older matches were withheld', async () => {
    const getConvosByCursor = jest.fn().mockResolvedValue({
      conversations: [
        convo({
          conversationId: 'c-new',
          title: 'Recent',
          updatedAt: new Date('2026-09-25T08:00:00Z'),
        }),
        convo({
          conversationId: 'c-old',
          title: 'Older',
          updatedAt: new Date('2026-01-05T08:00:00Z'),
        }),
      ],
      nextCursor: null,
    });
    const tool = createConversationHistoryTool({ ...deps({ getConvosByCursor }), userId: USER });

    const output = await tool.invoke({ since: '2026-09-01', until: '2026-09-30' });

    expect(output).toContain('c-new');
    expect(output).not.toContain('c-old');
  });

  it('reads archived sessions too, so recall cannot report a stored conversation as missing', async () => {
    const getConvosByCursor = jest.fn(async (_user: string, options: { isArchived?: boolean }) => ({
      conversations: options.isArchived
        ? [convo({ conversationId: 'c-archived', title: 'Filed' })]
        : [],
      nextCursor: null,
    }));
    const tool = createConversationHistoryTool({ ...deps({ getConvosByCursor }), userId: USER });

    const output = await tool.invoke({});

    expect(getConvosByCursor).toHaveBeenCalledTimes(2);
    expect(output).toContain('c-archived');
  });

  it('falls back to a date-ordered listing when full-text search is unavailable', async () => {
    const getConvosByCursor = jest
      .fn()
      .mockRejectedValueOnce(new Error('Error during meiliSearch'))
      .mockResolvedValue({ conversations: [convo()], nextCursor: null });
    const tool = createConversationHistoryTool({ ...deps({ getConvosByCursor }), userId: USER });

    const output = await tool.invoke({ query: 'warfarin' });

    expect(output).toContain('c1');
    expect(output).toMatch(/Full-text search is unavailable/i);
  });

  it('reports an empty result as an empty result, with the scope that was searched', async () => {
    const tool = createConversationHistoryTool({ ...deps(), userId: USER });

    const output = await tool.invoke({ query: 'nothing here', since: '2026-01-01' });

    expect(output).toMatch(/No past conversation found/i);
    expect(output).toContain('nothing here');
  });

  it('surfaces an unreadable date instead of silently ignoring it', async () => {
    const tool = createConversationHistoryTool({ ...deps(), userId: USER });

    const output = await tool.invoke({ since: 'last tuesday' });

    expect(output).toMatch(/not a date I can read/i);
  });
});

describe('conversation_transcript', () => {
  it('refuses a conversation that does not belong to the caller', async () => {
    const getConvo = jest.fn().mockResolvedValue(null);
    const getMessages = jest.fn();
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo, getMessages }),
      userId: USER,
    });

    const output = await tool.invoke({ conversation_id: 'someone-elses' });

    expect(output).toMatch(/No conversation "someone-elses" belongs to this account/i);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('checks ownership with the caller user id, not a model-supplied one', async () => {
    const getConvo = jest.fn().mockResolvedValue(convo());
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo, getMessages: jest.fn().mockResolvedValue([message()]) }),
      userId: USER,
    });

    await tool.invoke({ conversation_id: 'c1' });

    expect(getConvo).toHaveBeenCalledWith(USER, 'c1');
  });

  it('returns messages in order with dates and roles', async () => {
    const getMessages = jest.fn().mockResolvedValue([
      message({ text: 'user question' }),
      message({
        isCreatedByUser: false,
        text: 'assistant answer',
        createdAt: new Date('2026-09-20T09:00:05Z'),
      }),
    ]);
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo: jest.fn().mockResolvedValue(convo()), getMessages }),
      userId: USER,
    });

    const output = await tool.invoke({ conversation_id: 'c1' });

    expect(output).toContain('2026-09-20T09:00:00.000Z · user');
    expect(output).toContain('user question');
    expect(output).toContain('2026-09-20T09:00:05.000Z · assistant');
    expect(output).toContain('End of session.');
    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER, conversationId: 'c1' }),
      expect.any(String),
      expect.objectContaining({ sort: { createdAt: 1 } }),
    );
  });

  it('tells the model a session continues rather than letting it assume it read everything', async () => {
    const getMessages = jest
      .fn()
      .mockResolvedValue([message({ messageId: 'm1' }), message({ messageId: 'm2' })]);
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo: jest.fn().mockResolvedValue(convo()), getMessages }),
      userId: USER,
    });

    const output = await tool.invoke({ conversation_id: 'c1', limit: 1 });

    expect(output).toContain('This session continues');
    expect(output).toContain('offset 1');
  });

  it('forwards offset as skip to getMessages and reports out-of-range offsets cleanly', async () => {
    const allRows = [
      message({ messageId: 'm1', text: 'first turn' }),
      message({ messageId: 'm2', text: 'second turn' }),
      message({ messageId: 'm3', text: 'third turn' }),
    ];
    const getMessages = jest.fn(async (_filter, _select, options = {}) => {
      const start = options.skip ?? 0;
      const limit = options.limit ?? allRows.length;
      return allRows.slice(start, start + limit);
    });
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo: jest.fn().mockResolvedValue(convo()), getMessages }),
      userId: USER,
    });

    const secondPage = await tool.invoke({ conversation_id: 'c1', offset: 2, limit: 2 });
    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER, conversationId: 'c1' }),
      expect.any(String),
      { sort: { createdAt: 1 }, skip: 2, limit: 3 },
    );
    expect(secondPage).toContain('Messages 3-3 of 3');
    expect(secondPage).toContain('[3]');
    expect(secondPage).toContain('third turn');
    expect(secondPage).not.toContain('first turn');
    expect(secondPage).toContain('End of session.');

    const pastEnd = await tool.invoke({ conversation_id: 'c1', offset: 10, limit: 2 });
    expect(pastEnd).toContain('No messages at or after offset 10 in conversation "c1".');
  });

  it('marks a tool-call-only turn instead of rendering it as empty text', async () => {
    const getMessages = jest
      .fn()
      .mockResolvedValue([
        message({ isCreatedByUser: false, text: undefined, content: [{ type: 'tool_use' }] }),
      ]);
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo: jest.fn().mockResolvedValue(convo()), getMessages }),
      userId: USER,
    });

    const output = await tool.invoke({ conversation_id: 'c1' });

    expect(output).toContain('tool calls only');
  });

  it('never queries another account even when handed another id', async () => {
    const getConvo = jest.fn(async (user: string, conversationId: string) =>
      user === USER && conversationId === 'c1' ? convo() : null,
    );
    const getMessages = jest.fn().mockResolvedValue([message()]);
    const tool = createConversationTranscriptTool({
      ...deps({ getConvo, getMessages }),
      userId: USER,
    });

    const output = await tool.invoke({ conversation_id: 'c1' });

    expect(output).not.toContain(OTHER_USER);
    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER }),
      expect.any(String),
      expect.anything(),
    );
  });
});

describe('registerConversationHistoryTools', () => {
  it('registers both tools exactly once', () => {
    const registry = new Map();
    const first = registerConversationHistoryTools({ toolRegistry: registry, toolDefinitions: [] });
    const second = registerConversationHistoryTools({
      toolRegistry: registry,
      toolDefinitions: first.toolDefinitions,
    });

    expect(first.toolNames).toEqual([
      CONVERSATION_HISTORY_TOOL_NAME,
      CONVERSATION_TRANSCRIPT_TOOL_NAME,
    ]);
    expect(second.registered).toEqual([]);
    expect(second.toolDefinitions).toHaveLength(2);
  });

  it('publishes a transcript schema that requires a conversation id', () => {
    const [, transcript] = getConversationHistoryToolDefinitions();
    expect(transcript.parameters?.required).toEqual(['conversation_id']);
  });
});
