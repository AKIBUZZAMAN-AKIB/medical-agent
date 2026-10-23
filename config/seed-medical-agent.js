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

const SPECIALIST_SUBAGENT_SPECS = [
  {
    id: 'agent_sub_emergency_triage',
    name: 'Emergency & Red-Flag Triage Sub-Agent',
    description:
      'Screens symptoms for immediate life-threatening red flags (airway/choking, stroke, ACS, sepsis, GI bleed, anaphylaxis, crisis) and checks urgent safety recalls.',
    toolNames: [
      'safety_recalls',
      'drug_adverse_event_summary',
      'condition_lookup',
      'plain_language_summary',
    ],
    focusPrompt:
      'Focus strictly on life-threatening red flags, time-critical escalation windows, bystander rescue steps, and urgent device/drug recalls.',
  },
  {
    id: 'agent_sub_pharmacology_ddi',
    name: 'Clinical Pharmacology, DDI & Brand Mapper Sub-Agent',
    description:
      'Resolves local/Bangladeshi & international brand medicines to generic active ingredients and verifies FDA/DailyMed labels, boxed warnings, renal/hepatic dosing, and drug-drug interactions.',
    toolNames: [
      'drug_lookup',
      'drug_label',
      'drug_interaction_check',
      'drug_safety_actions',
      'drug_adverse_event_summary',
      'drug_class_atc',
      'drug_bioactivity',
      'compound_properties',
    ],
    focusPrompt:
      'Resolve every brand name to active generic ingredients first, verify current FDA/DailyMed label sections and boxed warnings, and report all clinically significant drug-drug or disease-drug interactions.',
  },
  {
    id: 'agent_sub_cardio_nephro_endo',
    name: 'Cardiology, Nephrology & Endocrinology Sub-Agent',
    description:
      'Evaluates cardiovascular, CKD/eGFR renal dosing, hypertension, heart failure GDMT, diabetes trials, and ICD-10-CM classifications.',
    toolNames: [
      'drug_label',
      'drug_interaction_check',
      'pubmed_search',
      'pubmed_article',
      'clinical_trials',
      'icd10cm_code',
      'condition_lookup',
    ],
    focusPrompt:
      'Focus on organ-function thresholds (eGFR/CrCl, LVEF, HbA1c, INR), label renal/hepatic adjustments, landmark cardiovascular/renal outcome trials, and accurate ICD-10-CM coding.',
  },
  {
    id: 'agent_sub_maternal_peds',
    name: 'Maternal-Fetal, Lactation & Pediatric Safety Sub-Agent',
    description:
      'Retrieves NLM LactMed breastfeeding records, current FDA PLLR pregnancy narratives (never retired A/B/C/D/X letters), and pediatric safety warnings.',
    toolNames: [
      'drug_lactation',
      'drug_label',
      'drug_lookup',
      'drug_adverse_event_summary',
      'pubmed_search',
    ],
    focusPrompt:
      'Retrieve NLM LactMed and FDA PLLR Pregnancy/Lactation narrative sections verbatim, state infant age/weight/prematurity caveats, and never report retired FDA pregnancy letter categories.',
  },
  {
    id: 'agent_sub_oncology_genomics',
    name: 'Precision Oncology, Genomics & Rare Disease Sub-Agent',
    description:
      'Analyzes ClinVar variant pathogenicity & review stars, MyGene/UniProt molecular biology, Monarch phenotypes, and Open Targets drug pipelines.',
    toolNames: [
      'variant_clinical_significance',
      'gene_lookup',
      'protein_lookup',
      'condition_lookup',
      'condition_targets_and_drugs',
      'ontology_search',
      'clinical_trials',
    ],
    focusPrompt:
      'Report exact ClinVar pathogenicity classifications with review status stars, gene/protein biology, target-disease evidence, and recruiting precision oncology or rare-disease trials.',
  },
  {
    id: 'agent_sub_evidence_trials',
    name: 'Systematic Evidence, Full-Text & Trials Sub-Agent',
    description:
      'Executes PubMed, PMC JATS full-text, Europe PMC citation graph, ClinicalTrials.gov v2, and WHO GHO epidemiological syntheses.',
    toolNames: [
      'pubmed_search',
      'pubmed_article',
      'read_full_text',
      'europe_pmc_search',
      'literature_citations',
      'clinical_trials',
      'health_statistics',
      'plain_language_summary',
    ],
    focusPrompt:
      'Prioritize systematic reviews, meta-analyses, randomized controlled trials, and full-text methods/results via read_full_text, citing exact PMID, PMCID, DOI, and NCT identifiers.',
  },
];

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

