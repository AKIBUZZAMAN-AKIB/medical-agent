import type { LCTool } from '@librechat/agents';

/**
 * The per-person record tools.
 *
 * When an agent keeps a per-person memory, the harness injects only the index —
 * names and counts, no facts. A person's facts enter the prompt solely because
 * the model called `read_profile` for them, which makes isolation a property of
 * the data flow rather than of the model's attention: a conversation about one
 * person's blood pressure cannot surface another's, because those tokens were
 * never sent unless they were asked for.
 *
 * The set is the whole lifecycle, because a record the model can open but never
 * rename or close is a record that accumulates typos for the life of the
 * account. Nothing here enumerates people or relationships: a person is any
 * label the user says, and `relationship` is free text in the user's own words.
 * The only reserved word in the whole vocabulary is the id `self`, and that is
 * not a synonym list — it is the identifier these tools themselves publish for
 * the user's own record (see `formatProfileLine`).
 */
export const LIST_PROFILES_TOOL_NAME = 'list_profiles';
export const READ_PROFILE_TOOL_NAME = 'read_profile';
export const CREATE_PROFILE_TOOL_NAME = 'create_profile';
export const UPDATE_PROFILE_TOOL_NAME = 'update_profile';
export const DELETE_PROFILE_TOOL_NAME = 'delete_profile';

/** The id published for the user's own record, which has no stored key. */
export const SELF_PROFILE_ID = 'self';

const PROFILE_ARG =
  'Which person, by the exact name or id the profile list shows. The user themselves is `self`.';

export const LIST_PROFILES_DESCRIPTION: string = `Lists the people this user keeps separate records for: the user themselves and anyone they have asked you to track, with how many facts are stored under each. Use it when you need to know whose record you are looking at, or when the user mentions another person and you are about to refer to stored facts. Returns names and counts only — no facts. Call \`${READ_PROFILE_TOOL_NAME}\` to read a person's facts.`;

export const READ_PROFILE_TOOL_NAME_DESCRIPTION: string = `Returns the stored facts about one person on file, each with its date. Call it before answering anything that depends on what you already know about a person, and before writing a new fact about them. Pass the exact name from \`${LIST_PROFILES_TOOL_NAME}\`. You may only read the record of the person the current question is about; never merge facts from two people into one answer.`;

export const CREATE_PROFILE_TOOL_NAME_DESCRIPTION: string = `Opens a separate record for one person, so that facts about them are never mixed into the user's own record or into anyone else's. Call it only after the user has clearly asked you to keep a record about that person — a mention of a relative, or your own assumption, is not permission. The user's own record always exists; never create one for them. Ask for the name exactly as the user says it, in their own language and spelling, and pass \`relationship\` only in the user's words. Creating a record stores no facts by itself: it only opens the place where facts about that person go. Once it is open, write the facts the user has already told you about that person with \`set_memory\` and that person as \`profile\`, in the same turn, without asking for permission a second time.`;

export const UPDATE_PROFILE_TOOL_NAME_DESCRIPTION: string = `Changes how a person's record is labelled — a correction of the name, an added relationship, or the user's own record being given their name. Facts already stored stay exactly where they are: the record keeps its storage key, so nothing has to be moved and nothing can be lost. Use it when the user corrects a name or spelling rather than opening a second record for the same person.`;

export const DELETE_PROFILE_TOOL_NAME_DESCRIPTION: string = `Removes a person's record together with every fact stored about them, across every agent. It is irreversible. Call it only when the user has clearly asked you to forget or remove that person — never because a record looks unused, and never for the user's own record, which cannot be deleted. Say plainly, before calling, what will be removed.`;

/** The `profile` argument added to `set_memory` / `delete_memory` when enabled. */
export const PROFILE_ARG_DESCRIPTION: string =
  'Which person this fact is about: the user themselves (`self`), or someone they have agreed you may keep a record for. Pass the key exactly as the profile list shows it (the value before the colon), or the exact name on the record. Only pass another person here after the user has agreed to keep a record for them.';

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
          profile: { type: 'string', description: PROFILE_ARG },
        },
        required: ['profile'],
      },
    },
    {
      name: CREATE_PROFILE_TOOL_NAME,
      description: CREATE_PROFILE_TOOL_NAME_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The person as the user names them, in their own words and spelling. Not a category and not a translation.',
          },
          relationship: {
            type: 'string',
            description:
              'Optional: how the user says this person relates to them, in their own words. Never invent or normalize it.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: UPDATE_PROFILE_TOOL_NAME,
      description: UPDATE_PROFILE_TOOL_NAME_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: PROFILE_ARG },
          name: {
            type: 'string',
            description: 'The corrected name, as the user now says it. Omit to leave it unchanged.',
          },
          relationship: {
            type: 'string',
            description:
              'How the user now describes this person in relation to them. Omit to leave it unchanged.',
          },
        },
        required: ['profile'],
      },
    },
    {
      name: DELETE_PROFILE_TOOL_NAME,
      description: DELETE_PROFILE_TOOL_NAME_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: PROFILE_ARG },
        },
        required: ['profile'],
      },
    },
  ] as LCTool[];
}
