import type { ProfileMethods, MemoryMethods } from '@librechat/data-schemas';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import {
  LIST_PROFILES_TOOL_NAME,
  READ_PROFILE_TOOL_NAME,
  getProfileToolDefinitions,
} from './definitions';
import { createListProfilesTool, createReadProfileTool } from './runtime';

export * from './definitions';
export * from './runtime';

export type ProfileToolMethods = Pick<
  ProfileMethods,
  'getUserProfiles' | 'ensureSelfProfile' | 'createProfile'
> &
  Pick<MemoryMethods, 'getFormattedMemories' | 'getUserMemories'>;

/**
 * Registers the two recall tools. Separate from the memory pair because they
 * only exist for an agent that opted into per-person memory; an agent without
 * that lever never gets a list of people in its prompt.
 */
export function registerProfileTools({
  toolRegistry,
  toolDefinitions,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
}): { toolDefinitions: LCTool[]; registered: string[]; toolNames: string[] } {
  const definitions = getProfileToolDefinitions();
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

/** Builds the runtime pair, bound to the authenticated user and optional agent partition. */
export function buildProfileTools({
  userId,
  agentId,
  methods,
}: {
  userId: string;
  agentId?: string;
  methods: ProfileToolMethods;
}): Record<string, ReturnType<typeof createListProfilesTool>> {
  return {
    [LIST_PROFILES_TOOL_NAME]: createListProfilesTool({ userId, agentId, ...methods }),
    [READ_PROFILE_TOOL_NAME]: createReadProfileTool({ userId, agentId, ...methods }),
  };
}
