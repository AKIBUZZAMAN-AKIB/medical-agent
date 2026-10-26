import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IProfile } from '~/types';
import { createProfileMethods } from './profile';
import { createMemoryMethods } from './memory';
import { toProfileId } from '~/schema/profile';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Profile: mongoose.Model<IProfile>;
let profiles: ReturnType<typeof createProfileMethods>;
let memories: ReturnType<typeof createMemoryMethods>;

const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  Profile = mongoose.models.Profile as mongoose.Model<IProfile>;
  memories = createMemoryMethods(mongoose);
  profiles = createProfileMethods(mongoose, {
    deleteMemoriesByProfile: memories.deleteMemoriesByProfile,
  });
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Profile.deleteMany({});
  await mongoose.models.MemoryEntry.deleteMany({});
});

describe('toProfileId', () => {
  it('slugifies a human label into a storage-safe id', () => {
    expect(toProfileId('Father')).toBe('father');
    expect(toProfileId('My Father')).toBe('my_father');
    expect(toProfileId('  Amma  ')).toBe('amma');
    expect(toProfileId('Patient #2')).toBe('patient_2');
  });

  it('returns empty for a label with nothing usable in it', () => {
    expect(toProfileId('   ')).toBe('');
    expect(toProfileId('###')).toBe('');
  });

  it('keeps every letter and digit of a label, whatever script it is written in', () => {
    /**
     * The regression this guards: an ASCII-only slug turned any label in another
     * script into the empty string, and the memory layer reads the empty string
     * as "no partition", i.e. the account holder. Two different people therefore
     * shared one record with no error. Labels are generated from code point
     * ranges, not listed, because the property is about Unicode, not vocabulary.
     */
    const ranges: Array<[number, number]> = [
      [0x0985, 0x09b9],
      [0x0905, 0x0939],
      [0x0627, 0x064a],
      [0x4e00, 0x4e20],
      [0x0410, 0x044f],
      [0x0e01, 0x0e2e],
    ];
    const labels: string[] = [];
    let seed = 123456789;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed / 0x80000000;
    };
    for (let i = 0; i < 200; i += 1) {
      const [low, high] = ranges[Math.floor(next() * ranges.length)];
      const length = 2 + Math.floor(next() * 5);
      let label = '';
      for (let c = 0; c < length; c += 1) {
        label += String.fromCodePoint(low + Math.floor(next() * (high - low + 1)));
      }
      labels.push(label);
    }
    /** Every generated label is non-empty and contains letters by construction. */
    expect(labels.filter((label) => toProfileId(label) === '')).toEqual([]);
    expect(new Set(labels.map((label) => toProfileId(label))).size).toBe(labels.length);
    expect(labels.every((label) => toProfileId(toProfileId(label)) === toProfileId(label))).toBe(
      true,
    );
  });
});

describe('self profile', () => {
  it('has no profileId, so its memories land in the null partition', async () => {
    const self = await profiles.ensureSelfProfile(userId, 'Rahim');
    expect(self.profileId).toBeUndefined();
    expect(self.isSelf).toBe(true);
  });

  it('is idempotent, so two calls do not create two people', async () => {
    const first = await profiles.ensureSelfProfile(userId, 'Rahim');
    const second = await profiles.ensureSelfProfile(userId, 'Rahim');
    expect(String(first._id)).toBe(String(second._id));
    expect(await Profile.countDocuments({ userId })).toBe(1);
  });

  it('refuses deletion, because there is nowhere to move the user`s own facts to', async () => {
    await memories.setMemory({ userId, key: 'diabetes', value: 'self: type 2' });
    const self = await profiles.ensureSelfProfile(userId, 'Rahim');
    /** The self profile has no profileId, so it is addressed by its slug. */
    const result = await profiles.deleteProfile({ userId, profileId: 'rahim' });

    expect(result.ok).toBe(false);
    expect(await memories.getUserMemories({ userId })).toHaveLength(1);
    expect(self.isSelf).toBe(true);
  });
});

