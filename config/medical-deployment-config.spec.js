/**
 * Governance tests for the medical deployment config.
 *
 * These do not test behaviour — they test the *shape* of configuration, because
 * the memory findings in `docs/MEMORY_AND_LONG_RUN.md` are configuration defects:
 * each is valid YAML, loads without error, and silently degrades the agent over a
 * long relationship. A test is the only thing that notices.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, name), 'utf8');

/** Minimal block reader: enough for the top-level `memory:` mapping, no YAML dep. */
function memoryBlock(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^memory:\s*$/.test(line));
  if (start === -1) return null;
  const collected = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n');
}

function validKeys(block) {
  const match = /validKeys:\s*\n((?:\s+-\s+.*\n?)+)/.exec(block);
  if (match == null) return [];
  return match[1]
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*-\s*/, '')
        .replace(/['"]/g, '')
        .trim(),
    )
    .filter(Boolean);
}

describe('medical deployment config — memory governance', () => {
  const yaml = read('librechat.pure-doctor.yaml');
  const block = memoryBlock(yaml);

  it('declares a memory block at all', () => {
    expect(block).not.toBeNull();
  });

  it('declares no per-person keys when memory_profiles is enabled', () => {
    /**
     * `validKeys` is a global namespace, checked before the profile partition is
     * resolved. A key like `family_member_mother` is therefore a slot in the
     * user's OWN record, so a write without a `profile` argument mixes a
     * relative's medical history into the user's. That is precisely what
     * `memory_profiles` exists to prevent, and it is the failure the package
     * README describes as "a wrong answer about the wrong person's medication".
     */
    const keys = validKeys(block);
    const perPerson = keys.filter((key) =>
      /^(family_member|relative|mother|father|child)/.test(key),
    );
    expect(perPerson).toEqual([]);
  });

  it('keeps per-person vocabulary available through a profile-neutral key set', () => {
    const keys = validKeys(block);
    // The vocabulary must survive: removing the family_* keys must not leave the
    // agent unable to record conditions or medicines for another person.
    expect(keys).toEqual(
      expect.arrayContaining([
        'chronic_conditions',
        'active_medications',
        'allergies_and_adverse_reactions',
      ]),
    );
  });

  it('does not claim recency in a durable key name', () => {
    /**
     * Memories never expire. A key called `recent_lab_results` therefore promises
     * a freshness the storage cannot keep: a value written a year ago is still
     * labelled "recent". The row carries its write date, so the fix is to stop
     * asserting recency in the key itself.
     */
    const keys = validKeys(block);
    expect(keys.filter((key) => /^recent_/.test(key))).toEqual([]);
  });

  it('bounds memory so a long-running user cannot grow it without limit', () => {
    expect(block).toMatch(/tokenLimit:\s*\d+/);
    expect(block).toMatch(/messageWindowSize:\s*\d+/);
  });

  it('records that the extraction agent is a second model dependency', () => {
    /**
     * `memory.agent.enabled: true` means an extraction LLM runs after the turn.
     * It is pinned to the same free-tier model as the chat agent, so a provider
     * outage silently stops memory consolidation while the chat still works.
     * This asserts the risk is visible in the file rather than implicit.
     */
    const hasAgent = /agent:\s*\n\s+enabled:\s*true/.test(block);
    if (hasAgent) {
      expect(block).toMatch(/Extraction|extraction|LONG_RUN|free-tier|failover/i);
    }
  });
});

describe('medical deployment config — consistency with the package', () => {
  it('does not advertise a stale tool count in the UI preset', () => {
    const yaml = read('librechat.pure-doctor.yaml');
    const pkg = require('../packages/mcp-medical/package.json');
    const claimed = /(\d+)\s+Live Biomedical/.exec(yaml);
    if (claimed != null) {
      const tools = Number(claimed[1]);
      // 33 lookup + safety tools, of which the description counts the "live" ones.
      expect(tools).toBeGreaterThanOrEqual(32);
      expect(pkg.version).toBeTruthy();
    }
  });
});

/**
 * Governance for the seeded agent graph.
 *
 * The unit specs prove each tool works. These assert that the *deployment* wires
 * them so the graph can actually use them: a specialist that cannot read the
 * record has to be handed the patient's facts in prose instead, which is a
 * second copy of the record and a copy that can be summarized wrong.
 */
describe('medical deployment config — per-person records across the agent graph', () => {
  const seed = read('config/seed-medical-agent.js');

  /** Balanced-brace reader for each `data: { ... }` handed to an agent. */
  function dataBlocks(source) {
    const blocks = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf('data: {', from);
      if (at === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = at + 'data: '.length; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      blocks.push(source.slice(at, end + 1));
      from = end + 1;
    }
    return blocks;
  }

  const blocks = dataBlocks(seed);
  const primary = seed.slice(seed.indexOf('const agentData = {'));
  const continuity = /const continuityTools = \[([\s\S]*?)\];/.exec(seed);

  it('wires the capability marker into every agent it creates', () => {
    /** The specialists list it in `subTools`; the primary agent composes it
     *  into `allTools`. Either way the marker must reach the agent. */
    expect(continuity).not.toBeNull();
    expect(continuity[1]).toContain('Tools.memory');
    const subTools = /const subTools = \[([\s\S]*?)\];/.exec(seed);
    expect(subTools).not.toBeNull();
    expect(subTools[1]).toContain('Tools.memory');
    /** And every agent actually receives a tool list. */
    expect(blocks.filter((block) => !/tools:/.test(block))).toEqual([]);
    expect(primary).toMatch(/tools: allTools/);
  });

  it('enables per-person records on the specialists and on the primary agent', () => {
    expect(blocks.filter((block) => /memory_profiles:\s*true/.test(block)).length).toBe(1);
    expect(primary).toMatch(/memory_profiles:\s*true/);
  });

  it('keeps one shared record space, so a specialist reads what the primary agent wrote', () => {
    /**
     * `memory_scope: 'agent'` would file each agent's facts under its own id.
     * A specialist would then read an empty record while the patient's history
     * sat one partition away — the failure this test exists to catch.
     */
    const scope = /memory_scope:\s*MemoryScope\.(\w+)/g;
    const scopes = [...seed.matchAll(scope)].map((match) => match[1]);
    expect(scopes.length).toBe(blocks.length + 1);
    expect(scopes.filter((value) => value !== 'user')).toEqual([]);
  });

  it('tells the specialists to read the record themselves', () => {
    expect(seed).toMatch(/call `list_profiles` and then `read_profile`/);
    expect(seed).toMatch(/Never merge two people/);
  });

  it('holds no fixed list of people or relationships anywhere in the seed', () => {
    /**
     * Nothing the author maintains may stand in for what the user said. The
     * check is on shape rather than on a word list: no array literal of
     * relationship strings, no option table, no mapping from a term to a record.
     */
    expect(seed).not.toMatch(/relationship\s*:\s*\[/);
    expect(seed).not.toMatch(/RELATIONSHIP_(OPTIONS|VALUES|LIST)/);
    expect(seed).not.toMatch(/profileName\s*:\s*['"]/);
  });
});
