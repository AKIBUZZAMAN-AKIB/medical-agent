const fs = require('fs');
const path = require('path');

const sdkPaths = [
  __dirname,
  path.resolve(__dirname, '..', 'packages', 'mcp-medical'),
  path.resolve(__dirname, '..', 'api'),
];
const { Client } = require(
  require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: sdkPaths }),
);
const { StdioClientTransport } = require(
  require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: sdkPaths }),
);
const {
  AccessRoleIds,
  Constants,
  MemoryPolicy,
  MemoryScope,
  PrincipalType,
  ResourceType,
  Tools,
} = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

const AGENT_DIR = path.resolve(__dirname, '..', 'packages', 'mcp-medical', 'agent');
const SERVER_ENTRY = path.resolve(__dirname, '..', 'packages', 'mcp-medical', 'dist', 'index.js');

/**
 * Reads the tool list from the MCP server itself rather than from a copy kept
 * in this script. Agent tool ids are namespaced by server name, so a stale list
 * here would silently create an agent whose tools never resolve — and starting
 * the server first proves it boots before anything is written to the database.
 */
async function listServerTools(serverName) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `The medical MCP server is not built: ${SERVER_ENTRY} is missing.\n` +
        'Build it first:  npm run build --workspace @librechat/mcp-medical',
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'seed-medical-agent', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => `${tool.name}${Constants.mcp_delimiter}${serverName}`);
  } finally {
    await client.close();
  }
}

function parseArgs(argv) {
  const options = {
    author: undefined,
    shareWithRole: undefined,
    dryRun: false,
    instructionsFile: path.join('packages', 'mcp-medical', 'agent', 'instructions.md'),
  };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--author=')) {
      options.author = arg.slice('--author='.length);
    } else if (arg.startsWith('--share-with-role=')) {
      options.shareWithRole = arg.slice('--share-with-role='.length);
    } else if (arg.startsWith('--instructions=')) {
      options.instructionsFile = arg.slice('--instructions='.length);
    } else if (!arg.startsWith('--')) {
      options.author = arg;
    }
  }
  return options;
}