describe('profile registry', () => {
  it('creates a named subject and refuses a duplicate label', async () => {
    const created = await profiles.createProfile({
      userId,
      name: 'Father',
      relationship: 'parent',
    });
    expect(created.ok).toBe(true);
    expect(created.profile?.profileId).toBe('father');
    expect(created.profile?.relationship).toBe('parent');

    const duplicate = await profiles.createProfile({ userId, name: 'father' });
    expect(duplicate).toEqual({ ok: false, conflict: true });
  });

  it('rejects a label that slugs to nothing', async () => {
    const result = await profiles.createProfile({ userId, name: '###' });
    expect(result.ok).toBe(false);
  });

  it('gives two people with non-Latin names separate records and separate facts', async () => {
    /**
     * Storage-level proof of isolation: each person's facts must come back from
     * their own partition and from nowhere else, and nothing may land in the
     * account holder's own record as a fallback.
     */
    const first = await profiles.createProfile({ userId, name: '\u0986\u09ac\u09cd\u09ac\u09c1' });
    const second = await profiles.createProfile({ userId, name: '\u09ae\u09be' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstId = first.profile?.profileId as string;
    const secondId = second.profile?.profileId as string;
    expect(firstId).not.toBe('');
    expect(firstId).not.toBe(secondId);
    /** The record remembers the person the way they were written. */
    expect(first.profile?.name).toBe('\u0986\u09ac\u09cd\u09ac\u09c1');

    await memories.setMemory({
      userId,
      key: 'condition',
      value: 'first',
      tokenCount: 1,
      profileId: firstId,
    });
    await memories.setMemory({
      userId,
      key: 'condition',
      value: 'second',
      tokenCount: 1,
      profileId: secondId,
    });

    const mine = await memories.getUserMemories({ userId, profileId: firstId });
    const theirs = await memories.getUserMemories({ userId, profileId: secondId });
    const self = await memories.getUserMemories({ userId });
    expect(mine.map((entry) => entry.value)).toEqual(['first']);
    expect(theirs.map((entry) => entry.value)).toEqual(['second']);
    expect(self).toHaveLength(0);
  });

  it('never returns another user`s profiles', async () => {
    await profiles.createProfile({ userId, name: 'Father' });
    await profiles.createProfile({ userId: otherUserId, name: 'Father' });

    const mine = await profiles.getUserProfiles(userId);
    expect(mine).toHaveLength(1);
    expect(String(mine[0].userId)).toBe(String(userId));
  });

  it('renames without changing the partition the facts are stored under', async () => {
    const created = await profiles.createProfile({ userId, name: 'Father' });
    expect(created.ok).toBe(true);
    await memories.setMemory({ userId, key: 'bp', value: '150/95', profileId: 'father' });

    const renamed = await profiles.updateProfile({
      userId,
      profileId: 'father',
      name: 'Abbu',
      relationship: 'father',
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.profile?.name).toBe('Abbu');
    /** The id is the identity of the storage partition, so a rename must not move facts. */
    expect(renamed.profile?.profileId).toBe('father');
    expect(await memories.getUserMemories({ userId, profileId: 'father' })).toHaveLength(1);
  });

  it('cannot be told to edit "some record" by leaving the key out', async () => {
    /**
     * An absent `profileId` must not degrade into "whichever record matches
     * first". Mongoose drops an undefined condition from a filter, so without
     * the exact-subject guard this call would have edited a person the caller
     * never named — and deleting on the same filter would have erased them.
     */
    await profiles.createProfile({ userId, name: 'Father' });
    const before = await profiles.getUserProfiles(userId);
    const refused = await profiles.updateProfile({
      userId,
      name: 'Renamed',
    } as Parameters<typeof profiles.updateProfile>[0]);
    expect(refused.ok).toBe(false);
    const after = await profiles.getUserProfiles(userId);
    expect(after.map((entry) => entry.name)).toEqual(before.map((entry) => entry.name));
  });

  it("renames the user's own record through `isSelf`, since it has no key", async () => {
    const self = await profiles.ensureSelfProfile(userId);
    const result = await profiles.updateProfile({ userId, isSelf: true, name: 'Danny' });
    expect(result.ok).toBe(true);
    expect(result.profile?.name).toBe('Danny');
    expect(result.profile?.isSelf).toBe(true);
    expect(result.profile?.profileId).toBeUndefined();
    expect(result.profile?._id).toEqual(self._id);
  });

  it('deletes nothing when asked for an empty key', async () => {
    await profiles.createProfile({ userId, name: 'Father' });
    await memories.setMemory({
      userId,
      key: 'condition',
      value: 'x',
      tokenCount: 1,
      profileId: 'father',
    });
    const refused = await profiles.deleteProfile({ userId, profileId: '' });
    expect(refused.ok).toBe(false);
    expect(
      (await profiles.getUserProfiles(userId)).find((entry) => entry.profileId === 'father'),
    ).toBeDefined();
    expect(await memories.getUserMemories({ userId, profileId: 'father' })).toHaveLength(1);
  });

  it('reports not-found for a profile the user does not have', async () => {
    const result = await profiles.updateProfile({ userId, profileId: 'mother', name: 'Maa' });
    expect(result.ok).toBe(false);
  });
});

describe('profile listing with counts', () => {
  it('counts facts and tokens per person, and lists the user first', async () => {
    await profiles.ensureSelfProfile(userId, 'Rahim');
    await profiles.createProfile({ userId, name: 'Father' });
    await profiles.createProfile({ userId, name: 'Mother' });

    await memories.setMemory({ userId, key: 'diabetes', value: 'self: type 2', tokenCount: 10 });
    await memories.setMemory({
      userId,
      key: 'bp',
      value: 'father: 150/95',
      tokenCount: 7,
      profileId: 'father',
    });
    await memories.setMemory({
      userId,
      key: 'thyroid',
      value: 'mother: hypo',
      tokenCount: 3,
      profileId: 'mother',
    });

    const list = await profiles.getUserProfiles(userId);
    expect(list).toHaveLength(3);
    expect(list[0].isSelf).toBe(true);
    expect(list[0]).toMatchObject({ factCount: 1, tokenCount: 10 });

    const father = list.find((profile) => profile.profileId === 'father');
    expect(father).toMatchObject({ factCount: 1, tokenCount: 7 });
    /** The count is what lets the UI say what a deletion will remove. */
    const mother = list.find((profile) => profile.profileId === 'mother');
    expect(mother).toMatchObject({ factCount: 1, tokenCount: 3 });
  });

  it('scopes fact and token counts to an agent partition when requested', async () => {
    await profiles.ensureSelfProfile(userId, 'Rahim');
    await profiles.createProfile({ userId, name: 'Father' });

    await memories.setMemory({
      userId,
      key: 'shared_pref',
      value: 'Prefers metric units',
      tokenCount: 5,
    });
    await memories.setMemory({
      userId,
      agentId: 'agent_medical_research',
      key: 'allergy',
      value: 'Penicillin rash',
      tokenCount: 8,
    });
    await memories.setMemory({
      userId,
      agentId: 'agent_medical_research',
      profileId: 'father',
      key: 'bp',
      value: '2026-10-01 Hypertension on amlodipine',
      tokenCount: 12,
    });

    const allPartitions = await profiles.getUserProfiles(userId);
    expect(allPartitions.find((p) => p.isSelf)).toMatchObject({ factCount: 2, tokenCount: 13 });
    expect(allPartitions.find((p) => p.profileId === 'father')).toMatchObject({
      factCount: 1,
      tokenCount: 12,
    });

    const medicalOnly = await profiles.getUserProfiles(userId, {
      agentId: 'agent_medical_research',
    });
    expect(medicalOnly.find((p) => p.isSelf)).toMatchObject({ factCount: 1, tokenCount: 8 });
    expect(medicalOnly.find((p) => p.profileId === 'father')).toMatchObject({
      factCount: 1,
      tokenCount: 12,
    });

    const sharedOnly = await profiles.getUserProfiles(userId, { agentId: undefined });
    expect(sharedOnly.find((p) => p.isSelf)).toMatchObject({ factCount: 1, tokenCount: 5 });
    expect(sharedOnly.find((p) => p.profileId === 'father')).toMatchObject({
      factCount: 0,
      tokenCount: 0,
    });
  });
});

describe('deleting a profile', () => {
  it('removes that person`s facts across all agent partitions and leaves every other profile intact', async () => {
    await profiles.createProfile({ userId, name: 'Father' });
    await profiles.createProfile({ userId, name: 'Mother' });
    await memories.setMemory({ userId, key: 'diabetes', value: 'self: type 2' });
    await memories.setMemory({ userId, key: 'bp', value: 'father: 150/95', profileId: 'father' });
    await memories.setMemory({
      userId,
      agentId: 'agent_medical_research',
      key: 'anticoagulant',
      value: '2026-10-01 Taking apixaban 5 mg twice daily',
      profileId: 'father',
    });
    await memories.setMemory({ userId, key: 'bp', value: 'mother: 122/80', profileId: 'mother' });

    const result = await profiles.deleteProfile({ userId, profileId: 'father' });

    expect(result.ok).toBe(true);
    expect(result.deletedMemories).toBe(2);
    expect(
      await memories.getUserMemories({
        userId,
        agentId: 'agent_medical_research',
        profileId: 'father',
      }),
    ).toHaveLength(0);
    expect(await memories.getUserMemories({ userId })).toHaveLength(1);
    expect(await memories.getUserMemories({ userId, profileId: 'mother' })).toHaveLength(1);
    expect(await Profile.countDocuments({ userId })).toBe(1);
  });

  it('reports not-found for a profile that is not there', async () => {
    const result = await profiles.deleteProfile({ userId, profileId: 'nobody' });
    expect(result.ok).toBe(false);
  });

  it('refuses to touch another user`s profile even with the same slug', async () => {
    await profiles.createProfile({ userId: otherUserId, name: 'Father' });
    const result = await profiles.deleteProfile({ userId, profileId: 'father' });
    expect(result.ok).toBe(false);
    expect(await Profile.countDocuments({ userId: otherUserId })).toBe(1);
  });
});
