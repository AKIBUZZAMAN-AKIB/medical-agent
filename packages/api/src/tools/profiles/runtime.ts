import { z } from 'zod';
import { toProfileId } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { MemoryMethods, ProfileMethods, IProfileLean } from '@librechat/data-schemas';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import {
  LIST_PROFILES_TOOL_NAME,
  READ_PROFILE_TOOL_NAME,
  LIST_PROFILES_DESCRIPTION,
  READ_PROFILE_TOOL_NAME_DESCRIPTION,
} from './definitions';

/**
 * Tools that read a user's per-person records.
 *
 * The user id is captured when the tool is built from the authenticated
 * request and is never a tool argument, so no model input — including a name
 * supplied by a prompt-injected instruction — can read another account's
 * records. The data methods are injected rather than reached for.
 */
export interface ProfileToolDeps {
  getUserProfiles: ProfileMethods['getUserProfiles'];
  ensureSelfProfile: ProfileMethods['ensureSelfProfile'];
  createProfile: ProfileMethods['createProfile'];
  getFormattedMemories: MemoryMethods['getFormattedMemories'];
  getUserMemories: MemoryMethods['getUserMemories'];
}

export const SELF_PROFILE_ALIASES: Set<string> = new Set([
  'self',
  'me',
  'myself',
  'user',
  'i',
  'own',
]);

/**
 * Resolves a human-entered name to a stored profile. `self` and its aliases map
 * to the null partition — the one that holds the user's own facts and every row
 * written before profiles existed.
 */
export function resolveProfileName(value: string | undefined): {
  profileId?: string;
  isSelf: boolean;
  label: string;
} {
  const label = (value ?? '').trim();
  if (label === '' || SELF_PROFILE_ALIASES.has(label.toLowerCase())) {
    return { isSelf: true, label: 'the user themselves' };
  }
  return { profileId: toProfileId(label), isSelf: false, label };
}

function formatProfileLine(profile: IProfileLean & { factCount?: number }): string {
  const who = profile.isSelf ? `${profile.name} (the user themselves)` : profile.name;
  const relation = profile.relationship != null ? `, ${profile.relationship}` : '';
  const count = profile.factCount ?? 0;
  return `- ${profile.profileId ?? 'self'}: ${who}${relation} — ${count} stored fact${count === 1 ? '' : 's'}`;
}

export function createListProfilesTool({
  userId,
  getUserProfiles,
  ensureSelfProfile,
}: ProfileToolDeps & { userId: string }): DynamicStructuredTool {
  return tool(
    async () => {
      const self = await ensureSelfProfile(userId);
      const profiles = await getUserProfiles(userId);
      const ordered = [self, ...profiles.filter((profile) => profile.isSelf !== true)];
      if (ordered.length === 0) {
        return 'No records are being kept for anyone yet.';
      }
      return [
        'People with a record on file:',
        '',
        ...ordered.map(formatProfileLine),
        '',
        `Read a person's facts with \`${READ_PROFILE_TOOL_NAME}\` before answering anything that depends on what you already know about them.`,
      ].join('\n');
    },
    {
      name: LIST_PROFILES_TOOL_NAME,
      description: LIST_PROFILES_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({}),
    },
  );
}

export function createReadProfileTool({
  userId,
  getFormattedMemories,
  getUserMemories,
  ensureSelfProfile,
}: ProfileToolDeps & { userId: string }): DynamicStructuredTool {
  return tool(
    async ({ profile }) => {
      const target = resolveProfileName(profile);
      if (target.isSelf) {
        await ensureSelfProfile(userId);
      }
      const [formatted, entries] = await Promise.all([
        getFormattedMemories({ userId, profileId: target.profileId }),
        getUserMemories({ userId, profileId: target.profileId }),
      ]);
      if (entries.length === 0) {
        return `No facts are stored about ${target.label} yet. Answer from what the user tells you in this conversation, and do not describe an empty record as a known history.`;
      }
      return `Facts on file about ${target.label}:\n\n${formatted.withKeys}`;
    },
    {
      name: READ_PROFILE_TOOL_NAME,
      description: READ_PROFILE_TOOL_NAME_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({
        profile: z.string().min(1).describe('The person, as listed by the profile list.'),
      }),
    },
  );
}

/**
 * Resolves a `profile` argument on a memory write into a partition, creating the
 * registry row the first time a named person is written about. The model can
 * only supply the name; whether that person may be recorded at all is the
 * agent's judgement under the memory guard, and the tool says plainly when a
 * new record was opened so it cannot happen quietly.
 */
export function prepareProfileTarget({
  userId,
  profile,
  ensureSelfProfile,
  getUserProfiles,
  createProfile,
}: {
  userId: string;
  profile?: string;
  ensureSelfProfile: ProfileMethods['ensureSelfProfile'];
  getUserProfiles: ProfileMethods['getUserProfiles'];
  createProfile: ProfileMethods['createProfile'];
}): Promise<{
  profileId?: string;
  /** Set when this call opened a record for a person who had none. */
  created?: string;
}> {
  const target = resolveProfileName(profile);
  if (target.isSelf || target.profileId == null) {
    return Promise.resolve({});
  }
  const profileId = target.profileId;
  return (async () => {
    await ensureSelfProfile(userId);
    const existing = await getUserProfiles(userId);
    if (existing.some((entry) => entry.profileId === profileId)) {
      return { profileId };
    }
    const result = await createProfile({ userId, name: profileId });
    if (!result.ok) {
      /** A concurrent write won the race; the partition exists either way. */
      return { profileId };
    }
    return { profileId, created: profileId };
  })();
}
