import { z } from 'zod';
import { toProfileId } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { MemoryMethods, ProfileMethods, IProfileLean } from '@librechat/data-schemas';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import {
  SELF_PROFILE_ID,
  LIST_PROFILES_TOOL_NAME,
  READ_PROFILE_TOOL_NAME,
  CREATE_PROFILE_TOOL_NAME,
  UPDATE_PROFILE_TOOL_NAME,
  DELETE_PROFILE_TOOL_NAME,
  LIST_PROFILES_DESCRIPTION,
  READ_PROFILE_TOOL_NAME_DESCRIPTION,
  CREATE_PROFILE_TOOL_NAME_DESCRIPTION,
  UPDATE_PROFILE_TOOL_NAME_DESCRIPTION,
  DELETE_PROFILE_TOOL_NAME_DESCRIPTION,
  PROFILE_ARG_DESCRIPTION,
} from './definitions';

/**
 * Tools that read and maintain a user's per-person records.
 *
 * The user id is captured when the tool is built from the authenticated
 * request and is never a tool argument, so no model input — including a name
 * supplied by a prompt-injected instruction — can read or edit another
 * account's records. The data methods are injected rather than reached for.
 *
 * Two rules shape everything below.
 *
 * **Nothing is enumerated.** There is no list of names, no list of
 * relationships, and no list of synonyms for "me". A person is whatever the
 * user calls them, and a relationship is free text in the user's words. The
 * single reserved string is `self`, and it is reserved because these tools
 * publish it themselves as the identifier of the user's own record — it is a
 * contract with our own output, not vocabulary we invented about people.
 *
 * **Identity is a storage fact, not a spelling.** The record's key is derived
 * once, from the label it was created with, and never moves: renaming changes
 * how a person is shown, not where their facts are filed. Every lookup
 * therefore consults the registry — by key first, then by the name the record
 * now carries — instead of re-deriving a key from whatever was typed this
 * turn. That is what keeps "the same person" stable across spelling, script,
 * case and later correction.
 */
export interface ProfileToolDeps {
  getUserProfiles: ProfileMethods['getUserProfiles'];
  ensureSelfProfile: ProfileMethods['ensureSelfProfile'];
  createProfile: ProfileMethods['createProfile'];
  updateProfile: ProfileMethods['updateProfile'];
  deleteProfile: ProfileMethods['deleteProfile'];
  getFormattedMemories: MemoryMethods['getFormattedMemories'];
  getUserMemories: MemoryMethods['getUserMemories'];
}

/** Comparison-only normalization; never a storage key. */
const normalizeLabel = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

export interface ProfileTarget {
  /** Absent when the label addresses the user themselves, or names nobody. */
  profileId?: string;
  isSelf: boolean;
  /** The label as the user wrote it, for speaking back to them. */
  label: string;
}

const SELF_LABEL = 'the user themselves';

/**
 * Resolves a label to a record without consulting storage, for the cases where
 * the answer is decidable from the label alone: blank means the user's own
 * record, and so does the published id `self`, and so does the name the user's
 * own record carries. Anything else is a person, keyed by `toProfileId`.
 *
 * `selfName` is the name on the record itself, so a user who has given their
 * record their own name is addressed by that name — no synonym list can know
 * that, and no synonym list should have to.
 */
export function resolveProfileName(value: string | undefined, selfName?: string): ProfileTarget {
  const label = (value ?? '').trim();
  if (label === '') {
    return { isSelf: true, label: SELF_LABEL };
  }
  const normalized = normalizeLabel(label);
  if (
    normalized === SELF_PROFILE_ID ||
    (selfName != null && normalizeLabel(selfName) === normalized)
  ) {
    return { isSelf: true, label };
  }
  const profileId = toProfileId(label);
  /** A label that names nobody (punctuation only) is not a person and must not
   *  become a partition — least of all the self one. */
  if (profileId === '') {
    return { isSelf: false, label };
  }
  return { profileId, isSelf: false, label };
}

interface ProfileRegistry {
  selfName?: string;
  profiles: Array<IProfileLean & { factCount?: number }>;
}

/**
 * Reads the registry once per tool call. Every resolution in this module is
 * answered from this snapshot rather than by deriving a key and hoping it
 * matches, because a record's name can be edited while its key cannot move.
 */
async function loadRegistry({
  userId,
  getUserProfiles,
  ensureSelfProfile,
}: {
  userId: string;
  getUserProfiles: ProfileMethods['getUserProfiles'];
  ensureSelfProfile: ProfileMethods['ensureSelfProfile'];
}): Promise<ProfileRegistry> {
  const self = await ensureSelfProfile(userId);
  const profiles = await getUserProfiles(userId);
  return { selfName: self?.name, profiles };
}

