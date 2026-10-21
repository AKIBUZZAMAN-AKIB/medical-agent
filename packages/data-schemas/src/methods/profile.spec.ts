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
});

describe('deleting a profile', () => {
  it('removes that person`s facts and leaves every other profile intact', async () => {
    await profiles.createProfile({ userId, name: 'Father' });
    await profiles.createProfile({ userId, name: 'Mother' });
    await memories.setMemory({ userId, key: 'diabetes', value: 'self: type 2' });
    await memories.setMemory({ userId, key: 'bp', value: 'father: 150/95', profileId: 'father' });
    await memories.setMemory({ userId, key: 'bp', value: 'mother: 122/80', profileId: 'mother' });

    const result = await profiles.deleteProfile({ userId, profileId: 'father' });

    expect(result.ok).toBe(true);
    expect(result.deletedMemories).toBe(1);
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
