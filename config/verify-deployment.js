#!/usr/bin/env node
/**
 * Deployment preflight for the medical-agent fork.
 *
 * Every check here corresponds to a way this stack has actually failed during
 * deployment testing. Nothing is guessed: each item exercises the real file,
 * process or socket that production will use.
 *
 *   node config/verify-deployment.js              # full preflight
 *   node config/verify-deployment.js --offline    # skip LLM + Mongo network checks
 *   node config/verify-deployment.js --json       # machine-readable
 *
 * Exit code 0 = no FAIL. 1 = at least one FAIL. WARN never fails the run but is
 * always printed, because each one is a known degraded state.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const asJson = argv.includes('--json');

const results = [];
const record = (level, id, message, detail) => {
  results.push({ level, id, message, detail });
};

/** Same contract as librechat-data-provider's `extractEnvVariable`: resolve
 * ${VAR} placeholders against process.env the way LibreChat does at load time. */
const extractEnvVariable = (value) =>
  String(value ?? '').replace(/\$\{([^}]+)\}/g, (_match, name) => {
    const key = String(name).trim();
    return process.env[key] ?? process.env[key.toUpperCase()] ?? _match;
  });

const pass = (id, message, detail) => record('PASS', id, message, detail);
const warn = (id, message, detail) => record('WARN', id, message, detail);
const fail = (id, message, detail) => record('FAIL', id, message, detail);

/* ------------------------------------------------------------------ node ---
 * The build chain (tsdown / data-provider) requires a modern Node. Older Node
 * fails with "Failed to import module 'unrun'", which reads like a missing
 * dependency and sends people installing packages that do not help.
 */
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24) {
    pass('node', `Node ${process.versions.node}`);
  } else if (major >= 20) {
    warn(
      'node',
      `Node ${process.versions.node} can run the API but may not build packages/mcp-medical`,
      'Build with Node >= 24; runtime only needs >= 20.',
    );
  } else {
    fail(
      'node',
      `Node ${process.versions.node} is too old`,
      'Use Node >= 20 to run, >= 24 to build.',
    );
  }
}

