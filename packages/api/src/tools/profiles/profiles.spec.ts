import {
  resolveProfileName,
  prepareProfileTarget,
  createListProfilesTool,
  createReadProfileTool,
  createCreateProfileTool,
  createUpdateProfileTool,
  createDeleteProfileTool,
} from './runtime';
import { registerProfileTools, buildProfileTools } from './index';
import { getProfileToolDefinitions, SELF_PROFILE_ID } from './definitions';

const selfProfile = {
  profileId: undefined,
  name: 'Rahim',
  isSelf: true,
  factCount: 2,
};

const relativeProfile = {
  profileId: 'relative',
  name: 'relative',
  relationship: 'parent',
  isSelf: false,
  factCount: 1,
};

interface MockDeps {
  getUserProfiles: jest.Mock;
  ensureSelfProfile: jest.Mock;
  createProfile: jest.Mock;
  updateProfile: jest.Mock;
  deleteProfile: jest.Mock;
  getFormattedMemories: jest.Mock;
  getUserMemories: jest.Mock;
}

function deps(overrides: Partial<MockDeps> = {}): MockDeps {
  return {
    getUserProfiles: jest.fn().mockResolvedValue([selfProfile, relativeProfile]),
    ensureSelfProfile: jest.fn().mockResolvedValue(selfProfile),
    createProfile: jest.fn().mockResolvedValue({ ok: true, profile: relativeProfile }),
    updateProfile: jest.fn().mockResolvedValue({ ok: true, profile: relativeProfile }),
    deleteProfile: jest.fn().mockResolvedValue({ ok: true, deletedMemories: 2 }),
    getFormattedMemories: jest
      .fn()
      .mockResolvedValue({ withKeys: 'condition: Has asthma', withoutKeys: 'Has asthma' }),
    getUserMemories: jest.fn().mockResolvedValue([{ key: 'condition' }]),
    ...overrides,
  };
}

describe('resolveProfileName', () => {
  it('treats a blank value as the user themselves rather than a nameless record', () => {
    expect(resolveProfileName(undefined).isSelf).toBe(true);
    expect(resolveProfileName('   ').isSelf).toBe(true);
    expect(resolveProfileName(undefined).profileId).toBeUndefined();
  });

  it(`treats the published id \`${SELF_PROFILE_ID}\` as the user themselves`, () => {
    /** Not a synonym list: this is the identifier `list_profiles` prints for
     *  the null partition, so the tool has to accept its own output back. */
    expect(resolveProfileName(SELF_PROFILE_ID).isSelf).toBe(true);
    expect(resolveProfileName('  SELF ').isSelf).toBe(true);
  });

  it('treats the name on the user`s own record as the user themselves', () => {
    /** Data-driven, not vocabulary-driven: whatever the record is called is the
     *  word for "me", so no list of synonyms has to be invented or translated. */
    expect(resolveProfileName('Rahim', 'Rahim').isSelf).toBe(true);
    expect(resolveProfileName('  rAhIm ', 'Rahim').isSelf).toBe(true);
    expect(resolveProfileName('Rahim').isSelf).toBe(false);
  });

  it('resolves any other label to its own partition, keyed from the label', () => {
    expect(resolveProfileName('My Relative', 'Rahim').profileId).toBe('my_relative');
    expect(resolveProfileName('  Amma ', 'Rahim').profileId).toBe('amma');
    expect(resolveProfileName('Amma', 'Rahim').isSelf).toBe(false);
  });

  it('refuses a label that names nobody instead of folding it into the user', () => {
    const target = resolveProfileName('!!!', 'Rahim');
    expect(target.isSelf).toBe(false);
    expect(target.profileId).toBeUndefined();
  });

  it('has no synonym table of its own', () => {
    /** "me" is only the user because the record was named that way — the same
     *  string with a differently named record is a different person. */
    expect(resolveProfileName('Me', 'Rahim').isSelf).toBe(false);
    expect(resolveProfileName('Me', 'Me').isSelf).toBe(true);
  });
});

