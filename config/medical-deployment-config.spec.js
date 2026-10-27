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

/**
 * Governance for the specialist board.
 *
 * The unit specs cannot see this: a specialist is assembled by string
 * concatenation at seed time, and a name that does not exist is simply not
 * added. The agent then runs, answers, and quietly lacks a capability nobody
 * declared as optional. These tests read the package's own tool definitions, so
 * a rename in `packages/mcp-medical` breaks the seed here rather than in
 * production.
 */
describe('medical deployment config — specialist sub-agent tool wiring', () => {
  const seed = read('config/seed-medical-agent.js');
  const toolDir = path.join(repoRoot, 'packages/mcp-medical/src/tools');

  /** Every tool name the package actually defines. */
  const published = new Set(
    fs
      .readdirSync(toolDir)
      .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
      .flatMap((file) => [
        ...fs
          .readFileSync(path.join(toolDir, file), 'utf8')
          .matchAll(/^\s+name: '([a-z0-9_]+)',/gm),
      ])
      .map((match) => match[1]),
  );

  /** `id` -> declared tool names, for every specialist in the seed.
   *  Comments are stripped first: the declarations carry load-bearing rationale,
   *  and a parser that reads them as tool names would fail on its own prose. */
  const declarativeSeed = seed.replace(/\/\*[\s\S]*?\*\//g, '');
  const specialists = [
    ...declarativeSeed.matchAll(
      /id: '([^']+)',[\s\S]*?toolNames: \[([\s\S]*?)\][\s\S]*?focusPrompt/g,
    ),
  ].map((match) => ({
    id: match[1],
    tools: match[2]
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
    block: match[0],
  }));

  it('reads a plausible tool catalogue and specialist board', () => {
    expect(published.size).toBeGreaterThan(20);
    expect(specialists.length).toBeGreaterThanOrEqual(5);
  });

  it('declares no specialist tool the package does not publish', () => {
    const missing = specialists.flatMap((spec) =>
      spec.tools.filter((tool) => !published.has(tool)).map((tool) => `${spec.id}: ${tool}`),
    );
    expect(missing).toEqual([]);
  });

  it('gives the emergency specialist the deterministic screen', () => {
    /**
     * The regression: the specialist dedicated to red-flag triage was the one
     * agent that could not call the screen built for exactly that job. It
     * reports `unknown` today, which is a refusal to clear — an agent that
     * cannot ask is an agent that has to assume.
     */
    const emergency = specialists.find((spec) => spec.id.includes('emergency'));
    expect(emergency).toBeDefined();
    expect(emergency.tools).toContain('emergency_triage_check');
  });

  it('gives every specialist the tools its own focus prompt promises', () => {
    /** A prompt that promises a check the toolset cannot perform is an
     *  instruction to improvise. Matched on the capability words the prompts
     *  actually use, each against the tool that performs it. */
    const promises = [
      { word: /device.{0,12}recall|recall.{0,12}device/i, tool: 'device_approval' },
      { word: /LactMed|breastfeeding|breast-feeding/i, tool: 'drug_lactation' },
      { word: /pharmacogenom|CPIC/i, tool: 'pharmacogenomics_guideline' },
    ];
    const broken = specialists.flatMap((spec) =>
      promises
        .filter((promise) => promise.word.test(spec.block) && !spec.tools.includes(promise.tool))
        .map(
          (promise) => `${spec.id} promises ${promise.word.source} but cannot call ${promise.tool}`,
        ),
    );
    expect(broken).toEqual([]);
  });

  it('refuses to seed a specialist whose declared tool is missing', () => {
    /** The seed must fail loudly rather than filter the capability away. */
    expect(seed).toMatch(/const unpublished = subSpec\.toolNames\.filter/);
    expect(seed).toMatch(/Refusing to seed a specialist that would run with missing capabilities/);
  });
});

/**
 * Deployment wiring that has failed in practice.
 *
 * Every assertion below corresponds to a defect reproduced during the deploy
 * audit: each one is valid, silent, and leaves the app running with fewer
 * capabilities than the operator believes it has. Configuration is the only
 * layer where they can be caught — nothing throws at runtime.
 */