async function upsertAndGrantAgent({ Agent, grantPermission, author, shareWithRole, data }) {
  const existing = await Agent.findOne({ id: data.id }).select('_id').lean();
  const saved =
    existing != null
      ? await Agent.findOneAndUpdate({ id: data.id }, data, { new: true })
      : await Agent.create(data);

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
  if (shareWithRole != null) {
    grants.push({
      resourceType: ResourceType.AGENT,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      principalType: PrincipalType.ROLE,
      principalId: shareWithRole,
    });
  }

  for (const grant of grants) {
    await grantPermission({ ...grant, resourceId: saved._id, grantedBy: author._id });
  }
  return saved;
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
  const { seedDatabase } = require('~/models');
  const { Agent } = require('~/db/models');

  await connect();
  await seedDatabase();
  const mongoose = require('mongoose');
  const { createModels } = require('@librechat/data-schemas');
  const { User } = createModels(mongoose);

  const author = await resolveAuthor(User, options.author);
  const availableSet = new Set(tools);
  const seededSubagentIds = [];

  for (const subSpec of SPECIALIST_SUBAGENT_SPECS) {
    const subTools = subSpec.toolNames
      .map((name) => `${name}${Constants.mcp_delimiter}${serverName}`)
      .filter((id) => availableSet.has(id));
    await upsertAndGrantAgent({
      Agent,
      grantPermission,
      author,
      shareWithRole: options.shareWithRole,
      data: {
        id: subSpec.id,
        name: subSpec.name,
        description: subSpec.description,
        instructions: `${subSpec.focusPrompt}\n\n${instructions}`,
        provider: definition.model.provider,
        model: definition.model.id,
        model_parameters: definition.modelParameters,
        author: author._id,
        authorName: author.name,
        tools: subTools,
        mcpServerNames: [serverName],
        max_context_tokens: 200000,
        recursion_limit: 24,
        category: definition.category,
      },
    });
    seededSubagentIds.push(subSpec.id);
  }

  const configuredSubagents = definition.subagents ?? {
    enabled: true,
    allowSelf: true,
    shareFiles: true,
    agent_ids: seededSubagentIds,
  };

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
    max_context_tokens: 200000,
    recursion_limit: definition.recursion_limit,
    category: definition.category,
    conversation_starters: definition.conversationStarters ?? [],
    subagents: {
      ...configuredSubagents,
      agent_ids: Array.from(
        new Set([...(configuredSubagents.agent_ids ?? []), ...seededSubagentIds]),
      ),
    },
    memory_scope: MemoryScope.agent,
    memory_policy: MemoryPolicy.proactive,
    memory_profiles: true,
  };

  const agent = await upsertAndGrantAgent({
    Agent,
    grantPermission,
    author,
    shareWithRole: options.shareWithRole,
    data: agentData,
  });

  logger.info('[seed-medical-agent] agent ready', {
    id: agent.id,
    name: agent.name,
    toolCount: allTools.length,
    subagentCount: seededSubagentIds.length,
    author: author.email ?? author.username,
    sharedWithRole: options.shareWithRole ?? null,
  });
  log(
    `agent "${agent.name}" (${agent.id}) is ready with ${allTools.length} tool(s) and ${seededSubagentIds.length} specialist sub-agent(s)`,
  );
  if (options.shareWithRole == null) {
    log('it is visible only to its owner; re-run with --share-with-role=USER to share it');
  }
  log(
    'continuity tools requested: memory (needs a `memory:` block in librechat.yaml), ' +
      'conversation_history + conversation_transcript (need the `conversation_history` capability)',
  );

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(`[seed-medical-agent] failed: ${error.message}`);
  process.exit(1);
});