describe('prepareProfileTarget', () => {
  it('never opens a record for the user themselves', async () => {
    const methods = deps();
    await expect(prepareProfileTarget({ userId: 'user-1', ...methods })).resolves.toEqual({});
    expect(methods.createProfile).not.toHaveBeenCalled();
  });

  it('reports a first write about a person so the model can say so out loud', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    const result = await prepareProfileTarget({
      userId: 'user-1',
      profile: 'Relative',
      ...methods,
    });
    expect(result).toEqual({ profileId: 'relative', created: 'Relative' });
  });

  it('stores the label the user used, not the partition key, as the person name', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    await prepareProfileTarget({ userId: 'user-1', profile: '  My Relative  ', ...methods });
    expect(methods.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My Relative' }),
    );
  });

  it('reuses an existing record and stays silent', async () => {
    const methods = deps();
    const result = await prepareProfileTarget({
      userId: 'user-1',
      profile: 'Relative',
      ...methods,
    });
    expect(result).toEqual({ profileId: 'relative' });
    expect(methods.createProfile).not.toHaveBeenCalled();
  });

  it('keeps the partition when a concurrent write created the row first', async () => {
    const methods = deps({
      createProfile: jest.fn().mockResolvedValue({ ok: false, conflict: true }),
    });
    const result = await prepareProfileTarget({
      userId: 'user-1',
      profile: 'Relative',
      ...methods,
    });
    expect(result).toEqual({ profileId: 'relative' });
  });

  it('writes to the existing record when the person is known by a new name', async () => {
    const renamed = { ...relativeProfile, profileId: 'relative', name: 'Abbu' };
    const methods = deps({
      getUserProfiles: jest.fn().mockResolvedValue([selfProfile, renamed]),
    });
    const result = await prepareProfileTarget({ userId: 'user-1', profile: 'Abbu', ...methods });
    expect(result).toEqual({ profileId: 'relative' });
    expect(methods.createProfile).not.toHaveBeenCalled();
  });

  it('refuses the write when the record could not be opened', async () => {
    const methods = deps({
      getUserProfiles: jest.fn().mockResolvedValue([selfProfile]),
      createProfile: jest.fn().mockResolvedValue({ ok: false }),
    });
    await expect(
      prepareProfileTarget({ userId: 'user-1', profile: 'Relative', ...methods }),
    ).rejects.toThrow();
  });

  it('refuses the write when the label names nobody', async () => {
    const methods = deps();
    await expect(
      prepareProfileTarget({ userId: 'user-1', profile: '###', ...methods }),
    ).rejects.toThrow();
  });
});

describe('profile tool definitions', () => {
  it('covers the whole lifecycle, so a record can be opened, corrected and closed', () => {
    const names = getProfileToolDefinitions().map((definition) => definition.name);
    expect(names).toEqual([
      'list_profiles',
      'read_profile',
      'create_profile',
      'update_profile',
      'delete_profile',
    ]);
  });

  it('describes a person in the user`s own words and never as a category', () => {
    const [list, read, create] = getProfileToolDefinitions();
    expect(list.description).toContain('no facts');
    expect(read.parameters).toMatchObject({ required: ['profile'] });
    const name = (create.parameters as { properties: Record<string, { description: string }> })
      .properties.name.description;
    expect(name).toMatch(/own words/i);
    expect(name).not.toMatch(/relative|kin|spouse|child/i);
  });

  it('says deletion is irreversible and requires the user to have asked', () => {
    const [, , , , remove] = getProfileToolDefinitions();
    expect(remove.description).toMatch(/irreversible/i);
    expect(remove.description).toMatch(/clearly asked/i);
  });
});

describe('registerProfileTools', () => {
  it('registers all five tools when none are present yet', () => {
    const registry = new Map();
    const { registered, toolNames } = registerProfileTools({ toolRegistry: registry });
    expect(registered).toEqual([
      'list_profiles',
      'read_profile',
      'create_profile',
      'update_profile',
      'delete_profile',
    ]);
    expect(toolNames).toHaveLength(5);
  });

  it('is idempotent across two calls', () => {
    const registry = new Map();
    registerProfileTools({ toolRegistry: registry });
    const second = registerProfileTools({ toolRegistry: registry });
    expect(second.registered).toEqual([]);
  });

  it('builds a runtime instance for every definition', () => {
    const built = buildProfileTools({ userId: 'user-1', methods: deps() });
    expect(Object.keys(built).sort()).toEqual([
      'create_profile',
      'delete_profile',
      'list_profiles',
      'read_profile',
      'update_profile',
    ]);
  });
});

describe('createListProfilesTool', () => {
  it('lists names and counts only, and never a fact', async () => {
    const methods = deps({
      getUserProfiles: jest.fn().mockResolvedValue([
        { ...selfProfile, factCount: 3 },
        { ...relativeProfile, factCount: 1 },
      ]),
    });
    const tool = createListProfilesTool({ userId: 'user-1', ...methods });
    const output = await tool.func({});
    expect(output).toContain('self: Rahim (the user themselves) — 3 stored facts');
    expect(output).toContain('relative, parent — 1 stored fact');
    expect(output).not.toContain('Has asthma');
  });

  it('always reports the user themselves, even before anyone else is on file', async () => {
    const tool = createListProfilesTool({
      userId: 'user-1',
      ...deps({ getUserProfiles: jest.fn().mockResolvedValue([]) }),
    });
    const output = await tool.func({});
    expect(output).toContain('self: Rahim (the user themselves)');
    expect(output).not.toContain('relative');
  });
});

