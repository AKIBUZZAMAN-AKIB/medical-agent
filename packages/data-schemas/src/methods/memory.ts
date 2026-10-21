import { Types } from 'mongoose';
import type * as t from '~/types';
import logger from '~/config/winston';

/**
 * Formats a date in YYYY-MM-DD format
 */
const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

/** Partition filter: `agentId: null` matches both null and missing fields,
 *  so pre-partition entries remain part of the shared personal pool.
 *
 *  The same trick gives `profileId` a free migration: a row written before
 *  profiles existed has no `profileId` field, and a `{ profileId: null }`
 *  filter matches it. So existing memories stay in the user's own partition
 *  with no backfill, while a filter for any named profile can never match
 *  them — the isolation holds without a single row being rewritten. */
const partitionFilter = (agentId?: string, profileId?: string) => ({
  agentId: agentId ?? null,
  profileId: profileId ?? null,
});

// Factory function that takes mongoose instance and returns the methods
export function createMemoryMethods(mongoose: typeof import('mongoose')): {
  setMemory: ({
    userId,
    key,
    value,
    tokenCount,
    agentId,
    profileId,
  }: t.SetMemoryParams) => Promise<t.MemoryResult>;
  createMemory: ({
    userId,
    key,
    value,
    tokenCount,
    agentId,
    profileId,
  }: t.SetMemoryParams) => Promise<t.MemoryResult>;
  deleteMemory: ({
    userId,
    key,
    agentId,
    profileId,
  }: t.DeleteMemoryParams) => Promise<t.MemoryResult>;
  setMemoryById: (params: t.SetMemoryByIdParams) => Promise<t.SetMemoryByIdResult>;
  deleteMemoryById: (params: t.MemoryByIdParams) => Promise<t.MemoryResult>;
  getAllUserMemories: (userId: string | Types.ObjectId) => Promise<t.IMemoryEntryLean[]>;
  getUserMemories: ({
    userId,
    agentId,
    profileId,
  }: t.GetUserMemoriesParams) => Promise<t.IMemoryEntryLean[]>;
  getFormattedMemories: ({
    userId,
    agentId,
    profileId,
  }: t.GetFormattedMemoriesParams) => Promise<t.FormattedMemoriesResult>;
  deleteMemoriesByProfile: (params: t.DeleteMemoriesByProfileParams) => Promise<number>;
  deleteAllUserMemories: (userId: string | Types.ObjectId) => Promise<number>;
} {
  /**
   * Creates a new memory entry for a user
   * Throws an error if a memory with the same key already exists
   */
  async function createMemory({
    userId,
    key,
    value,
    tokenCount = 0,
    agentId,
    profileId,
  }: t.SetMemoryParams): Promise<t.MemoryResult> {
    try {
      if (key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const existingMemory = await MemoryEntry.findOne({
        userId,
        key,
        ...partitionFilter(agentId, profileId),
      });
      if (existingMemory) {
        throw new Error('Memory with this key already exists');
      }

      await MemoryEntry.create({
        userId,
        key,
        value,
        tokenCount,
        ...(agentId ? { agentId } : {}),
        ...(profileId ? { profileId } : {}),
        updated_at: new Date(),
      });

      return { ok: true };
    } catch (error) {
      throw new Error(
        `Failed to create memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Sets or updates a memory entry for a user
   */
  async function setMemory({
    userId,
    key,
    value,
    tokenCount = 0,
    agentId,
    profileId,
  }: t.SetMemoryParams): Promise<t.MemoryResult> {
    try {
      if (key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      await MemoryEntry.findOneAndUpdate(
        { userId, key, ...partitionFilter(agentId, profileId) },
        {
          value,
          tokenCount,
          ...(agentId ? { agentId } : {}),
          ...(profileId ? { profileId } : {}),
          updated_at: new Date(),
        },
        {
          upsert: true,
          new: true,
        },
      );

      return { ok: true };
    } catch (error) {
      throw new Error(
        `Failed to set memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Deletes a specific memory entry for a user
   */
  async function deleteMemory({
    userId,
    key,
    agentId,
    profileId,
  }: t.DeleteMemoryParams): Promise<t.MemoryResult> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const result = await MemoryEntry.findOneAndDelete({
        userId,
        key,
        ...partitionFilter(agentId, profileId),
      });
      return { ok: !!result };
    } catch (error) {
      throw new Error(
        `Failed to delete memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /** Updates an existing memory without requiring its authored key. */
  async function setMemoryById({
    userId,
    id,
    key,
    value,
    tokenCount = 0,
    agentId,
    profileId,
  }: t.SetMemoryByIdParams): Promise<t.SetMemoryByIdResult> {
    try {
      if (!mongoose.Types.ObjectId.isValid(id) || key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const recordFilter = { _id: id, userId, ...partitionFilter(agentId, profileId) };
      const existingMemory = (await MemoryEntry.findOne(
        recordFilter,
      ).lean()) as t.IMemoryEntryLean | null;
      if (!existingMemory) {
        return { ok: false };
      }

      if (key != null && key !== existingMemory.key) {
        const duplicate = await MemoryEntry.exists({
          userId,
          key,
          ...partitionFilter(agentId, profileId),
          _id: { $ne: existingMemory._id },
        });
        if (duplicate) {
          return { ok: false, conflict: true };
        }
      }

      const updatedMemory = (await MemoryEntry.findOneAndUpdate(
        recordFilter,
        {
          ...(key != null ? { key } : {}),
          value,
          tokenCount,
          updated_at: new Date(),
        },
        { new: true, runValidators: true },
      ).lean()) as t.IMemoryEntryLean | null;

      return updatedMemory ? { ok: true, memory: updatedMemory } : { ok: false };
    } catch (error) {
      throw new Error(
        `Failed to update memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /** Deletes an existing memory without requiring its authored key. */
  async function deleteMemoryById({
    userId,
    id,
    agentId,
    profileId,
  }: t.MemoryByIdParams): Promise<t.MemoryResult> {
    try {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const result = await MemoryEntry.findOneAndDelete({
        _id: id,
        userId,
        ...partitionFilter(agentId, profileId),
      });
      return { ok: !!result };
    } catch (error) {
      throw new Error(
        `Failed to delete memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets all memory entries for a user across every partition
   */
  async function getAllUserMemories(
    userId: string | Types.ObjectId,
  ): Promise<t.IMemoryEntryLean[]> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      return (await MemoryEntry.find({ userId }).lean()) as t.IMemoryEntryLean[];
    } catch (error) {
      throw new Error(
        `Failed to get all memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets a user's memory entries for a single partition
   * (the shared personal pool when `agentId` is omitted, the user themselves
   * when `profileId` is omitted)
   */
  async function getUserMemories({
    userId,
    agentId,
    profileId,
  }: t.GetUserMemoriesParams): Promise<t.IMemoryEntryLean[]> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      return (await MemoryEntry.find({
        userId,
        ...partitionFilter(agentId, profileId),
      }).lean()) as t.IMemoryEntryLean[];
    } catch (error) {
      throw new Error(
        `Failed to get memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets and formats a partition's memories for a user in two different formats
   */
  async function getFormattedMemories({
    userId,
    agentId,
    profileId,
  }: t.GetFormattedMemoriesParams): Promise<t.FormattedMemoriesResult> {
    try {
      const memories = await getUserMemories({ userId, agentId, profileId });

      if (!memories || memories.length === 0) {
        return {
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
          tokenCountsByKey: new Map<string, number>(),
        };
      }

      const sortedMemories = memories.sort(
        (a, b) => new Date(a.updated_at!).getTime() - new Date(b.updated_at!).getTime(),
      );

      const { totalTokens, tokenCountsByKey } = sortedMemories.reduce(
        (counts, memory) => {
          const tokenCount = memory.tokenCount || 0;
          counts.totalTokens += tokenCount;
          counts.tokenCountsByKey.set(memory.key, tokenCount);
          return counts;
        },
        { totalTokens: 0, tokenCountsByKey: new Map<string, number>() },
      );

      const withKeys = sortedMemories
        .map((memory, index) => {
          const date = formatDate(new Date(memory.updated_at!));
          const tokenInfo = memory.tokenCount ? ` [${memory.tokenCount} tokens]` : '';
          return `${index + 1}. [${date}]. ["key": "${memory.key}"]${tokenInfo}. ["value": "${memory.value}"]`;
        })
        .join('\n\n');

      const withoutKeys = sortedMemories
        .map((memory, index) => {
          const date = formatDate(new Date(memory.updated_at!));
          return `${index + 1}. [${date}]. ${memory.value}`;
        })
        .join('\n\n');

      return { withKeys, withoutKeys, totalTokens, tokenCountsByKey };
    } catch (error) {
      logger.error('Failed to get formatted memories:', error);
      return {
        withKeys: '',
        withoutKeys: '',
        totalTokens: 0,
        tokenCountsByKey: new Map<string, number>(),
      };
    }
  }

  /**
   * Deletes all memory entries for a user
   */
  async function deleteAllUserMemories(userId: string | Types.ObjectId): Promise<number> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const result = await MemoryEntry.deleteMany({ userId });
      return result.deletedCount;
    } catch (error) {
      throw new Error(
        `Failed to delete all user memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Deletes every memory row for one subject, leaving the user's other profiles
   * intact. Used when a profile is deleted: the point of a profile is that
   * removing it removes that person's record and nothing else.
   */
  async function deleteMemoriesByProfile({
    userId,
    profileId,
    agentId,
  }: t.DeleteMemoriesByProfileParams): Promise<number> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      /**
       * When `agentId` is omitted (e.g. revoking a person's profile from
       * Settings), remove that person's facts across every agent partition so
       * isolated agents do not retain orphaned health records. When `agentId`
       * is supplied explicitly, restrict deletion to that single partition.
       */
      const result = await MemoryEntry.deleteMany({
        userId,
        profileId: profileId ?? null,
        ...(agentId !== undefined ? { agentId: agentId ?? null } : {}),
      });
      return result.deletedCount;
    } catch (error) {
      throw new Error(
        `Failed to delete profile memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  return {
    setMemory,
    createMemory,
    deleteMemory,
    setMemoryById,
    deleteMemoryById,
    getAllUserMemories,
    getUserMemories,
    getFormattedMemories,
    deleteAllUserMemories,
    deleteMemoriesByProfile,
  };
}

export type MemoryMethods = ReturnType<typeof createMemoryMethods>;
