import { Tools } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';

/**
 * Names of the past-session recall pair. `conversation_history` answers "when
 * did we discuss X"; `conversation_transcript` answers "what exactly did we
 * say in that conversation". They are separate tools because their inputs and
 * their failure modes differ: the first takes a date range and returns ids,
 * the second takes an id and returns text. A model asked to recall a specific
 * exchange has to make that two-step hop explicitly, which is also the only
 * way it can be held to quoting a real session rather than improvising one.
 */
export const CONVERSATION_HISTORY_TOOL_NAME: string = Tools.conversation_history;
export const CONVERSATION_TRANSCRIPT_TOOL_NAME: string = Tools.conversation_transcript;

/** Upper bound on a single transcript page, so one call cannot return a whole archive. */
export const MAX_TRANSCRIPT_PAGE = 100;

export const CONVERSATION_HISTORY_DESCRIPTION: string = `Lists the signed-in user's own past conversations, newest first, with their dates and titles. Use it when the user refers to something they discussed before ("last week", "the diabetes question", "what did you tell me about X") and you need to find that conversation. Returns conversation ids and dates only — call \`${CONVERSATION_TRANSCRIPT_TOOL_NAME}\` with an id to read what was actually said. Returns only this user's conversations; it cannot see anyone else's.`;

export const CONVERSATION_TRANSCRIPT_DESCRIPTION: string = `Returns the messages of one of the signed-in user's own past conversations, in order, each with its date, so you can read what was actually said rather than guess. Use it after \`${CONVERSATION_HISTORY_TOOL_NAME}\` identifies a session, or when the user gives a conversation id. Long sessions are paged: pass \`offset\` to continue, and say so if you have not read the whole session. Never present a remembered exchange as if it were from the current conversation — it is a record of an earlier one.`;

const ISO_DATE_DESCRIPTION =
  'ISO 8601 date or date-time, e.g. "2026-09-19" or "2026-09-19T08:30:00Z". Omit for no bound.';

export function getConversationHistoryToolDefinitions(): LCTool[] {
  return [
    {
      name: CONVERSATION_HISTORY_TOOL_NAME,
      description: CONVERSATION_HISTORY_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Text to match against conversation titles, e.g. "insulin" or "chest pain". Omit to list recent sessions regardless of title.',
          },
          since: {
            type: 'string',
            description: `Only sessions last active on or after this date. ${ISO_DATE_DESCRIPTION}`,
          },
          until: {
            type: 'string',
            description: `Only sessions last active on or before this date. ${ISO_DATE_DESCRIPTION}`,
          },
          limit: {
            type: 'number',
            description: 'How many sessions to return, 1-25. Defaults to 10.',
          },
        },
      },
    },
    {
      name: CONVERSATION_TRANSCRIPT_TOOL_NAME,
      description: CONVERSATION_TRANSCRIPT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          conversation_id: {
            type: 'string',
            description:
              "The conversationId returned by the history tool. Must be one of the signed-in user's own conversations.",
          },
          offset: {
            type: 'number',
            description: 'Zero-based index of the first message to return. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: `How many messages to return, 1-${MAX_TRANSCRIPT_PAGE}. Defaults to 40.`,
          },
        },
        required: ['conversation_id'],
      },
    },
  ] as LCTool[];
}