describe('createReadProfileTool', () => {
  it('reads only the partition it was asked for', async () => {
    const methods = deps();
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'Relative' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: 'relative',
    });
  });

  it('includes agentId when reading from an agent-scoped memory partition', async () => {
    const methods = deps();
    const built = buildProfileTools({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      methods,
    });
    await built.read_profile.func({ profile: 'Relative' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      profileId: 'relative',
    });
  });

  it('reads the user`s own facts from the null partition', async () => {
    const methods = deps();
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'self' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: undefined,
    });
  });

  it('finds a record by the name it now carries, not only by its key', async () => {
    const renamed = { ...relativeProfile, profileId: 'relative', name: 'Abbu' };
    const methods = deps({
      getUserProfiles: jest.fn().mockResolvedValue([selfProfile, renamed]),
    });
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'Abbu' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: 'relative',
    });
  });

  it('does not read an unnamed partition for a person who has no record', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Nobody' });
    expect(output).toContain('No facts are stored about Nobody yet');
    expect(methods.getFormattedMemories).not.toHaveBeenCalled();
  });

  it('does not describe an empty record as a known history', async () => {
    const methods = deps({ getUserMemories: jest.fn().mockResolvedValue([]) });
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Relative' });
    expect(output).toContain('No facts are stored');
    expect(output).not.toContain('Facts on file');
  });
});

describe('createCreateProfileTool', () => {
  it('opens a record for a person the user named, in their own words', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    const tool = createCreateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ name: '  Amma ', relationship: 'kin' });
    expect(methods.createProfile).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'Amma',
      relationship: 'kin',
    });
    expect(output).toContain('Opened a record for "Amma"');
  });

  it('refuses to open a second record for the user themselves', async () => {
    const methods = deps();
    const tool = createCreateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ name: 'Rahim' });
    expect(methods.createProfile).not.toHaveBeenCalled();
    expect(output).toContain('already has their own record');
  });

  it('never opens a duplicate for a person who already has a record', async () => {
    const methods = deps();
    const tool = createCreateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ name: 'relative' });
    expect(methods.createProfile).not.toHaveBeenCalled();
    expect(output).toContain('already exists');
  });

  it('refuses a label that names nobody', async () => {
    const methods = deps();
    const tool = createCreateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ name: '###' });
    expect(methods.createProfile).not.toHaveBeenCalled();
    expect(output).toContain('does not name anyone');
  });

  it('reports honestly when a lost race means it did not create the record', async () => {
    const methods = deps({
      getUserProfiles: jest
        .fn()
        .mockResolvedValueOnce([selfProfile])
        .mockResolvedValueOnce([selfProfile, relativeProfile]),
      createProfile: jest.fn().mockResolvedValue({ ok: false, conflict: true }),
    });
    const tool = createCreateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ name: 'relative' });
    expect(output).toContain('at the same moment');
  });
});

describe('createUpdateProfileTool', () => {
  it('corrects a label without touching the stored facts', async () => {
    const methods = deps();
    const tool = createUpdateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Relative', name: 'Abbu' });
    expect(methods.updateProfile).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: 'relative',
      name: 'Abbu',
    });
    expect(output).toContain('did not move');
  });

  it('addresses the user`s own record by isSelf, because it has no key', async () => {
    const methods = deps();
    const tool = createUpdateProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'self', name: 'Rahim Chowdhury' });
    expect(methods.updateProfile).toHaveBeenCalledWith({
      userId: 'user-1',
      isSelf: true,
      name: 'Rahim Chowdhury',
    });
    expect(methods.updateProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileId: undefined }),
    );
  });

  it('asks for at least one field rather than reporting a silent success', async () => {
    const methods = deps();
    const tool = createUpdateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Relative' });
    expect(methods.updateProfile).not.toHaveBeenCalled();
    expect(output).toContain('Nothing to change');
  });

  it('does not invent a record for a person who has none', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    const tool = createUpdateProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Nobody', name: 'Someone' });
    expect(methods.updateProfile).not.toHaveBeenCalled();
    expect(output).toContain('No facts are stored about Nobody');
  });
});

describe('createDeleteProfileTool', () => {
  it('removes a person`s record and reports how much went with it', async () => {
    const methods = deps();
    const tool = createDeleteProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Relative' });
    expect(methods.deleteProfile).toHaveBeenCalledWith({ userId: 'user-1', profileId: 'relative' });
    expect(output).toContain('2 stored facts');
    expect(output).toContain('cannot be undone');
  });

  it('refuses to remove the user`s own record', async () => {
    const methods = deps();
    const tool = createDeleteProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'self' });
    expect(methods.deleteProfile).not.toHaveBeenCalled();
    expect(output).toContain('cannot be removed');
  });

  it('does nothing when there is no such record', async () => {
    const methods = deps({ getUserProfiles: jest.fn().mockResolvedValue([selfProfile]) });
    const tool = createDeleteProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Nobody' });
    expect(methods.deleteProfile).not.toHaveBeenCalled();
    expect(output).toContain('nothing was removed');
  });

  it('does not claim success when the data layer refused', async () => {
    const methods = deps({ deleteProfile: jest.fn().mockResolvedValue({ ok: false }) });
    const tool = createDeleteProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'Relative' });
    expect(output).toContain('Could not remove');
  });
});
