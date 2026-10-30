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
const SUBAGENT_DIR = path.join(AGENT_DIR, 'subagents');
const SERVER_ENTRY = path.resolve(__dirname, '..', 'packages', 'mcp-medical', 'dist', 'index.js');

/**
 * Appended to every specialist's instructions.
 *
 * A specialist used to receive the patient only as prose inside its task text,
 * which is both a second copy of the record and a copy that can be summarized
 * wrong. Reading the record itself keeps one source of truth, and lets the
 * specialist notice when the task text and the record disagree.
 */
const subagentRecordInstruction = [
  'You keep the same per-person records as the doctor agent, one record per person.',
  'Before you reason about a named person, call `list_profiles` and then `read_profile` for that person: the facts are in their record, not in this prompt, and not something you already know.',
  'If the record is empty, say so and work from the task text alone — never present an empty record as a known history.',
  'Never merge two people. If the task text attributes something to a person the record contradicts, state the conflict instead of choosing one.',
  'Write only when the task or the user explicitly asks you to remember something durable, and never to a person the user has not agreed to keep a record for.',
].join('\n');

/**
 * Specialist sub-agents. Each one's instructions are its own skill file in
 * packages/mcp-medical/agent/subagents/ (role, method, tools, limits), followed
 * by the shared working rules in _shared.md and the record instruction above.
 * The main agent's user-facing instructions are deliberately not copied in: a
 * specialist reports to the main agent and never writes the user's reply.
 */
