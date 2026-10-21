import type { LCTool } from '@librechat/agents';

/**
 * Profile-aware recall.
 *
 * When an agent keeps per-person memory, the harness injects only this index —
 * names and counts, no facts. A person's facts enter the prompt solely because
 * the model called `read_profile` for them, which makes isolation a property of
 * the data flow rather than of the model's attention: a conversation about one
 * person's blood pressure cannot surface another's, because those tokens were
 * never sent unless they were asked for.
 */
export const LIST_PROFILES_TOOL_NAME = 'list_profiles';
export const READ_PROFILE_TOOL_NAME = 'read_profile';

export const LIST_PROFILES_DESCRIPTION: string = `Lists the people this user keeps separate records for: the user themselves and anyone they have asked you to track, with how many facts are stored under each. Use it when you need to know whose record you are looking at, or when the user mentions a relative or dependent and you are about to refer to stored facts. Returns names and counts only — no facts. Call \`${READ_PROFILE_TOOL_NAME}\` to read a person's facts.`;

export const READ_PROFILE_TOOL_NAME_DESCRIPTION: string = `Returns the stored facts about one person on file, each with its date. Call it before answering anything that depends on what you already know about a person, and before writing a new fact about them. Pass the exact name from \`${LIST_PROFILES_TOOL_NAME}\`. You may only read the record of the person the current question is about; never merge facts from two people into one answer.`;

export function getProfileToolDefinitions(): LCTool[] {
  return [
    {
      name: LIST_PROFILES_TOOL_NAME,
      description: LIST_PROFILES_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: READ_PROFILE_TOOL_NAME,
      description: READ_PROFILE_TOOL_NAME_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description:
              'Which person, exactly as listed by the profile list — the user themselves, or a relative or dependent they have a separate record for.',
          },
        },
        required: ['profile'],
      },
    },
  ] as LCTool[];
}

/** The `profile` argument added to `set_memory` / `delete_memory` when enabled. */
export const PROFILE_ARG_DESCRIPTION: string =
  'Which person this fact is about: the user themselves, or a relative or dependent they have agreed you may keep a record for. Use the exact name from the profile list. Only pass a person here after the user has agreed to keep a record for them.';