/** Finds the record a target names: by key, then by the name it now carries. */
function findEntry(
  registry: ProfileRegistry,
  target: ProfileTarget,
): (IProfileLean & { factCount?: number }) | undefined {
  if (target.isSelf) {
    return registry.profiles.find((entry) => entry.isSelf === true);
  }
  if (target.profileId == null) {
    return undefined;
  }
  const byKey = registry.profiles.find((entry) => entry.profileId === target.profileId);
  if (byKey != null) {
    return byKey;
  }
  const wanted = normalizeLabel(target.label);
  const others = registry.profiles.filter(
    (entry) => entry.isSelf !== true && entry.profileId != null,
  );
  const byName = others.find((entry) => normalizeLabel(String(entry.name ?? '')) === wanted);
  if (byName != null) {
    return byName;
  }
  /** The label may be a record line copied back whole — name plus relationship,
   *  in the form this module prints it or the older comma form. */
  return others.find((entry) => {
    if (entry.relationship == null) {
      return false;
    }
    const name = String(entry.name ?? '');
    return (
      normalizeLabel(`${name}, ${entry.relationship}`) === wanted ||
      normalizeLabel(`${name} (relationship: ${entry.relationship})`) === wanted
    );
  });
}

function formatProfileLine(profile: IProfileLean & { factCount?: number }): string {
  const who = profile.isSelf ? `${profile.name} (the user themselves)` : profile.name;
  const relation = profile.relationship != null ? ` (relationship: ${profile.relationship})` : '';
  const count = profile.factCount ?? 0;
  return `- ${profile.profileId ?? SELF_PROFILE_ID}: ${who}${relation} — ${count} stored fact${
    count === 1 ? '' : 's'
  }`;
}

/** Which records exist, so a label that matched none can be retried with the right key. */
function formatRecordList(registry: ProfileRegistry): string {
  const ordered = [
    ...registry.profiles.filter((entry) => entry.isSelf === true),
    ...registry.profiles.filter((entry) => entry.isSelf !== true),
  ];
  return ordered.map((entry) => formatProfileLine(entry)).join('\n');
}

const unusableLabel = (label: string): string =>
  `"${label}" is punctuation or spacing only, so it does not name anyone and cannot be used as a record. Ask the user what they call this person.`;

const noRecordFor = (label: string, registry: ProfileRegistry): string =>
  [
    `There is no record called "${label}". Records on file (the value before the colon is the key to pass as \`profile\`):`,
    '',
    formatRecordList(registry),
    '',
    `If the person the user means is clearly one of these, call \`${READ_PROFILE_TOOL_NAME}\` again with that record's key. If none of them is that person, nothing is stored about them: say so plainly, and never read or report another person's record in their place.`,
  ].join('\n');

const noSuchPerson = (label: string): string =>
  `No facts are stored about ${label} yet. If the user asked what is on file about them, say plainly that nothing is stored yet; do not answer a different question instead. Otherwise answer from what the user tells you in this conversation, and do not describe an empty record as a known history. If they want a record kept, ask them first and then use \`${CREATE_PROFILE_TOOL_NAME}\`.`;