describe('medical deployment config — deployment wiring', () => {
  const yaml = read('librechat.pure-doctor.yaml');
  const compose = read('deploy-compose.yml');
  const multiDockerfile = read('Dockerfile.multi');
  const dockerignore = read('.dockerignore');
  const serverBlock = (() => {
    const start = yaml.indexOf('mcpServers:');
    return start === -1 ? '' : yaml.slice(start, yaml.indexOf('\nendpoints:', start));
  })();

  it('pins the config version the code validates against', () => {
    /**
     * `loadCustomConfig` validates against `Constants.CONFIG_VERSION`. A mismatch
     * logs "Outdated Config version" and validates the file against a schema the
     * running code does not use.
     */
    const declared = /^version:\s*'?([\d.]+)'?\s*$/m.exec(yaml);
    expect(declared).not.toBeNull();
    // Read from source, not dist: this spec must run on a checkout where the
    // workspace packages have not been built yet.
    const source = read('packages/data-provider/src/config.ts');
    const expected = /CONFIG_VERSION\s*=\s*'([\d.]+)'/.exec(source);
    expect(expected).not.toBeNull();
    expect(declared[1]).toBe(expected[1]);
  });

  it('injects the MCP server instructions into the model context', () => {
    /**
     * Without `serverInstructions`, `resolveServerInstructions()` returns
     * undefined and the safety preamble never reaches the model — the log reads
     * `Server Instructions: N/A` while everything else looks healthy.
     */
    expect(serverBlock).toMatch(/^\s+serverInstructions:\s*true\s*$/m);
  });

  it('uses a repo-relative MCP entry path that the documented start command satisfies', () => {
    /**
     * The path is resolved against the process working directory, so it must be
     * the plain repo-relative path *and* the API must be started from the repo
     * root (package.json `backend`, compose `working_dir`). An absolute path
     * would only ever work on one machine.
     */
    expect(serverBlock).toMatch(/^\s+-\s+packages\/mcp-medical\/dist\/index\.js\s*$/m);
    const { scripts } = require('../package.json');
    expect(scripts.backend).toMatch(/node api\/server\/index\.js$/);
  });

  it('builds the API from this repository instead of upstream images', () => {
    /** The published image has no mcp-medical package, no corpus, no seed script. */
    expect(compose).toMatch(/dockerfile:\s*Dockerfile\.multi/);
    expect(compose).toMatch(/target:\s*api-build/);
    expect(compose).not.toMatch(
      /image:\s*registry\.librechat\.ai\/[^\n]*\n\s+container_name:\s*LibreChat-API/,
    );
  });

  it('starts the API from the repository root inside the container', () => {
    /** /app/api makes every repo-relative path (MCP entry, BD corpus, logs) wrong. */
    expect(compose).toMatch(/working_dir:\s*\/app\b/);
    expect(multiDockerfile).toMatch(/^WORKDIR \/app$/m);
    expect(multiDockerfile).toMatch(/CMD \["node", "api\/server\/index\.js"\]/);
  });

  it('mounts the config file that exists in this repository', () => {
    /**
     * A bind mount whose source is missing makes Docker create an empty directory,
     * the YAML load fails, and the app runs with no custom config at all.
     */
    expect(compose).toMatch(/source:\s*\.\/librechat\.pure-doctor\.yaml/);
    expect(compose).not.toMatch(
      /source:\s*\.\/librechat\.ya?ml\b(?!)|source:\s*\.\/librechat\.yaml/,
    );
    expect(fs.existsSync(path.join(repoRoot, 'librechat.pure-doctor.yaml'))).toBe(true);
  });

  it('ships the BDDrugBank corpus in the production image', () => {
    /** bd_medicine_lookup loads <pkg>/data at call time; without it the tool throws. */
    expect(multiDockerfile).toMatch(
      /COPY --from=mcp-medical-build \/app\/packages\/mcp-medical\/data/,
    );
    expect(
      fs.existsSync(path.join(repoRoot, 'packages/mcp-medical/data/bddrugbank-compact.json.gz')),
    ).toBe(true);
  });

  it('keeps the fork config in the docker build context', () => {
    /** Upstream `.dockerignore` drops `librechat*`; the image bakes this one file. */
    expect(dockerignore).toMatch(/^!librechat\.pure-doctor\.yaml$/m);
  });

  it('asserts a single scheduling replica for the single-container stack', () => {
    /** Without it the scheduler never arms and every schedule write is a 503. */
    expect(compose).toMatch(/SCHEDULES_SINGLE_PROCESS/);
    expect(read('.env.example')).toMatch(/^SCHEDULES_SINGLE_PROCESS=true$/m);
  });

  it('resolves the chat endpoint from the environment, not from loopback', () => {
    /**
     * Inside a container 127.0.0.1 is the container; the endpoint must be
     * configurable per deployment, and the compose file supplies a container-safe
     * default.
     */
    expect(yaml).toMatch(/baseURL:\s*'\$\{MEDICAL_LLM_BASE_URL\}'/);
    expect(compose).toMatch(/MEDICAL_LLM_BASE_URL/);
    expect(read('.env.example')).toMatch(/^MEDICAL_LLM_BASE_URL=/m);
  });
});
