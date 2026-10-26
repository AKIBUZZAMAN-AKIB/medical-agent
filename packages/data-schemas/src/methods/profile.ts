import { Types } from 'mongoose';
import type * as t from '~/types';
import { toProfileId } from '~/schema/profile';
import logger from '~/config/winston';

export interface ProfileMethodDeps {
  deleteMemoriesByProfile: (params: t.DeleteMemoriesByProfileParams) => Promise<number>;
}

export interface UserProfileWithCounts extends t.IProfileLean {
  factCount: number;
  tokenCount: number;
}

export interface GetUserProfilesOptions {
  /**
   * Scope counts to one agent partition (`null`/`undefined` value = shared
   * personal pool). Omit `options` completely to count across every partition
   * owned by the user (matching what `deleteProfile` removes).
   */
  agentId?: string | null;
}

/**
 * Registry of the people a user keeps memory about.
 *
 * Every read is keyed on `userId`, and the cascade on delete is a
 * `deleteMemoriesByProfile` for that person across partitions — deleting a
 * profile must remove that person's record completely and nothing else, so the
 * self partition is refused outright rather than special-cased.
 */
export function createProfileMethods(
  mongoose: typeof import('mongoose'),
  deps: ProfileMethodDeps,
): {
  getUserProfiles: (
    userId: string | Types.ObjectId,
    options?: GetUserProfilesOptions,
  ) => Promise<UserProfileWithCounts[]>;
  getUserProfile: (
    userId: string | Types.ObjectId,
    profileId: string,
  ) => Promise<t.IProfileLean | null>;
  ensureSelfProfile: (userId: string | Types.ObjectId, name?: string) => Promise<t.IProfileLean>;
  createProfile: (params: t.CreateProfileParams) => Promise<t.ProfileResult>;
  updateProfile: (params: t.UpdateProfileParams) => Promise<t.ProfileResult>;
  deleteProfile: ({
    userId,
    profileId,
  }: {
    userId: string | Types.ObjectId;
    profileId: string;
  }) => Promise<t.ProfileResult>;
} {
  const getModel = () => mongoose.models.Profile;

  /**
   * The user's own profile has no `profileId`, so its memories land in the null
   * partition alongside every row written before profiles existed. That is the
   * whole reason it is modelled as an absent field rather than a `'self'`
   * string: it needs no backfill to keep working.
   */
  async function ensureSelfProfile(
    userId: string | Types.ObjectId,
    name = 'Me',
  ): Promise<t.IProfileLean> {
    const Profile = getModel();
    const existing = (await Profile.findOne({
      userId,
      isSelf: true,
    }).lean()) as t.IProfileLean | null;
    if (existing != null) {
      return existing;
    }
    /** `isSelf` has its own partial index, so a concurrent first call can lose
     *  the race; re-reading turns that loser into a success instead of a throw. */
    try {
      const created = (await Profile.create({
        userId,
        name,
        isSelf: true,
      })) as unknown as t.IProfileLean;
      return created;
    } catch (error) {
      const retried = (await Profile.findOne({
        userId,
        isSelf: true,
      }).lean()) as t.IProfileLean | null;
      if (retried != null) {
        return retried;
      }
      throw error;
    }
  }

  /**
   * Lists a user's profiles with how much is stored under each, so the UI can
   * show what deleting one would actually remove. Counts come from a single
   * grouped read rather than one query per profile.
   */
  async function getUserProfiles(
    userId: string | Types.ObjectId,
    options?: GetUserProfilesOptions,
  ): Promise<UserProfileWithCounts[]> {
    const Profile = getModel();
    const MemoryEntry = mongoose.models.MemoryEntry;
    const memoryFilter =
      options === undefined ? { userId } : { userId, agentId: options.agentId ?? null };
    const [profiles, memories] = await Promise.all([
      Profile.find({ userId }).lean() as unknown as Promise<t.IProfileLean[]>,
      MemoryEntry.find(memoryFilter, {
        profileId: 1,
        tokenCount: 1,
      }).lean() as unknown as Promise<Array<{ profileId?: string; tokenCount?: number }>>,
    ]);

    const counts = new Map<string, { factCount: number; tokenCount: number }>();
    for (const memory of memories) {
      /** Absent and null are the same partition, so normalise before grouping. */
      const key = memory.profileId ?? SELF_PARTITION_KEY;
      const current = counts.get(key) ?? { factCount: 0, tokenCount: 0 };
      current.factCount += 1;
      current.tokenCount += memory.tokenCount ?? 0;
      counts.set(key, current);
    }

    return profiles
      .map((profile) => {
        const stat = counts.get(profile.profileId ?? SELF_PARTITION_KEY) ?? {
          factCount: 0,
          tokenCount: 0,
        };
        return { ...profile, factCount: stat.factCount, tokenCount: stat.tokenCount };
      })
      .sort((a, b) => {
        if (a.isSelf === b.isSelf) {
          return a.name.localeCompare(b.name);
        }
        return a.isSelf ? -1 : 1;
      });
  }

  async function getUserProfile(
    userId: string | Types.ObjectId,
    profileId: string,
  ): Promise<t.IProfileLean | null> {
    const Profile = getModel();
    return (await Profile.findOne({ userId, profileId }).lean()) as t.IProfileLean | null;
  }

  async function createProfile({
    userId,
    name,
    relationship,
  }: t.CreateProfileParams): Promise<t.ProfileResult> {
    const Profile = getModel();
    const profileId = toProfileId(name);
    if (profileId === '') {
      return { ok: false };
    }
    const existing = await Profile.exists({ userId, profileId });
    if (existing) {
      return { ok: false, conflict: true };
    }
    try {
      const created = await Profile.create({
        userId,
        profileId,
        name: name.trim(),
        ...(relationship != null && relationship !== ''
          ? { relationship: relationship.trim() }
          : {}),
      });
      return { ok: true, profile: created.toObject() as t.IProfileLean };
    } catch (error) {
      /** The unique index is the real guard; a losing race reads as a conflict
       *  rather than a 500, because the outcome for the user is identical. */
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return { ok: false, conflict: true };
      }
      throw error;
    }
  }

  async function updateProfile({
    userId,
    profileId,
    isSelf,
    name,
    relationship,
  }: t.UpdateProfileParams): Promise<t.ProfileResult> {
    const Profile = getModel();
    /** The subject must be stated exactly once. A missing key is not "some
     *  record": mongoose drops an undefined condition from the filter, so an
     *  absent `profileId` would have matched whichever record came first and
     *  edited a person the caller never named. The user's own record has no key
     *  at all, which is why it is selected by `isSelf` instead. */
    if ((profileId == null || profileId === '') === (isSelf !== true)) {
      return { ok: false };
    }
    const filter = isSelf === true ? { userId, isSelf: true } : { userId, profileId };
    const existing = await Profile.findOne(filter).lean();
    if (existing == null) {
      return { ok: false };
    }
    const update: Record<string, unknown> = {};
    if (name != null && name.trim() !== '') {
      update.name = name.trim();
    }
    if (relationship === null) {
      update.relationship = undefined;
    } else if (relationship != null && relationship.trim() !== '') {
      update.relationship = relationship.trim();
    }
    if (Object.keys(update).length === 0) {
      return { ok: true, profile: existing as unknown as t.IProfileLean };
    }
    const updated = (await Profile.findOneAndUpdate(filter, update, {
      new: true,
    }).lean()) as unknown as t.IProfileLean | null;
    return updated != null ? { ok: true, profile: updated } : { ok: false };
  }

  async function deleteProfile({
    userId,
    profileId,
  }: {
    userId: string | Types.ObjectId;
    profileId: string;
  }): Promise<t.ProfileResult> {
    const Profile = getModel();
    /** An absent key must delete nothing. Without this the filter degrades to
     *  `{ userId }` and the cascade below would erase the facts of whichever
     *  record matched first. */
    if (profileId == null || profileId === '') {
      return { ok: false };
    }
    const existing = (await Profile.findOne({ userId, profileId }).lean()) as t.IProfileLean | null;
    if (existing == null) {
      return { ok: false };
    }
    if (existing.isSelf === true) {
      /** Refused rather than reassigned: deleting "me" would take the user's
       *  own facts with it, and there is no partition to move them to. */
      return { ok: false };
    }
    const deletedMemories = await deps.deleteMemoriesByProfile({ userId, profileId });
    await Profile.deleteOne({ userId, profileId });
    logger.debug('[profiles] deleted profile and its memories', {
      profileId,
      deletedMemories,
    });
    return { ok: true, profile: existing, deletedMemories };
  }

  return {
    getUserProfiles,
    getUserProfile,
    ensureSelfProfile,
    createProfile,
    updateProfile,
    deleteProfile,
  };
}

/** Grouping key standing in for the null partition in count maps. */
const SELF_PARTITION_KEY = '';

export type ProfileMethods = ReturnType<typeof createProfileMethods>;
