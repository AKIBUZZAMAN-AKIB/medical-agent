import {
  SELF_PROFILE_ALIASES,
  resolveProfileName,
  prepareProfileTarget,
  createListProfilesTool,
  createReadProfileTool,
} from './runtime';
import { registerProfileTools, buildProfileTools } from './index';
import { getProfileToolDefinitions } from './definitions';

const selfProfile = {
  profileId: undefined,
  name: 'Danny',
  isSelf: true,
  factCount: 2,
};

const fatherProfile = {
  profileId: 'father',
  name: 'father',
  relationship: 'parent',
  isSelf: false,
  factCount: 1,
};

interface MockDeps {
  getUserProfiles: jest.Mock;
  ensureSelfProfile: jest.Mock;
  createProfile: jest.Mock;
  getFormattedMemories: jest.Mock;
  getUserMemories: jest.Mock;
}

function deps(overrides: Partial<MockDeps> = {}): MockDeps {
  return {
    getUserProfiles: jest.fn().mockResolvedValue([selfProfile, fatherProfile]),
    ensureSelfProfile: jest.fn().mockResolvedValue(selfProfile),
    createProfile: jest.fn().mockResolvedValue({ ok: true, profile: fatherProfile }),
    getFormattedMemories: jest
      .fn()
      .mockResolvedValue({ withKeys: 'condition: Has asthma', withoutKeys: 'Has asthma' }),
    getUserMemories: jest.fn().mockResolvedValue([{ key: 'condition' }]),
    ...overrides,
  };
}

describe('resolveProfileName', () => {
  it('maps every self alias to the null partition', () => {
    for (const alias of SELF_PROFILE_ALIASES) {
      expect(resolveProfileName(alias).isSelf).toBe(true);
      expect(resolveProfileName(alias).profileId).toBeUndefined();
    }
  });

  it('slugifies a named person so the same name always finds the same record', () => {
    expect(resolveProfileName('My Father').profileId).toBe('my_father');
    expect(resolveProfileName('  Amma ').profileId).toBe('amma');
  });

  it('treats an empty value as the user themselves rather than a nameless record', () => {
    expect(resolveProfileName(undefined).isSelf).toBe(true);
    expect(resolveProfileName('   ').isSelf).toBe(true);
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
    const result = await prepareProfileTarget({ userId: 'user-1', profile: 'Father', ...methods });
    expect(result).toEqual({ profileId: 'father', created: 'father' });
  });

  it('reuses an existing record and stays silent', async () => {
    const methods = deps();
    const result = await prepareProfileTarget({ userId: 'user-1', profile: 'father', ...methods });
    expect(result).toEqual({ profileId: 'father' });
    expect(methods.createProfile).not.toHaveBeenCalled();
  });

  it('keeps the partition when a concurrent write created the row first', async () => {
    const methods = deps({
      createProfile: jest.fn().mockResolvedValue({ ok: false, error: 'duplicate' }),
    });
    const result = await prepareProfileTarget({ userId: 'user-1', profile: 'father', ...methods });
    expect(result).toEqual({ profileId: 'father' });
  });
});

describe('profile tool definitions', () => {
  it('lists names and counts only, and reads one person at a time', () => {
    const [list, read] = getProfileToolDefinitions();
    expect(list.name).toBe('list_profiles');
    expect(list.description).toContain('no facts');
    expect(read.name).toBe('read_profile');
    expect(read.parameters?.required).toEqual(['profile']);
  });
});

describe('registerProfileTools', () => {
  it('adds the pair once and leaves an already-supplied definition alone', () => {
    const registry = new Map();
    const first = registerProfileTools({
      toolRegistry: registry as never,
      toolDefinitions: [],
    });
    expect(first.registered).toEqual(['list_profiles', 'read_profile']);
    expect(registry.has('read_profile')).toBe(true);

    /** Re-running initialization must not duplicate definitions the model sees. */
    const second = registerProfileTools({
      toolRegistry: registry as never,
      toolDefinitions: first.toolDefinitions,
    });
    expect(second.registered).toEqual([]);
    expect(second.toolDefinitions).toHaveLength(2);
  });
});

describe('buildProfileTools', () => {
  it('binds the runtime pair to the authenticated user', () => {
    const built = buildProfileTools({ userId: 'user-1', methods: deps() });
    expect(Object.keys(built).sort()).toEqual(['list_profiles', 'read_profile']);
  });
});

describe('createListProfilesTool', () => {
  it('reports who is on file with a fact count for each, preserving self factCount and agentId scope', async () => {
    const methods = deps({
      /** Real `ensureSelfProfile` returns the raw Profile lean doc without `factCount`. */
      ensureSelfProfile: jest.fn().mockResolvedValue({ name: 'Danny', isSelf: true }),
      getUserProfiles: jest.fn().mockResolvedValue([
        { name: 'Danny', isSelf: true, factCount: 3, tokenCount: 24 },
        {
          profileId: 'father',
          name: 'father',
          relationship: 'parent',
          factCount: 1,
          tokenCount: 9,
        },
      ]),
    });
    const tool = createListProfilesTool({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      ...methods,
    });
    const output = await tool.func({});
    expect(methods.getUserProfiles).toHaveBeenCalledWith('user-1', {
      agentId: 'agent_medical_research',
    });
    expect(output).toContain('self: Danny (the user themselves) — 3 stored facts');
    expect(output).toContain('father, parent — 1 stored fact');
    expect(output).not.toContain('Has asthma');
  });

  it('always reports the user themselves, even before anyone else is on file', async () => {
    const tool = createListProfilesTool({
      userId: 'user-1',
      ...deps({ getUserProfiles: jest.fn().mockResolvedValue([]) }),
    });
    const output = await tool.func({});
    expect(output).toContain('self: Danny (the user themselves)');
    expect(output).not.toContain('father');
  });
});

describe('createReadProfileTool', () => {
  it('reads only the partition it was asked for', async () => {
    const methods = deps();
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'father' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: 'father',
    });
  });

  it('includes agentId when reading from an agent-scoped memory partition', async () => {
    const methods = deps();
    const built = buildProfileTools({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      methods,
    });
    await built.read_profile.func({ profile: 'father' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      profileId: 'father',
    });
    expect(methods.getUserMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent_medical_research',
      profileId: 'father',
    });
  });

  it("reads the user's own facts from the null partition", async () => {
    const methods = deps();
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    await tool.func({ profile: 'self' });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      profileId: undefined,
    });
  });

  it('does not describe an empty record as a known history', async () => {
    const methods = deps({ getUserMemories: jest.fn().mockResolvedValue([]) });
    const tool = createReadProfileTool({ userId: 'user-1', ...methods });
    const output = await tool.func({ profile: 'father' });
    expect(output).toContain('No facts are stored about father yet');
    expect(output).toContain('do not describe an empty record as a known history');
  });
});