/* ---------------------------------------------------------------- config --- */
function resolveConfigPath() {
  const fromEnv = process.env.CONFIG_PATH;
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(repoRoot, fromEnv);
  }
  for (const name of ['librechat.yaml', 'librechat.yml']) {
    const candidate = path.join(repoRoot, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(repoRoot, 'librechat.pure-doctor.yaml');
}

function checkConfig() {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    fail(
      'config.file',
      `Config file not found at ${configPath}`,
      'Set CONFIG_PATH or create the file.',
    );
    return null;
  }
  if (fs.statSync(configPath).isDirectory()) {
    fail(
      'config.file',
      `${configPath} is a directory, not a file`,
      'Docker creates an empty directory when a bind-mounted source path does not exist. ' +
        'Mount a file that really exists (deploy-compose.yml mounts librechat.pure-doctor.yaml).',
    );
    return null;
  }

  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    warn('config.parse', 'js-yaml is not installed; skipping YAML validation');
    return null;
  }

  let config;
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail('config.parse', `Cannot parse ${path.basename(configPath)}`, String(error.message));
    return null;
  }
  pass('config.parse', `Parsed ${path.basename(configPath)}`);

  /* version pin ----------------------------------------------------------- */
  let expectedVersion = null;
  for (const rel of [
    'packages/data-provider/dist/index.cjs',
    'packages/data-provider/dist/index.js',
  ]) {
    const dist = path.join(repoRoot, rel);
    if (!fs.existsSync(dist)) {
      continue;
    }
    try {
      const mod = require(dist);
      expectedVersion = mod.Constants?.CONFIG_VERSION ?? null;
      if (expectedVersion) {
        break;
      }
    } catch {
      /* fall through to the source grep below */
    }
  }
  if (!expectedVersion) {
    const source = path.join(repoRoot, 'packages/data-provider/src/config.ts');
    if (fs.existsSync(source)) {
      const match = fs.readFileSync(source, 'utf8').match(/CONFIG_VERSION\s*=\s*'([^']+)'/);
      expectedVersion = match?.[1] ?? null;
    }
  }
  if (expectedVersion == null) {
    warn('config.version', 'Cannot determine the expected config version');
  } else if (config.version === expectedVersion) {
    pass('config.version', `Config version ${config.version} matches the code`);
  } else {
    fail(
      'config.version',
      `Config version ${config.version} does not match the code (${expectedVersion})`,
      'librechat.pure-doctor.yaml `version:` must equal Constants.CONFIG_VERSION, ' +
        'otherwise validation runs against the wrong schema.',
    );
  }

  /* MCP server ------------------------------------------------------------ */
  const server = config.mcpServers?.medical;
  if (!server) {
    fail(
      'mcp.config',
      'No mcpServers.medical entry',
      'The medical tools are unreachable without it.',
    );
    return config;
  }
  if (server.type !== 'stdio') {
    warn('mcp.config', `mcpServers.medical type is "${server.type}", expected "stdio"`);
  }

  const arg = (server.args ?? []).find(
    (entry) => typeof entry === 'string' && entry.includes('mcp-medical'),
  );
  if (!arg) {
    fail('mcp.args', 'mcpServers.medical has no mcp-medical script argument');
  } else {
    const resolved = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    if (!fs.existsSync(resolved)) {
      fail(
        'mcp.args',
        `MCP entry point does not resolve: ${resolved}`,
        path.isAbsolute(arg)
          ? 'Rebuild packages/mcp-medical (npm run build:mcp-medical).'
          : `A relative arg is resolved against the process working directory (currently ${process.cwd()}). ` +
              'Start the API from the repository root (npm run backend, or working_dir: /app in Compose).',
      );
    } else {
      pass(
        'mcp.args',
        `MCP entry point resolves: ${path.relative(repoRoot, resolved) || resolved}`,
      );
    }
  }

  if (server.serverInstructions !== true && typeof server.serverInstructions !== 'string') {
    warn(
      'mcp.instructions',
      'serverInstructions is not enabled',
      "The MCP server's own safety preamble (emergency screen first) is never injected into the model context. " +
        'Set `serverInstructions: true`.',
    );
  } else {
    pass('mcp.instructions', 'Server instructions are injected into the model context');
  }

  const groups = server.env?.MEDICAL_TOOL_GROUPS;
  if (typeof groups === 'string' && groups.length > 0) {
    pass('mcp.groups', `Tool groups restricted to: ${groups}`, 'emergency is always kept.');
  }

  /* endpoints ------------------------------------------------------------- */
  const custom = config.endpoints?.custom ?? [];
  if (custom.length === 0) {
    fail('endpoints.custom', 'No custom endpoint configured', 'No chat model is reachable.');
  }
  for (const endpoint of custom) {
    const raw = extractEnvVariable(endpoint.baseURL ?? '');
    const isLocal = /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(raw);
    const unresolved = raw.includes('${');
    if (unresolved) {
      warn(
        'endpoints.custom',
        `${endpoint.name}: baseURL is an unresolved \${VAR}`,
        'LibreChat substitutes these at load time; make sure MEDICAL_LLM_BASE_URL / MEDICAL_LLM_API_KEY are set ' +
          'in the environment of the API process.',
      );
    } else if (isLocal) {
      const inContainer = fs.existsSync('/.dockerenv');
      (inContainer ? fail : warn)(
        'endpoints.custom',
        `${endpoint.name}: baseURL points at loopback (${raw})`,
        inContainer
          ? 'Inside a container 127.0.0.1 is the container itself. Use host.docker.internal (Compose sets MEDICAL_LLM_BASE_URL).'
          : 'Fine on the host; a container deployment must override MEDICAL_LLM_BASE_URL.',
      );
    } else {
      pass('endpoints.custom', `${endpoint.name}: ${raw}`);
    }
  }

  /* memory / agents ------------------------------------------------------- */
  if (config.memory?.disabled === false && config.memory?.agent?.provider == null) {
    pass('memory', 'Memory enabled with the server-side memory agent');
  }
  return config;
}