export function createListProfilesTool({
  userId,
  agentId,
  getUserProfiles,
  ensureSelfProfile,
}: ProfileToolDeps & { userId: string; agentId?: string }): DynamicStructuredTool {
  return tool(
    async () => {
      const self = await ensureSelfProfile(userId);
      const profiles = await getUserProfiles(userId, { agentId });
      const selfEntry = profiles.find((profile) => profile.isSelf === true) ?? self;
      const ordered = [selfEntry, ...profiles.filter((profile) => profile.isSelf !== true)];
      if (ordered.length === 0) {
        return 'No records are being kept for anyone yet.';
      }
      return [
        'People with a record on file (the value before the colon is the key to pass as `profile`):',
        '',
        ...ordered.map((profile) => formatProfileLine(profile as IProfileLean)),
        '',
        `Read a person's facts with \`${READ_PROFILE_TOOL_NAME}\` before answering anything that depends on what you already know about them. Open a record for someone new with \`${CREATE_PROFILE_TOOL_NAME}\` — theirs, or anyone's — only after the user has agreed.`,
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
  agentId,
  getFormattedMemories,
  getUserMemories,
  getUserProfiles,
  ensureSelfProfile,
}: ProfileToolDeps & { userId: string; agentId?: string }): DynamicStructuredTool {
  return tool(
    async ({ profile }) => {
      const registry = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
      const target = resolveProfileName(profile, registry.selfName);
      if (!target.isSelf && target.profileId == null) {
        return unusableLabel(target.label);
      }
      const entry = findEntry(registry, target);
      if (entry == null && !target.isSelf) {
        return noRecordFor(target.label, registry);
      }
      const partition = {
        userId,
        profileId: entry?.profileId,
        ...(agentId !== undefined ? { agentId } : {}),
      };
      const [formatted, entries] = await Promise.all([
        getFormattedMemories(partition),
        getUserMemories(partition),
      ]);
      if (entries.length === 0) {
        return noSuchPerson(target.isSelf ? SELF_LABEL : target.label);
      }
      const recordKey = target.isSelf ? SELF_PROFILE_ID : (entry?.profileId ?? target.label);
      return [
        `Facts on file about ${target.isSelf ? SELF_LABEL : target.label}:`,
        '',
        formatted.withKeys,
        '',
        `If the user has told you in this conversation that any of these has changed — a medicine stopped, switched or re-dosed, a condition resolved, an entry that was a mistake — correct it now, before you answer: \`set_memory\` with the same key and \`profile\` set to \`${recordKey}\` (the value replaces the old one, so write the whole current entry), or \`delete_memory\` for what is no longer true at all. A change the user's own doctor made is the current fact. Then tell the user in one line what you changed.`,
      ].join('\n');
    },
    {
      name: READ_PROFILE_TOOL_NAME,
      description: READ_PROFILE_TOOL_NAME_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({
        profile: z.string().min(1).describe(PROFILE_ARG_DESCRIPTION),
      }),
    },
  );
}

export function createCreateProfileTool({
  userId,
  getUserProfiles,
  ensureSelfProfile,
  createProfile,
}: Pick<ProfileToolDeps, 'getUserProfiles' | 'ensureSelfProfile' | 'createProfile'> & {
  userId: string;
}): DynamicStructuredTool {
  return tool(
    async ({ name, relationship }) => {
      const registry = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
      const target = resolveProfileName(name, registry.selfName);
      if (target.isSelf) {
        return `The user already has their own record (${registry.selfName ?? SELF_LABEL}); there is nothing to create. If they want it labelled differently, use \`${UPDATE_PROFILE_TOOL_NAME}\` with \`${SELF_PROFILE_ID}\`.`;
      }
      if (target.profileId == null) {
        return unusableLabel(target.label);
      }
      const existing = findEntry(registry, target);
      if (existing != null) {
        return `A record already exists for "${existing.name}" (${existing.profileId ?? SELF_PROFILE_ID}). Nothing was created — write facts to it with \`set_memory\`, or correct its label with \`${UPDATE_PROFILE_TOOL_NAME}\` if the name is wrong.`;
      }
      const result = await createProfile({
        userId,
        name: target.label,
        ...(relationship != null && relationship.trim() !== ''
          ? { relationship: relationship.trim() }
          : {}),
      });
      if (!result.ok) {
        /** A concurrent first write may have opened it; report that honestly
         *  rather than claiming a record that this call did not create. */
        const raced = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
        const found = findEntry(raced, target);
        return found != null
          ? `A record for "${found.name}" was opened at the same moment (${found.profileId ?? SELF_PROFILE_ID}); it is ready to write to.`
          : `Could not open a record for "${target.label}". Nothing was stored. Ask the user to confirm the name.`;
      }
      const key = result.profile?.profileId ?? target.profileId;
      const relation =
        relationship != null && relationship.trim() !== '' ? ` (${relationship.trim()})` : '';
      return `Opened a record for "${target.label}"${relation} as \`${key}\`. The user has agreed to this record, so do not ask again. Now store, in this same turn, every lasting fact the user has already told you about this person in this conversation: one \`set_memory\` call per fact type with \`profile\` set to \`${key}\`. Then tell the user, in one or two lines, what you stored under this record and that they can ask you to remove it at any time.`;
    },
    {
      name: CREATE_PROFILE_TOOL_NAME,
      description: CREATE_PROFILE_TOOL_NAME_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({
        name: z.string().min(1).describe("The person, in the user's own words."),
        relationship: z
          .string()
          .optional()
          .describe('Optional: how the user says this person relates to them, in their words.'),
      }),
    },
  );
}

export function createUpdateProfileTool({
  userId,
  getUserProfiles,
  ensureSelfProfile,
  updateProfile,
}: Pick<ProfileToolDeps, 'getUserProfiles' | 'ensureSelfProfile' | 'updateProfile'> & {
  userId: string;
}): DynamicStructuredTool {
  return tool(
    async ({ profile, name, relationship }) => {
      if (
        (name == null || name.trim() === '') &&
        (relationship == null || relationship.trim() === '')
      ) {
        return 'Nothing to change: pass a corrected name, a relationship, or both.';
      }
      const registry = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
      const target = resolveProfileName(profile, registry.selfName);
      if (!target.isSelf && target.profileId == null) {
        return unusableLabel(target.label);
      }
      const entry = findEntry(registry, target);
      if (entry == null) {
        return noSuchPerson(target.label);
      }
      const result = await updateProfile({
        userId,
        ...(entry.isSelf === true ? { isSelf: true } : { profileId: entry.profileId as string }),
        ...(name != null && name.trim() !== '' ? { name: name.trim() } : {}),
        ...(relationship != null && relationship.trim() !== ''
          ? { relationship: relationship.trim() }
          : {}),
      });
      if (!result.ok) {
        return `Could not change the record for "${entry.name}". It is unchanged.`;
      }
      const changed = [
        name != null && name.trim() !== '' ? `name is now "${name.trim()}"` : null,
        relationship != null && relationship.trim() !== ''
          ? `relationship is now "${relationship.trim()}"`
          : null,
      ].filter((part): part is string => part != null);
      return `Updated the record (${entry.profileId ?? SELF_PROFILE_ID}): ${changed.join(', ')}. The facts stored about this person did not move, and none were changed.`;
    },
    {
      name: UPDATE_PROFILE_TOOL_NAME,
      description: UPDATE_PROFILE_TOOL_NAME_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({
        profile: z.string().min(1).describe(PROFILE_ARG_DESCRIPTION),
        name: z.string().optional().describe("The corrected name, in the user's words."),
        relationship: z
          .string()
          .optional()
          .describe('How the user now describes this person, in their words.'),
      }),
    },
  );
}

export function createDeleteProfileTool({
  userId,
  getUserProfiles,
  ensureSelfProfile,
  deleteProfile,
}: Pick<ProfileToolDeps, 'getUserProfiles' | 'ensureSelfProfile' | 'deleteProfile'> & {
  userId: string;
}): DynamicStructuredTool {
  return tool(
    async ({ profile }) => {
      const registry = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
      const target = resolveProfileName(profile, registry.selfName);
      if (target.isSelf) {
        /** The same refusal the data layer makes, stated in the tool result so
         *  the model does not read silence as success. */
        return `The user's own record cannot be removed — it holds their own facts and there is nowhere else to put them. If they want to forget particular facts, remove those with \`delete_memory\` instead.`;
      }
      if (target.profileId == null) {
        return unusableLabel(target.label);
      }
      const entry = findEntry(registry, target);
      if (entry == null) {
        return `There is no record for "${target.label}", so nothing was removed.`;
      }
      const result = await deleteProfile({ userId, profileId: entry.profileId as string });
      if (!result.ok) {
        return `Could not remove the record for "${entry.name}"; it is unchanged and its facts are intact.`;
      }
      const removed = result.deletedMemories;
      return `Removed the record for "${entry.name}"${
        removed != null
          ? ` and ${removed} stored fact${removed === 1 ? '' : 's'}`
          : ' and its stored facts'
      }. This cannot be undone — tell the user plainly what was removed.`;
    },
    {
      name: DELETE_PROFILE_TOOL_NAME,
      description: DELETE_PROFILE_TOOL_NAME_DESCRIPTION,
      responseFormat: 'content',
      schema: z.object({
        profile: z.string().min(1).describe(PROFILE_ARG_DESCRIPTION),
      }),
    },
  );
}

/**
 * Resolves a `profile` argument on a memory write into a partition, opening the
 * record the first time a named person is written about.
 *
 * The model can only supply a label; whether that person may be recorded at all
 * is the agent's judgement under the memory guard, and the tool says plainly
 * when a new record was opened so a record can never appear quietly. An
 * unusable label, or a create that fails for any reason other than losing a
 * race, throws: writing the fact anyway would file it under whoever owns the
 * fallback partition, which is the user themselves.
 */
export async function prepareProfileTarget({
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
  const registry = await loadRegistry({ userId, getUserProfiles, ensureSelfProfile });
  const target = resolveProfileName(profile, registry.selfName);
  if (target.isSelf) {
    return {};
  }
  if (target.profileId == null) {
    throw new Error(`"${target.label}" does not name a person and cannot be stored`);
  }
  const existing = findEntry(registry, target);
  if (existing != null) {
    return { profileId: existing.profileId };
  }
  /** The row stores the label the user used; the key is only the partition, so
   *  a name the key cannot spell (any non-Latin script) is still readable. */
  const result = await createProfile({ userId, name: target.label });
  if (!result.ok && result.conflict !== true) {
    throw new Error(`Could not open a record for "${target.label}"`);
  }
  if (!result.ok) {
    /** A concurrent write won the race; the partition exists either way. */
    return { profileId: target.profileId };
  }
  return { profileId: target.profileId, created: target.label };
}
