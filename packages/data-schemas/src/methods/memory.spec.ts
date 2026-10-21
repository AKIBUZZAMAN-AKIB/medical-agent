import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMemoryEntry } from '~/types';
import { createMemoryMethods, type MemoryMethods } from './memory';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let MemoryEntry: mongoose.Model<IMemoryEntry>;
let methods: MemoryMethods;

const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const agentId = 'agent_partition_a';
const otherAgentId = 'agent_partition_b';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  MemoryEntry = mongoose.models.MemoryEntry as mongoose.Model<IMemoryEntry>;
  methods = createMemoryMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await MemoryEntry.deleteMany({});
});

describe('memory partitions', () => {
  it('writes to the shared personal pool when agentId is omitted', async () => {
    await methods.setMemory({ userId, key: 'preference', value: 'likes tea', tokenCount: 3 });

    const personal = await methods.getUserMemories({ userId });
    expect(personal).toHaveLength(1);
    expect(personal[0].agentId == null).toBe(true);

    const agentScoped = await methods.getUserMemories({ userId, agentId });
    expect(agentScoped).toHaveLength(0);
  });

  it('isolates the same key across partitions', async () => {
    await methods.setMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 });
    await methods.setMemory({ userId, key: 'context', value: 'agent a', tokenCount: 2, agentId });
    await methods.setMemory({
      userId,
      key: 'context',
      value: 'agent b',
      tokenCount: 3,
      agentId: otherAgentId,
    });

    const personal = await methods.getUserMemories({ userId });
    const partitionA = await methods.getUserMemories({ userId, agentId });
    const partitionB = await methods.getUserMemories({ userId, agentId: otherAgentId });

    expect(personal.map((m) => m.value)).toEqual(['personal']);
    expect(partitionA.map((m) => m.value)).toEqual(['agent a']);
    expect(partitionB.map((m) => m.value)).toEqual(['agent b']);
    expect(await MemoryEntry.countDocuments({ userId })).toBe(3);
  });

  it('upserts within a partition instead of duplicating', async () => {
    await methods.setMemory({ userId, key: 'context', value: 'first', tokenCount: 1, agentId });
    await methods.setMemory({ userId, key: 'context', value: 'second', tokenCount: 2, agentId });

    const partitionA = await methods.getUserMemories({ userId, agentId });
    expect(partitionA).toHaveLength(1);
    expect(partitionA[0].value).toBe('second');
  });

  it('treats legacy entries without an agentId field as the personal pool', async () => {
    await MemoryEntry.collection.insertOne({
      userId,
      key: 'legacy',
      value: 'pre-partition entry',
      tokenCount: 4,
      updated_at: new Date(),
    });

    const personal = await methods.getUserMemories({ userId });
    expect(personal.map((m) => m.key)).toEqual(['legacy']);

    await methods.setMemory({ userId, key: 'legacy', value: 'updated', tokenCount: 4 });
    expect(await MemoryEntry.countDocuments({ userId })).toBe(1);
    expect((await methods.getUserMemories({ userId }))[0].value).toBe('updated');
  });

  it('deletes only within the targeted partition', async () => {
    await methods.setMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 });
    await methods.setMemory({ userId, key: 'context', value: 'agent a', tokenCount: 2, agentId });

    const agentDelete = await methods.deleteMemory({ userId, key: 'context', agentId });
    expect(agentDelete.ok).toBe(true);
    expect(await methods.getUserMemories({ userId })).toHaveLength(1);
    expect(await methods.getUserMemories({ userId, agentId })).toHaveLength(0);

    const missingDelete = await methods.deleteMemory({ userId, key: 'context', agentId });
    expect(missingDelete.ok).toBe(false);
  });

  it('updates by opaque id only for the owning user and selected partition', async () => {
    await methods.setMemory({
      userId,
      key: 'private_key',
      value: 'before',
      tokenCount: 1,
      agentId,
    });
    const [stored] = await methods.getUserMemories({ userId, agentId });
    const id = stored._id.toString();

    await expect(
      methods.setMemoryById({
        userId: otherUserId,
        id,
        value: 'wrong owner',
        tokenCount: 2,
        agentId,
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      methods.setMemoryById({
        userId,
        id,
        value: 'wrong partition',
        tokenCount: 2,
        agentId: otherAgentId,
      }),
    ).resolves.toEqual({ ok: false });

    const result = await methods.setMemoryById({
      userId,
      id,
      value: 'after',
      tokenCount: 2,
      agentId,
    });

    expect(result).toMatchObject({
      ok: true,
      memory: { key: 'private_key', value: 'after', tokenCount: 2, agentId },
    });
    expect(await methods.getUserMemories({ userId, agentId })).toHaveLength(1);
  });

  it('renames by opaque id without creating a duplicate record', async () => {
    await methods.setMemory({ userId, key: 'first', value: 'one', agentId });
    await methods.setMemory({ userId, key: 'second', value: 'two', agentId });
    const first = (await methods.getUserMemories({ userId, agentId })).find(
      (memory) => memory.key === 'first',
    );
    expect(first).toBeDefined();

    const conflict = await methods.setMemoryById({
      userId,
      id: first?._id.toString() ?? '',
      key: 'second',
      value: 'updated',
      agentId,
    });
    expect(conflict).toEqual({ ok: false, conflict: true });

    const renamed = await methods.setMemoryById({
      userId,
      id: first?._id.toString() ?? '',
      key: 'renamed',
      value: 'updated',
      agentId,
    });
    expect(renamed).toMatchObject({ ok: true, memory: { key: 'renamed', value: 'updated' } });
    expect(await MemoryEntry.countDocuments({ userId, agentId })).toBe(2);
  });

  it('updates and deletes by opaque id only in the owning tenant', async () => {
    const id = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await methods.setMemory({ userId, key: 'private_key', value: 'stored', agentId });
      const [stored] = await methods.getUserMemories({ userId, agentId });
      return stored._id.toString();
    });

    await expect(
      tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        methods.setMemoryById({ userId, id, value: 'wrong tenant', agentId }),
      ),
    ).resolves.toEqual({ ok: false });
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.getUserMemories({ userId, agentId }),
      ),
    ).resolves.toEqual([expect.objectContaining({ value: 'stored' })]);
    await expect(
      tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        methods.deleteMemoryById({ userId, id, agentId }),
      ),
    ).resolves.toEqual({ ok: false });
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.deleteMemoryById({ userId: otherUserId, id, agentId }),
      ),
    ).resolves.toEqual({ ok: false });
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.deleteMemoryById({ userId, id, agentId: otherAgentId }),
      ),
    ).resolves.toEqual({ ok: false });
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.deleteMemoryById({ userId, id, agentId }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('scopes createMemory duplicate detection to the partition', async () => {
    await methods.createMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 });

    await expect(
      methods.createMemory({ userId, key: 'context', value: 'dupe', tokenCount: 1 }),
    ).rejects.toThrow('already exists');

    const created = await methods.createMemory({
      userId,
      key: 'context',
      value: 'agent a',
      tokenCount: 2,
      agentId,
    });
    expect(created.ok).toBe(true);
  });

  it('formats memories per partition with partition-scoped totals', async () => {
    await methods.setMemory({ userId, key: 'one', value: 'personal one', tokenCount: 5 });
    await methods.setMemory({ userId, key: 'two', value: 'agent two', tokenCount: 7, agentId });

    const personal = await methods.getFormattedMemories({ userId });
    expect(personal.totalTokens).toBe(5);
    expect(personal.tokenCountsByKey).toEqual(new Map([['one', 5]]));
    expect(personal.withoutKeys).toContain('personal one');
    expect(personal.withoutKeys).not.toContain('agent two');

    const partitionA = await methods.getFormattedMemories({ userId, agentId });
    expect(partitionA.totalTokens).toBe(7);
    expect(partitionA.tokenCountsByKey).toEqual(new Map([['two', 7]]));
    expect(partitionA.withKeys).toContain('"key": "two"');
    expect(partitionA.withKeys).not.toContain('personal one');
  });

  it('returns every partition from getAllUserMemories and wipes them all on deleteAllUserMemories', async () => {
    await methods.setMemory({ userId, key: 'one', value: 'personal', tokenCount: 1 });
    await methods.setMemory({ userId, key: 'two', value: 'agent a', tokenCount: 1, agentId });
    await methods.setMemory({ userId: otherUserId, key: 'three', value: 'other', tokenCount: 1 });

    const all = await methods.getAllUserMemories(userId);
    expect(all).toHaveLength(2);

    const deleted = await methods.deleteAllUserMemories(userId);
    expect(deleted).toBe(2);
    expect(await MemoryEntry.countDocuments({ userId: otherUserId })).toBe(1);
  });
});