/* ------------------------------------------------------- mcp-medical pkg --- */
async function checkMedicalPackage() {
  const pkgRoot = path.join(repoRoot, 'packages/mcp-medical');
  const distTools = path.join(pkgRoot, 'dist/tools/index.js');
  if (!fs.existsSync(distTools)) {
    fail('mcp.build', 'packages/mcp-medical/dist is missing', 'Run npm run build:mcp-medical.');
    return;
  }
  try {
    const { allTools } = await import(path.join(pkgRoot, 'dist/tools/index.js'));
    const names = new Set((allTools ?? []).map((tool) => tool.name));
    if (names.size < 25) {
      warn(
        'mcp.build',
        `Only ${names.size} tools exported (expected 33)`,
        'The catalogue looks truncated by the build.',
      );
    } else {
      pass('mcp.tools', `${names.size} MCP tools exported`);
    }
    for (const required of ['emergency_triage_check', 'bd_medicine_lookup']) {
      if (!names.has(required)) {
        fail('mcp.tools', `Required tool ${required} is not exported`);
      }
    }
  } catch (error) {
    fail(
      'mcp.build',
      'Cannot import packages/mcp-medical/dist/tools/index.js',
      String(error.message),
    );
    return;
  }

  const corpus = path.join(pkgRoot, 'data/bddrugbank-compact.json.gz');
  if (!fs.existsSync(corpus)) {
    fail(
      'mcp.corpus',
      'BDDrugBank corpus is missing from packages/mcp-medical/data',
      'bd_medicine_lookup loads <pkg>/data/bddrugbank-compact.json.gz at call time; the tool throws without it. ' +
        'Dockerfile.multi must COPY the data/ directory into the api image.',
    );
  } else {
    const kb = Math.round(fs.statSync(corpus).size / 1024);
    pass('mcp.corpus', `BDDrugBank corpus present (${kb} KB)`);
  }

  const agentFile = path.join(pkgRoot, 'agent/agent.json');
  try {
    const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    if (agent.model?.provider && agent.model?.id) {
      pass(
        'agent.definition',
        `${agent.name ?? agent.id} → ${agent.model.provider} / ${agent.model.id}`,
      );
    } else {
      warn('agent.definition', 'agent.json has no provider/model pair');
    }
  } catch (error) {
    fail(
      'agent.definition',
      'Cannot read packages/mcp-medical/agent/agent.json',
      String(error.message),
    );
  }
}

/* --------------------------------------------------------------- secrets --- */
function checkSecrets() {
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'];
  const missing = required.filter((name) => {
    const value = process.env[name];
    return value == null || value.trim() === '';
  });
  if (missing.length === 0) {
    pass('secrets', 'JWT and CREDS secrets are set in the environment');
    return;
  }
  const tempFile = process.env.LIBRECHAT_TEMP_CREDENTIALS_PATH;
  if (tempFile && fs.existsSync(tempFile)) {
    warn(
      'secrets',
      `Not in the environment: ${missing.join(', ')}`,
      `Loaded from ${tempFile}. Temporary credentials are regenerated on every deploy, which invalidates ` +
        'sessions and stored API keys. Set them in .env for a real deployment.',
    );
    return;
  }
  warn(
    'secrets',
    `Not in the environment: ${missing.join(', ')}`,
    'LibreChat will generate temporary credentials at boot. Fine for a smoke test, not for a deployment: ' +
      'sessions and encrypted keys survive only until the next restart.',
  );
}