async function resolveAuthor(User, identifier) {
  if (identifier != null && identifier.length > 0) {
    const query = identifier.includes('@')
      ? { email: identifier.toLowerCase() }
      : { username: identifier };
    const user = await User.findOne(query).lean();
    if (user == null) {
      throw new Error(`No user matches "${identifier}". Pass an email, a username, or omit it.`);
    }
    return user;
  }
  const admin = await User.findOne({ role: 'ADMIN' }).sort({ createdAt: 1 }).lean();
  if (admin == null) {
    throw new Error(
      'No ADMIN user exists yet, so the agent would have no owner. Create one first.',
    );
  }
  return admin;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const definition = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'agent.json'), 'utf8'));
  const instructions = fs.readFileSync(
    path.resolve(process.cwd(), options.instructionsFile),
    'utf8',
  );
  const serverName = definition.mcpServer;

  const tools = await listServerTools(serverName);
  if (tools.length === 0) {
    throw new Error(
      'The medical MCP server published no tools; refusing to create an empty agent.',
    );
  }

  /**
   * Continuity is part of the product, not an extra: a clinician who cannot see
   * last week's conversation re-asks questions the patient already answered.
   * These are LibreChat built-ins rather than MCP tools, because a stdio MCP
   * server is never told which user called it — see the note in
   * `packages/api/src/tools/history/runtime.ts`. Both are gated on the
   * deployment: `memory` needs a `memory:` block in librechat.yaml, and
   * `conversation_history` needs that opt-in capability. Asking for them here
   * means an agent that cannot have them is visibly incomplete rather than
   * quietly amnesiac.
   */
  const continuityTools = [Tools.memory, Tools.conversation_history, Tools.conversation_transcript];

  const log = (message) => console.log(`[seed-medical-agent] ${message}`);
  log(`${tools.length} medical tool(s) discovered from MCP server "${serverName}"`);
  log(
    `agent "${definition.id}" -> provider "${definition.model.provider}", model "${definition.model.id}"`,
  );

  const allTools = [...tools, ...continuityTools];
  if (options.dryRun) {
    log(`dry run, nothing written. Tools: ${allTools.join(', ')}`);
    process.exit(0);
  }

  require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
  const connect = require('./connect');
  const { grantPermission } = require('~/server/services/PermissionService');
  const { Agent } = require('~/db/models');

  await connect();
  const mongoose = require('mongoose');
  const { createModels } = require('@librechat/data-schemas');
  const { User } = createModels(mongoose);

  const author = await resolveAuthor(User, options.author);

  const agentData = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    instructions,
    provider: definition.model.provider,
    model: definition.model.id,
    model_parameters: definition.modelParameters,
    author: author._id,
    authorName: author.name,
    tools: allTools,
    mcpServerNames: [serverName],
    recursion_limit: definition.recursion_limit,
    category: definition.category,
    conversation_starters: definition.conversationStarters ?? [],
    /**
     * Isolate this agent's memories from the shared personal pool, so what a
     * user's medical agent remembers is not handed to every other agent they
     * use, and vice versa.
     */
    memory_scope: MemoryScope.agent,
    /**
     * Let the agent record durable clinical facts on its own judgement instead
     * of waiting to be told "remember that". Continuity is the point of this
     * agent; the default explicit-request guard would make a patient restate
     * their history in every session, and a restated history is a worse record
     * than a stored one. The guard it receives in place of the default still
     * refuses identifiers and transient detail.
     */
    memory_policy: MemoryPolicy.proactive,
    /**
     * One record per person. A patient is routinely talking about a parent, a
     * child or a spouse in the same breath as themselves, and a pooled
     * history silently merges them — which in this domain is a wrong-medication
     * answer, not a wrong preference. The agent is given only the list of who
     * is on file and reads the person the question is about; the fact that a
     * relative is mentioned is not consent to store anything about them, and
     * the agent asks once before it writes.
     */
    memory_profiles: true,
  };

  const existing = await Agent.findOne({ id: definition.id }).select('_id').lean();
  const agent =
    existing != null
      ? await Agent.findOneAndUpdate({ id: definition.id }, agentData, { new: true })
      : await Agent.create(agentData);

  const grants = [
    {
      resourceType: ResourceType.AGENT,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      principalType: PrincipalType.USER,
      principalId: author._id,
    },
    {
      resourceType: ResourceType.REMOTE_AGENT,
      accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      principalType: PrincipalType.USER,
      principalId: author._id,
    },
  ];
  if (options.shareWithRole != null) {
    /** Role principals are identified by role identifier, not by ObjectId. */
    grants.push({
      resourceType: ResourceType.AGENT,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      principalType: PrincipalType.ROLE,
      principalId: options.shareWithRole,
    });
  }

  for (const grant of grants) {
    await grantPermission({ ...grant, resourceId: agent._id, grantedBy: author._id });
  }

  logger.info('[seed-medical-agent] agent ready', {
    id: agent.id,
    name: agent.name,
    toolCount: allTools.length,
    author: author.email ?? author.username,
    sharedWithRole: options.shareWithRole ?? null,
  });
  log(`agent "${agent.name}" (${agent.id}) is ready with ${allTools.length} tool(s)`);
  if (options.shareWithRole == null) {
    log('it is visible only to its owner; re-run with --share-with-role=USER to share it');
  }
  log(
    'continuity tools requested: memory (needs a `memory:` block in librechat.yaml), ' +
      'conversation_history + conversation_transcript (need the `conversation_history` capability)',
  );

  await mongoose.disconnect();
  /**
   * The data-schemas and MCP imports leave handles behind, so a script that has
   * finished its work can still sit there indefinitely. This is a one-shot CLI;
   * exit once the last statement is done rather than waiting on an empty queue.
   */
  process.exit(0);
}

main().catch((error) => {
  console.error(`[seed-medical-agent] failed: ${error.message}`);
  process.exit(1);
});
