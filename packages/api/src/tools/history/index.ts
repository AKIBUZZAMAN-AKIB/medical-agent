import type { ConversationMethods, MessageMethods } from '@librechat/data-schemas';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import { CONVERSATION_HISTORY_TOOL_NAME, CONVERSATION_TRANSCRIPT_TOOL_NAME } from './definitions';
import { createConversationHistoryTool, createConversationTranscriptTool } from './runtime';
import { getConversationHistoryToolDefinitions } from './definitions';

export * from './definitions';
export * from './runtime';

export type ConversationHistoryMethods = Pick<
  ConversationMethods,
  'getConvosByCursor' | 'getConvo'
> &
  Pick<MessageMethods, 'getMessages'>;

/**
 * Idempotently registers the past-session pair into the run's tool registry and
 * definition list, mirroring `registerMemoryTools`: the two tool names on
 * `agent.tools` are the per-agent opt-in, the admin capability is the ceiling,
 * and the runtime instances are created later in the tool service where the
 * authenticated user is known.
 */
export function registerConversationHistoryTools({
  toolRegistry,
  toolDefinitions,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
}): { toolDefinitions: LCTool[]; registered: string[]; toolNames: string[] } {
  const definitions = getConversationHistoryToolDefinitions();
  const toolNames = definitions.map((definition) => definition.name);
  const inputDefinitions = toolDefinitions ?? [];
  const newDefs: LCTool[] = [];
  const registered: string[] = [];

  for (const def of definitions) {
    if (toolRegistry?.has(def.name) === true) {
      continue;
    }
    if (inputDefinitions.some((existing) => existing.name === def.name)) {
      continue;
    }
    toolRegistry?.set(def.name, def);
    newDefs.push(def);
    registered.push(def.name);
  }

  if (newDefs.length === 0) {
    return { toolDefinitions: inputDefinitions, registered, toolNames };
  }
  return { toolDefinitions: [...inputDefinitions, ...newDefs], registered, toolNames };
}

/**
 * Builds the runtime pair for a request. `userId` is the authenticated
 * principal from the request, never a model-supplied value.
 */
export function buildConversationHistoryTools({
  userId,
  methods,
}: {
  userId: string;
  methods: ConversationHistoryMethods;
}): Record<string, ReturnType<typeof createConversationHistoryTool>> {
  return {
    [CONVERSATION_HISTORY_TOOL_NAME]: createConversationHistoryTool({
      userId,
      ...methods,
    }),
    [CONVERSATION_TRANSCRIPT_TOOL_NAME]: createConversationTranscriptTool({
      userId,
      ...methods,
    }),
  };
}