describe('memory profile partitions', () => {
  const fatherId = 'father';
  const motherId = 'mother';

  it('keeps the same key separate per profile instead of overwriting across people', async () => {
    await methods.setMemory({
      userId,
      key: 'blood_pressure',
      value: 'father: 150/95',
      profileId: fatherId,
    });
    await methods.setMemory({ userId, key: 'blood_pressure', value: 'self: 118/76' });
    await methods.setMemory({
      userId,
      key: 'blood_pressure',
      value: 'mother: 122/80',
      profileId: motherId,
    });

    expect(await MemoryEntry.countDocuments({ userId })).toBe(3);
    const father = await methods.getUserMemories({ userId, profileId: fatherId });
    expect(father).toHaveLength(1);
    expect(father[0].value).toBe('father: 150/95');
  });

  it('never returns one person`s facts when another profile is read', async () => {
    await methods.setMemory({
      userId,
      key: 'diabetes',
      value: 'father has type 2',
      profileId: fatherId,
    });
    await methods.setMemory({ userId, key: 'allergies', value: 'self: none known' });

    const motherRead = await methods.getUserMemories({ userId, profileId: motherId });
    expect(motherRead).toHaveLength(0);

    const fatherRead = await methods.getUserMemories({ userId, profileId: fatherId });
    expect(fatherRead[0].value).toBe('father has type 2');
    expect(fatherRead.some((entry) => entry.key === 'allergies')).toBe(false);
  });

  it('scopes delete to the named profile only', async () => {
    await methods.setMemory({
      userId,
      key: 'medication',
      value: 'father: amlodipine',
      profileId: fatherId,
    });
    await methods.setMemory({ userId, key: 'medication', value: 'self: none' });

    const result = await methods.deleteMemory({ userId, key: 'medication', profileId: fatherId });
    expect(result.ok).toBe(true);

    const remaining = await methods.getUserMemories({ userId });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe('self: none');
  });

  it('reports a duplicate key only within the same profile', async () => {
    await methods.createMemory({
      userId,
      key: 'condition',
      value: 'father: hypertension',
      profileId: fatherId,
    });

    /** The same key is a different fact about a different person, so this must not collide. */
    const second = await methods.createMemory({ userId, key: 'condition', value: 'self: none' });
    expect(second.ok).toBe(true);

    /** A real duplicate in the same partition throws; the REST layer turns that into a 409. */
    await expect(
      methods.createMemory({ userId, key: 'condition', value: 'father: CKD', profileId: fatherId }),
    ).rejects.toThrow('already exists');
  });

  /**
   * The migration guarantee: rows written before profiles existed carry no
   * `profileId`, and must stay visible in the user's own partition while being
   * unreachable from any named profile. A backfill would have to rewrite every
   * existing row to get this; the null-matches-absent filter gets it for free.
   */
  it('treats rows written before profiles existed as the user`s own', async () => {
    await MemoryEntry.create({
      userId,
      key: 'legacy_fact',
      value: 'written before profiles',
      tokenCount: 2,
    });

    const own = await methods.getUserMemories({ userId });
    expect(own).toHaveLength(1);
    expect(own[0].value).toBe('written before profiles');

    const father = await methods.getUserMemories({ userId, profileId: fatherId });
    expect(father).toHaveLength(0);
  });

  it('keeps a legacy row out of a named profile even after that profile is written to', async () => {
    await MemoryEntry.create({ userId, key: 'legacy_fact', value: 'written before profiles' });
    await methods.setMemory({
      userId,
      key: 'father_fact',
      value: 'amlodipine',
      profileId: fatherId,
    });

    const father = await methods.getUserMemories({ userId, profileId: fatherId });
    expect(father).toHaveLength(1);
    expect(father[0].key).toBe('father_fact');

    const own = await methods.getUserMemories({ userId });
    expect(own).toHaveLength(1);
    expect(own[0].key).toBe('legacy_fact');
  });

  it('scopes update-by-id to the profile, so a fact cannot be moved between people', async () => {
    await methods.setMemory({
      userId,
      key: 'note',
      value: 'father: chest pain reported',
      profileId: fatherId,
    });
    const [entry] = await methods.getUserMemories({ userId, profileId: fatherId });

    /** Addressing it as if it were the user's own finds nothing. */
    const wrongPartition = await methods.setMemoryById({
      userId,
      id: String(entry._id),
      value: 'rewritten as self',
    });
    expect(wrongPartition.ok).toBe(false);

    const rightPartition = await methods.setMemoryById({
      userId,
      id: String(entry._id),
      value: 'father: chest pain, resolved',
      profileId: fatherId,
    });
    expect(rightPartition.ok).toBe(true);
  });

  it('counts formatted memories per profile, so the token budget is per person', async () => {
    await methods.setMemory({ userId, key: 'a', value: 'aaaa', tokenCount: 10 });
    await methods.setMemory({
      userId,
      key: 'b',
      value: 'bbbb',
      tokenCount: 5,
      profileId: fatherId,
    });

    const own = await methods.getFormattedMemories({ userId });
    expect(own.totalTokens).toBe(10);
    expect(own.withKeys).toContain('aaaa');
    expect(own.withKeys).not.toContain('bbbb');

    const father = await methods.getFormattedMemories({ userId, profileId: fatherId });
    expect(father.totalTokens).toBe(5);
    expect(father.withKeys).toContain('bbbb');
  });
});
