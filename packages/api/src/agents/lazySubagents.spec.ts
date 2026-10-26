import { SkillsScope } from 'librechat-data-provider';
import {
  LAZY_SUBAGENT_CONFIG_FIELDS,
  getLazySubagentConfigId,
  selectLazySubagentConfig,
} from './lazySubagents';

const agent = {
  id: 'child-agent',
  name: 'Child',
  description: 'Delegated work',
  provider: 'openAI',
  model: 'gpt-5',
  model_parameters: {
    temperature: 0,
    maxContextTokens: 128000,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  version: 4,
};

describe('getLazySubagentConfigId', () => {
  it('changes when initializer-relevant config changes', () => {
    const original = getLazySubagentConfigId(agent);
    const changed = getLazySubagentConfigId({
      ...agent,
      instructions: 'Use concise answers.',
    });

    expect(changed).not.toBe(original);
  });

  it('changes when model-advertised identity changes', () => {
    expect(getLazySubagentConfigId({ ...agent, name: 'Renamed child' })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the Git author identity changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'First Agent', email: 'first@example.com' },
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'Second Agent', email: 'second@example.com' },
      }),
    );
  });

  it('is stable across key order and excludes secret values', () => {
    const first = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { retry: 2, access_token: 'first-secret' },
    });
    const second = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { access_token: 'second-secret', retry: 2 },
    });

    expect(second).toBe(first);
  });

  it('includes token-budget settings in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 1024 } })).not.toBe(
      getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 2048 } }),
    );
  });

  it('includes the persisted version in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, version: 5 })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the persisted skill catalog scope changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.none,
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      }),
    );
  });
});

/**
 * The fingerprint's job is drift detection between the moment a descriptor is
 * built and the moment it is initialised (`initialize.js:1246`). Anything that
 * can change what the initializer produces must therefore change the id. These
 * tests are generated from the field list itself, so a field that is listed but
 * ignored — or ignored and not listed, which the compile-time exhaustiveness
 * assertion catches — fails here rather than in production.
 */
describe('descriptor identity covers every field that can drift', () => {
  /** A distinct, obviously-different value per field, derived from the form the
   *  field is declared with rather than from a table of samples. */
  const sample = (field: string): unknown => {
    if (field === 'version') return 99;
    if (field === 'model_parameters') return { temperature: 0.9 };
    if (['tools', 'agent_ids', 'actions', 'mcpServerNames'].includes(field)) return [`${field}-x`];
    if (field === 'subagents') return { enabled: false, agent_ids: [] };
    if (field === 'git_identity') return { name: 'Someone Else', email: 'else@example.com' };
    if (field === 'tool_resources') return { file_search: { file_ids: ['f1'] } };
    if (field === 'memory_scope') return 'agent';
    if (field === 'memory_policy') return 'proactive';
    if (field === 'memory_profiles') return true;
    if (field === 'skills_enabled') return true;
    if (field === 'skills_scope') return SkillsScope.all;
    if (field === 'artifacts') return true;
    if (field === 'hide_sequential_outputs') return true;
    if (field === 'end_after_tools') return true;
    if (field === 'stateful_code_sessions') return true;
    return `${field}-value`;
  };

  it('changes the id when any single listed field changes, one at a time', () => {
    const base = getLazySubagentConfigId(agent);
    const unchanged = LAZY_SUBAGENT_CONFIG_FIELDS.filter((field) => {
      /** `id` is already part of the id string, so it cannot fail to change it. */
      const mutated = { ...agent, [field]: sample(field) };
      return getLazySubagentConfigId(mutated) === base;
    });
    expect(unchanged).toEqual([]);
  });

  it('fingerprints the memory fields that decide what the initializer produces', () => {
    /** The regression this file exists for: `memory_scope` was covered while the
     *  policy and the profile flag — both of which change the tool schema and the
     *  guard text appended to instructions — were not. */
    for (const field of ['memory_scope', 'memory_policy', 'memory_profiles']) {
      expect(LAZY_SUBAGENT_CONFIG_FIELDS).toContain(field);
      expect(getLazySubagentConfigId({ ...agent, [field]: sample(field) })).not.toBe(
        getLazySubagentConfigId(agent),
      );
    }
  });

  it('fingerprints the repository-instruction mode, which rewrites instructions', () => {
    expect(getLazySubagentConfigId({ ...agent, repositoryInstructions: 'defer' })).not.toBe(
      getLazySubagentConfigId({ ...agent, repositoryInstructions: 'prefer' }),
    );
  });

  it('has no duplicated fields, so the hash cannot depend on list order', () => {
    expect(new Set(LAZY_SUBAGENT_CONFIG_FIELDS).size).toBe(LAZY_SUBAGENT_CONFIG_FIELDS.length);
  });

  it('selects every listed field and nothing else', () => {
    const selected = selectLazySubagentConfig({
      ...agent,
      author: 'someone',
      tenantId: 'tenant-1',
      access_level: 2,
    } as Parameters<typeof selectLazySubagentConfig>[0]);
    expect(Object.keys(selected).sort()).toEqual([...LAZY_SUBAGENT_CONFIG_FIELDS].sort());
    /** Editor-owned books and ACL-only display fields are not drift inputs. */
    expect(selected).not.toHaveProperty('author');
    expect(selected).not.toHaveProperty('tenantId');
    expect(selected).not.toHaveProperty('access_level');
  });
});
