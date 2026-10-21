import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import type { ConversationMethods, MessageMethods, IConversation } from '@librechat/data-schemas';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import {
  CONVERSATION_HISTORY_TOOL_NAME,
  CONVERSATION_TRANSCRIPT_TOOL_NAME,
  CONVERSATION_HISTORY_DESCRIPTION,
  CONVERSATION_TRANSCRIPT_DESCRIPTION,
  MAX_TRANSCRIPT_PAGE,
} from './definitions';

/**
 * Read-only recall of the signed-in user's own conversation history.
 *
 * The user id is captured when the tool is built from the authenticated
 * request and is never a tool argument, so there is no input a model — or a
 * prompt injected into one — can supply to reach another account's rows. Every
 * query below filters on it, including the transcript read, so a guessed
 * conversation id returns nothing rather than someone else's history.
 *
 * The data methods are injected rather than reached for, so this module can be
 * exercised without a database and so the storage engine stays behind the
 * data-schemas contract.
 */

export interface ConversationHistoryDeps {
  getConvosByCursor: ConversationMethods['getConvosByCursor'];
  getConvo: ConversationMethods['getConvo'];
  getMessages: MessageMethods['getMessages'];
}

const MAX_HISTORY_PAGE = 25;
const DEFAULT_HISTORY_PAGE = 10;
const DEFAULT_TRANSCRIPT_PAGE = 40;
/** Conversation rows pulled per requested row, so a date filter can skip rows. */
const DATE_FILTER_OVERSAMPLE = 5;
const MAX_TRANSCRIPT_CHARS_PER_MESSAGE = 4000;

const historySchema = z.object({
  query: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_HISTORY_PAGE).optional(),
});

const transcriptSchema = z.object({
  conversation_id: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE).optional(),
});

/**
 * Parses a model-supplied date bound. A bare `YYYY-MM-DD` is anchored to the
 * start of that day so `since` and `until` behave the way a reader expects
 * when both are given for one day.
 */
function parseDateBound(value: string, bound: 'start' | 'end'): Date | undefined {
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const iso = dateOnly ? `${trimmed}T${bound === 'start' ? '00:00:00' : '23:59:59.999'}Z` : trimmed;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function formatDate(value: Date | string | undefined): string {
  if (value == null) {
    return 'unknown date';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown date';
  }
  return date.toISOString();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters truncated in this message]`;
}

/**
 * Flattens a stored message to plain text. Older rows carry a `text` column;
 * newer ones carry structured `content` parts. Assistant messages routinely
 * have the second and only the first when the provider streamed nothing but a
 * tool call, in which case there is legitimately no prose to return.
 */
export function extractMessageText(message: { text?: string; content?: unknown }): string {
  if (typeof message.text === 'string' && message.text.trim() !== '') {
    return message.text;
  }
  const parts = Array.isArray(message.content) ? message.content : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part != null && typeof part === 'object') {
      const record = part as { text?: unknown; type?: unknown };
      if (typeof record.text === 'string' && record.text !== '') {
        texts.push(record.text);
      }
    }
  }
  return texts.join('\n\n').trim();
}

function describeSession(conversation: IConversation): string {
  const title = conversation.title?.trim();
  const label = title != null && title !== '' ? title : '(untitled)';
  const agent = conversation.agent_id != null ? ` · agent ${conversation.agent_id}` : '';
  return `- ${conversation.conversationId}\n  title: ${label}\n  last active: ${formatDate(conversation.updatedAt ?? conversation.createdAt)}${agent}`;
}

export function createConversationHistoryTool({
  userId,
  getConvosByCursor,
}: ConversationHistoryDeps & { userId: string }): DynamicStructuredTool {
  return tool(
    async ({ query, since, until, limit }) => {
      const wanted = Math.min(limit ?? DEFAULT_HISTORY_PAGE, MAX_HISTORY_PAGE);
      const sinceDate = since != null ? parseDateBound(since, 'start') : undefined;
      const untilDate = until != null ? parseDateBound(until, 'end') : undefined;
      const notes: string[] = [];

      if (since != null && sinceDate == null) {
        notes.push(`"${since}" is not a date I can read; it was ignored.`);
      }
      if (until != null && untilDate == null) {
        notes.push(`"${until}" is not a date I can read; it was ignored.`);
      }

      const fetchPage = Math.min(wanted * DATE_FILTER_OVERSAMPLE, 100);
      const matches = async (isArchived: boolean) => {
        const { conversations } = await getConvosByCursor(userId, {
          limit: fetchPage,
          isArchived,
          search: query,
          sortBy: 'updatedAt',
          sortDirection: 'desc',
        });
        return Array.isArray(conversations) ? conversations : [];
      };

      let conversations: IConversation[];
      try {
        /** Archived conversations are fetched as well: a session the user filed
         *  away is still their history, and a recall tool that silently skipped
         *  it would report "not found" for a conversation that exists. */
        const [live, archived] = await Promise.all([matches(false), matches(true)]);
        conversations = [...live, ...archived].sort(
          (a, b) =>
            new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
            new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
        );
      } catch (error) {
        /**
         * Full-text search rides MeiliSearch. Without it the call throws, and a
         * model told "search failed" would report the history as empty. Fall
         * back to a date-ordered listing and say that the text search could not
         * run, so the model knows the result is unfiltered rather than empty.
         */
        if (query == null) {
          throw error;
        }
        notes.push(
          `Full-text search is unavailable in this deployment, so "${query}" was not applied to message contents. The list below is every recent session, newest first.`,
        );
        const { conversations: recent } = await getConvosByCursor(userId, {
          limit: fetchPage,
          sortBy: 'updatedAt',
          sortDirection: 'desc',
        });
        conversations = Array.isArray(recent) ? recent : [];
      }

      const dated = conversations.filter((conversation) => {
        const stamp = new Date(conversation.updatedAt ?? conversation.createdAt ?? 0).getTime();
        if (Number.isNaN(stamp)) {
          return false;
        }
        if (sinceDate != null && stamp < sinceDate.getTime()) {
          return false;
        }
        if (untilDate != null && stamp > untilDate.getTime()) {
          return false;
        }
        return true;
      });

      const page = dated.slice(0, wanted);
      if (page.length === 0) {
        const scope = [
          query != null ? `matching "${query}"` : null,
          sinceDate != null ? `active on or after ${formatDate(sinceDate).slice(0, 10)}` : null,
          untilDate != null ? `active on or before ${formatDate(untilDate).slice(0, 10)}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return [
          `No past conversation found${scope != null ? ` (${scope})` : ''}. Say what was looked for rather than assuming there was nothing.`,
          ...notes,
        ].join('\n');
      }

      const remaining = dated.length - page.length;
      return [
        `${page.length} past conversation${page.length === 1 ? '' : 's'}${scopeSuffix(query, sinceDate, untilDate)}, newest first:`,
        '',
        ...page.map(describeSession),
        ...(remaining > 0
          ? [
              '',
              `${remaining} older session${remaining === 1 ? '' : 's'} matched but were not listed. Narrow the dates to reach them, or read a listed one and page through it.`,
            ]
          : []),
        '',
        `Read one with \`${CONVERSATION_TRANSCRIPT_TOOL_NAME}\` and its conversationId. This listing carries titles and dates only — nothing here says what was said.`,
        ...notes,
      ]
        .filter((line) => line !== '')
        .join('\n');
    },
    {
      name: CONVERSATION_HISTORY_TOOL_NAME,
      description: CONVERSATION_HISTORY_DESCRIPTION,
      responseFormat: 'content',
      schema: historySchema,
    },
  );
}

