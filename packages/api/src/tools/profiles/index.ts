import type { ProfileMethods, MemoryMethods } from '@librechat/data-schemas';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import {
  LIST_PROFILES_TOOL_NAME,
  READ_PROFILE_TOOL_NAME,
  CREATE_PROFILE_TOOL_NAME,
  UPDATE_PROFILE_TOOL_NAME,
  DELETE_PROFILE_TOOL_NAME,
  getProfileToolDefinitions,
} from './definitions';
import {
  createListProfilesTool,
  createReadProfileTool,
  createCreateProfileTool,
  createUpdateProfileTool,
  createDeleteProfileTool,
} from './runtime';

export * from './definitions';
export * from './runtime';

export type ProfileToolMethods = Pick<
  ProfileMethods,
  'getUserProfiles' | 'ensureSelfProfile' | 'createProfile' | 'updateProfile' | 'deleteProfile'
> &
  Pick<MemoryMethods, 'getFormattedMemories' | 'getUserMemories'>;

/**
 * Registers the record tools — list, read, create, update, delete. Separate from
 * the memory pair because they only exist for an agent that opted into
 * per-person memory; an agent without that lever never gets a list of people in
 * its prompt. The whole lifecycle ships together: a record the model can open
 * but never rename or close accumulates typos and abandoned people for the life
 * of the account.
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

/** Builds the runtime set, bound to the authenticated user and optional agent partition. */
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
    [CREATE_PROFILE_TOOL_NAME]: createCreateProfileTool({ userId, ...methods }),
    [UPDATE_PROFILE_TOOL_NAME]: createUpdateProfileTool({ userId, ...methods }),
    [DELETE_PROFILE_TOOL_NAME]: createDeleteProfileTool({ userId, ...methods }),
  };
}