const SPECIALIST_SUBAGENT_SPECS = [
  {
    id: 'agent_sub_emergency_triage',
    name: 'Emergency & First-Aid Sub-Agent',
    description:
      'Judges from the whole case how urgent it is, gives bystander first-aid steps, says when and where hospital care is needed, and reads critical lab values.',
    toolNames: [
      'disease_knowledge_search',
      'condition_lookup',
      'pubmed_search',
      'clinical_calculator',
      'lab_result_interpreter',
      'drug_label',
      'drug_adverse_event_summary',
      'plain_language_summary',
    ],
    skillFile: 'emergency-first-aid.md',
  },
  {
    id: 'agent_sub_pharmacology_ddi',
    name: 'Clinical Pharmacology, Bangladesh Formulary & PGx Sub-Agent',
    description:
      'Resolves Bangladesh brand names to generics, gives label dosing, interactions, safety warnings and CPIC pharmacogenomics, and lists same-generic Bangladesh brands with prices.',
    toolNames: [
      'bd_medicine_lookup',
      'drug_lookup',
      'drug_label',
      'drug_interaction_check',
      'drug_safety_actions',
      'drug_adverse_event_summary',
      'drug_class_atc',
      'pharmacogenomics_guideline',
      'drug_bioactivity',
      'compound_properties',
    ],
    skillFile: 'pharmacology-bd-formulary.md',
  },
  {
    id: 'agent_sub_cardio_nephro_endo',
    name: 'Cardiology, Nephrology & Endocrinology Sub-Agent',
    description:
      'Runs validated scores (CKD-EPI 2021, Cockcroft-Gault, CHA2DS2-VASc, HAS-BLED, HEART, QTc, Asian BMI), interprets cardiac, renal, diabetes and thyroid labs, and checks renal dosing and interactions against the label.',
    toolNames: [
      'clinical_calculator',
      'lab_result_interpreter',
      'drug_label',
      'drug_interaction_check',
      'bd_medicine_lookup',
      'pharmacogenomics_guideline',
      'pubmed_search',
      'pubmed_article',
      'clinical_trials',
      'condition_lookup',
      'icd10cm_code',
      'disease_knowledge_search',
    ],
    skillFile: 'cardio-renal-metabolic.md',
  },
  {
    id: 'agent_sub_maternal_peds',
    name: 'Maternal, Lactation & Paediatric Sub-Agent',
    description:
      'Medicine safety in pregnancy (label narrative, no letter categories) and breastfeeding (LactMed), child health and fever, and paediatric doses only as the label or an official guideline states them.',
    toolNames: [
      'drug_label',
      'drug_lactation',
      'bd_medicine_lookup',
      'drug_lookup',
      'drug_adverse_event_summary',
      'clinical_calculator',
      'pubmed_search',
      'disease_knowledge_search',
    ],
    skillFile: 'maternal-pediatric.md',
  },
  {
    id: 'agent_sub_oncology_genomics',
    name: 'Oncology, Genomics & Precision Medicine Sub-Agent',
    description:
      'Interprets ClinVar variants, genes and proteins, CPIC gene-drug guidance, condition targets and drugs, and recruiting cancer trials.',
    toolNames: [
      'variant_clinical_significance',
      'gene_lookup',
      'protein_lookup',
      'pharmacogenomics_guideline',
      'condition_lookup',
      'condition_targets_and_drugs',
      'ontology_search',
      'clinical_trials',
      'disease_knowledge_search',
    ],
    skillFile: 'oncology-genomics.md',
  },
  {
    id: 'agent_sub_tropical_infectious',
    name: 'Tropical & Infectious Disease Sub-Agent',
    description:
      'Fever and infection in Bangladesh (dengue, malaria, typhoid, kala-azar, TB, diarrhoeal disease): differential, the right test for the day of illness, fever care with paracetamol first, and careful antibiotic use.',
    toolNames: [
      'disease_knowledge_search',
      'lab_result_interpreter',
      'clinical_calculator',
      'drug_label',
      'bd_medicine_lookup',
      'drug_lookup',
      'drug_interaction_check',
      'pubmed_search',
      'health_statistics',
    ],
    skillFile: 'tropical-infectious.md',
  },
  {
    id: 'agent_sub_evidence_trials',
    name: 'Evidence Synthesis & Clinical Trials Sub-Agent',
    description:
      'Finds and grades guidelines, systematic reviews and trials from PubMed, Europe PMC and full text, with effect sizes, limitations and relevance to Bangladesh.',
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
    skillFile: 'evidence-trials.md',
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

/** A specialist's own skill file, then the shared rules, then the record rules. */
function subagentInstructions(subSpec) {
  const read = (file) => fs.readFileSync(path.join(SUBAGENT_DIR, file), 'utf8').trim();
  return [
    read(subSpec.skillFile),
    read('_shared.md'),
    `## Person records\n\n${subagentRecordInstruction}`,
  ].join('\n\n');
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

  // Web search (SearXNG + local scraper/reranker) and file_search (local RAG embeddings) are
  // free, self-hosted tools configured in librechat.pure-doctor.yaml; added 2026-10-28.
  const knowledgeTools = [Tools.web_search, Tools.file_search];
  const allTools = [...tools, ...continuityTools, ...knowledgeTools];
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
    /** The `memory` marker expands into `set_memory` + `delete_memory`, and
     *  `memory_profiles` expands those into the per-person record tools. A
     *  specialist that cannot read the record has to be told the patient's
     *  facts in its task text instead, which both duplicates PHI across agents
     *  and invites a summary to drift from the record. */
    /** A declared tool that the server does not publish used to be filtered
     *  away in silence, so renaming an MCP tool quietly stripped a capability
     *  from a specialist — and a specialist with a missing drug-interaction
     *  checker still answers. Refusing to seed is the only outcome that cannot
     *  be mistaken for success. */
    const composite = (name) => `${name}${Constants.mcp_delimiter}${serverName}`;
    const unpublished = subSpec.toolNames.filter((name) => !availableSet.has(composite(name)));
    if (unpublished.length > 0) {
      throw new Error(
        `Specialist "${subSpec.id}" declares tools the "${serverName}" server does not publish: ${unpublished.join(
          ', ',
        )}. Refusing to seed a specialist that would run with missing capabilities.`,
      );
    }
    const subTools = [...subSpec.toolNames.map(composite), Tools.memory];
    await upsertAndGrantAgent({
      Agent,
      grantPermission,
      author,
      shareWithRole: options.shareWithRole,
      data: {
        id: subSpec.id,
        name: subSpec.name,
        description: subSpec.description,
        instructions: subagentInstructions(subSpec),
        provider: definition.model.provider,
        model: definition.model.id,
        model_parameters: definition.modelParameters,
        author: author._id,
        authorName: author.name,
        tools: subTools,
        mcpServerNames: [serverName],
        recursion_limit: 24,
        category: definition.category,
        /** One shared pool, not one per agent: a specialist that files facts
         *  under its own partition cannot read what the primary agent wrote,
         *  and the patient would silently have two histories. */
        memory_scope: MemoryScope.user,
        memory_profiles: true,
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
    recursion_limit: definition.recursion_limit,
    category: definition.category,
    conversation_starters: definition.conversationStarters ?? [],
    subagents: {
      ...configuredSubagents,
      agent_ids: Array.from(
        new Set([...(configuredSubagents.agent_ids ?? []), ...seededSubagentIds]),
      ),
    },
    /** The whole clinical record space is shared, not per agent: the specialist
     *  sub-agents must read exactly the records the primary agent writes, so
     *  one patient has one history across every agent. Person-level separation
     *  is `memory_profiles`, which is the separation that matters clinically —
     *  an agent-level pool would only hide the patient from the specialists.
     *  Deployments that already stored facts under an agent partition must
     *  re-key them before switching; see docs/MEMORY_AND_LONG_RUN.md. */
    memory_scope: MemoryScope.user,
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

if (require.main === module) {
  main().catch((error) => {
    console.error(`[seed-medical-agent] failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { SPECIALIST_SUBAGENT_SPECS, subagentInstructions };