function scopeSuffix(
  query: string | undefined,
  sinceDate: Date | undefined,
  untilDate: Date | undefined,
): string {
  const parts = [
    query != null ? `matching "${query}"` : null,
    sinceDate != null ? `from ${formatDate(sinceDate).slice(0, 10)}` : null,
    untilDate != null ? `to ${formatDate(untilDate).slice(0, 10)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(', ')}` : '';
}

export function createConversationTranscriptTool({
  userId,
  getConvo,
  getMessages,
}: ConversationHistoryDeps & { userId: string }): DynamicStructuredTool {
  return tool(
    async ({ conversation_id, offset, limit }) => {
      /**
       * Ownership is checked before any message is read. `getConvo` is
       * user-scoped, so a conversation belonging to somebody else is
       * indistinguishable from one that does not exist.
       */
      const conversation = await getConvo(userId, conversation_id);
      if (conversation == null) {
        return `No conversation "${conversation_id}" belongs to this account. It may never have existed, or it may belong to another user.`;
      }

      const pageSize = Math.min(limit ?? DEFAULT_TRANSCRIPT_PAGE, MAX_TRANSCRIPT_PAGE);
      const start = Math.max(offset ?? 0, 0);
      /** One extra row tells us whether another page exists without a count. */
      const messages = await getMessages(
        { user: userId, conversationId: conversation_id },
        'messageId text content isCreatedByUser createdAt endpoint model parentMessageId thread_id',
        { sort: { createdAt: 1 }, ...(start > 0 ? { skip: start } : {}), limit: pageSize + 1 },
      );
      if (!Array.isArray(messages) || messages.length === 0) {
        return start > 0
          ? `No messages at or after offset ${start} in conversation "${conversation_id}".`
          : `Conversation "${conversation_id}" has no readable messages.`;
      }

      const hasMore = messages.length > pageSize;
      const page = messages.slice(0, pageSize);
      const rendered = page
        .map((message, index) => {
          const role = message.isCreatedByUser ? 'user' : 'assistant';
          const stamp = formatDate(message.createdAt);
          const text = extractMessageText(message);
          const body =
            text !== ''
              ? truncate(text, MAX_TRANSCRIPT_CHARS_PER_MESSAGE)
              : '(no text: this turn produced tool calls only)';
          return `[${start + index + 1}] ${stamp} · ${role}\n${body}`;
        })
        .join('\n\n');

      const header = `Messages ${start + 1}-${start + page.length} of ${
        hasMore ? `at least ${start + page.length + 1}` : start + page.length
      } from "${conversation.title?.trim() || '(untitled)'}", last active ${formatDate(
        conversation.updatedAt ?? conversation.createdAt,
      )}:`;

      const footer = hasMore
        ? `This session continues. Call again with offset ${start + page.length} for the next messages; do not describe the rest of it until you have read it.`
        : 'End of session.';

      return `${header}\n\n${rendered}\n\n${footer}`;
    },
    {
      name: CONVERSATION_TRANSCRIPT_TOOL_NAME,
      description: CONVERSATION_TRANSCRIPT_DESCRIPTION,
      responseFormat: 'content',
      schema: transcriptSchema,
    },
  );
}