/* ----------------------------------------------------------------- mongo --- */
async function checkMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    warn(
      'mongo',
      'MONGO_URI is not set',
      'Cannot verify persistence, seeding or the created users.',
    );
    return;
  }
  let MongoClient;
  try {
    ({ MongoClient } = require('mongodb'));
  } catch {
    warn('mongo', 'mongodb driver not installed; skipping database checks');
    return;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    const db = client.db();
    await db.command({ ping: 1 });
    pass('mongo', `Connected to ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
    const agents = db.collection('agents');
    const seeded = await agents.findOne({ id: 'agent_medical_research' });
    if (seeded) {
      const subs = await agents
        .find({ id: { $regex: '^agent_sub_' } }, { projection: { id: 1 } })
        .toArray();
      pass('mongo.seed', `Doctor agent present (${subs.length} specialist sub-agents)`);
      if (subs.length < 7) {
        warn('mongo.seed', `Only ${subs.length}/7 sub-agents found`, 'Re-run the seed command.');
      }
    } else {
      warn(
        'mongo.seed',
        'The doctor agent is not in the database',
        'Run `npm run seed-medical-agent` (host) or `docker compose -f deploy-compose.yml run --rm seed` (Docker). ' +
          'Until then the app has no agent to chat with.',
      );
    }
    const userCount = await db.collection('users').countDocuments();
    if (userCount === 0) {
      warn(
        'mongo.users',
        'No users exist yet',
        'Register the first account, or create one with config/create-user.js.',
      );
    } else {
      pass('mongo.users', `${userCount} user(s) registered`);
    }
  } catch (error) {
    fail(
      'mongo',
      'Cannot reach MongoDB',
      `${String(error.message)} (MONGO_URI=${uri.replace(/\/\/[^@]*@/, '//***@')})`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------- llm --- */
async function checkLlmEndpoint(config) {
  const endpoint = (config?.endpoints?.custom ?? [])[0];
  if (!endpoint) {
    return;
  }
  const base = extractEnvVariable(endpoint.baseURL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base) || base.includes('${')) {
    warn('llm', 'Chat endpoint cannot be probed (baseURL still unresolved)', `baseURL=${base}`);
    return;
  }
  const url = `${base}/models`;
  const apiKey = extractEnvVariable(endpoint.apiKey ?? '');
  const sendKey = apiKey.length > 0 && !apiKey.includes('${');
  try {
    const response = await fetch(url, {
      headers: sendKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      warn(
        'llm',
        `Chat endpoint answered ${response.status} at ${url}`,
        'Chat requests will fail until this endpoint serves /models.',
      );
      return;
    }
    const body = await response.json().catch(() => null);
    const models = (body?.data ?? []).map((entry) => entry.id);
    pass('llm', `Chat endpoint reachable (${models.length} model(s) advertised)`);
    const configured = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(repoRoot, 'packages/mcp-medical/agent/agent.json'), 'utf8'),
        ).model?.id;
      } catch {
        return undefined;
      }
    })();
    if (configured && models.length > 0 && !models.includes(configured)) {
      warn(
        'llm.model',
        `agent.json asks for "${configured}" which the endpoint does not advertise`,
        'Free model rosters rotate. Update agent.json (and re-run the seed) or serve this model id.',
      );
    }
  } catch (error) {
    fail(
      'llm',
      `Chat endpoint unreachable at ${url}`,
      `${String(error.message)} — the app starts but cannot answer.`,
    );
  }
}

/* -------------------------------------------------------------- workspace --- */
function checkWritableDirs() {
  const dirs = [
    ['uploads', path.join(repoRoot, 'uploads')],
    ['client/public/images', path.join(repoRoot, 'client/public/images')],
    ['api/logs', process.env.LIBRECHAT_LOG_DIR ?? path.join(repoRoot, 'api/logs')],
  ];
  for (const [label, dir] of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      pass('fs', `${label} is writable`);
    } catch (error) {
      fail('fs', `${label} is not writable`, String(error.message));
    }
  }
}

function checkGitState() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (out.trim() === '') {
      pass('git', 'Working tree is clean');
    } else {
      warn(
        'git',
        'Working tree has uncommitted changes',
        out.trim().split('\n').slice(0, 5).join(' | '),
      );
    }
  } catch {
    warn('git', 'Not a git checkout; cannot report the deployed revision');
  }
}

(async () => {
  checkNode();
  const config = checkConfig() ?? undefined;
  await checkMedicalPackage();
  checkSecrets();
  checkWritableDirs();
  checkGitState();
  if (!offline) {
    await checkMongo();
    await checkLlmEndpoint(config);
  }

  const order = { FAIL: 0, WARN: 1, PASS: 2 };
  results.sort((a, b) => order[a.level] - order[b.level]);

  const counts = results.reduce(
    (acc, item) => ({ ...acc, [item.level]: (acc[item.level] ?? 0) + 1 }),
    {},
  );
  if (asJson) {
    console.log(JSON.stringify({ counts, results }, null, 2));
  } else {
    const marker = { PASS: '  ok', WARN: 'warn', FAIL: '  !!' };
    for (const item of results) {
      console.log(`${marker[item.level]}  ${item.message}`);
      if (item.detail) {
        console.log(`        ${item.detail}`);
      }
    }
    console.log(
      `\n${counts.PASS ?? 0} passed, ${counts.WARN ?? 0} warning(s), ${counts.FAIL ?? 0} failure(s)` +
        (offline ? '  [offline: LLM + Mongo checks skipped]' : ''),
    );
  }
  process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
})().catch((error) => {
  console.error('preflight crashed:', error);
  process.exit(1);
});
