const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  createMedicalCommandRouter,
  getFormularyAnalytics,
  searchFormularyCorpus,
} = require('../medicalCommand');

describe('Medical Admin Command Center API (/api/admin/medical-command)', () => {
  jest.setTimeout(60000);
  let mongoServer;
  let adminUser;
  let patientUser;

  function buildApp(role = 'ADMIN') {
    const app = express();
    app.use(express.json());
    const actor = role === 'ADMIN' ? adminUser : patientUser;
    app.use(
      '/api/admin/medical-command',
      createMedicalCommandRouter({
        getDb: () => mongoose.connection.db,
        authMiddleware: (req, _res, next) => {
          req.user = actor;
          next();
        },
        adminAccessMiddleware: (req, res, next) => {
          if (String(req.user?.role || '').toUpperCase() !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin access required.' });
          }
          return next();
        },
        executeTool: async (toolName, args) => ({
          mockedTool: toolName,
          receivedArgs: args,
          status: 'verified',
        }),
      }),
    );
    return app;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      instance: { args: ['--wiredTigerCacheSizeGB', '0.25'] },
    });
    await mongoose.connect(mongoServer.getUri());
    const db = mongoose.connection.db;

    const adminId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    adminUser = { _id: adminId, id: String(adminId), email: 'admin@medical.ai', role: 'ADMIN' };
    patientUser = {
      _id: patientId,
      id: String(patientId),
      email: 'patient@medical.ai',
      role: 'USER',
    };

    await db.collection('users').insertMany([
      { _id: adminId, name: 'Hospital Admin', email: 'admin@medical.ai', role: 'ADMIN' },
      { _id: patientId, name: 'Test Patient', email: 'patient@medical.ai', role: 'USER' },
    ]);

    await db.collection('roles').insertOne({
      name: 'USER',
      permissions: { AGENTS: { USE: true }, MEMORIES: { USE: true } },
    });

    await db.collection('agents').insertMany([
      {
        id: 'agent_medical_research',
        name: 'Super-Power Doctor AI',
        tools: ['bd_medicine_lookup_mcp_medical'],
        edges: [],
      },
      {
        id: 'agent_sub_emergency_triage',
        name: 'Emergency Triage Sub-Agent',
        tools: ['clinical_calculator_mcp_medical'],
        edges: [],
      },
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('rejects non-admin USER requests with HTTP 403', async () => {
    const res = await request(buildApp('USER')).get('/api/admin/medical-command/overview');
    expect(res.status).toBe(403);
  });

  it('serves live executive overview KPIs and formulary totals to ADMIN', async () => {
    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/overview?days=7');
    expect(res.status).toBe(200);
    expect(res.body.kpis.totalAgents).toBeGreaterThanOrEqual(2);
    expect(res.body.kpis.bdBrandsTotal).toBeGreaterThan(24000);
    expect(res.body.dailySeries).toHaveLength(7);
    /** Severity KPIs are reads of persisted decisions, not keyword tallies. */
    expect(res.body.kpis).toHaveProperty('assessedMessages');
    expect(res.body.kpis).toHaveProperty('unassessedMessages');
    expect(res.body.kpis.triageBasis).toBe('persisted-triage-decision');
    expect(res.body.kpis).not.toHaveProperty('dengueAlerts');
    expect(res.body.kpis).not.toHaveProperty('pgxAlerts');
  });

  it('spawns, updates, and deletes dynamic specialist sub-agents in MongoDB', async () => {
    const app = buildApp('ADMIN');
    const spawnRes = await request(app)
      .post('/api/admin/medical-command/agents/spawn')
      .send({ presetKey: 'dermatology' });
    expect(spawnRes.status).toBe(201);
    expect(spawnRes.body.agent.id).toBe('agent_dyn_dermatology');

    const patchRes = await request(app)
      .patch('/api/admin/medical-command/agents/agent_dyn_dermatology')
      .send({ name: 'Dermatology Board Specialist v2' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.agent.name).toBe('Dermatology Board Specialist v2');

    // Protect core sub-agent from accidental deletion
    const protectRes = await request(app).delete(
      '/api/admin/medical-command/agents/agent_sub_emergency_triage',
    );
    expect(protectRes.status).toBe(400);

    const delRes = await request(app).delete(
      '/api/admin/medical-command/agents/agent_dyn_dermatology',
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);
  });

  it('analyzes and searches 24,725+ Bangladesh formulary brands accurately', async () => {
    const analytics = getFormularyAnalytics();
    expect(analytics.available).toBe(true);
    expect(analytics.totalBrands).toBeGreaterThan(24000);

    const search = searchFormularyCorpus({ query: 'Tab. Napa Extend', limit: 5 });
    expect(search.items.length).toBeGreaterThan(0);
    expect(search.items[0].generic.toLowerCase()).toContain('paracetamol');
  });

  it('manages users, longitudinal patient memories, broadcast banners, MCP tools, and demo seeding', async () => {
    const app = buildApp('ADMIN');

    const weakPasswordRes = await request(app)
      .post('/api/admin/medical-command/users')
      .send({ email: 'new-user@example.test', password: 'weak' });
    expect(weakPasswordRes.status).toBe(400);

    const userRes = await request(app).post('/api/admin/medical-command/users').send({
      name: 'New Patient',
      email: 'new-user@example.test',
      password: 'Unique-Temp-Pass-2026!',
    });
    expect(userRes.status).toBe(201);
    expect(userRes.body.role).toBe('USER');

    const memRes = await request(app)
      .post(`/api/admin/medical-command/users/${patientUser.id}/memories`)
      .send({ key: 'father_allergy', value: 'Severe anaphylaxis to Penicillin' });
    expect(memRes.status).toBe(201);

    const bannerRes = await request(app)
      .post('/api/admin/medical-command/governance/banners')
      .send({ message: 'Dengue Alert: Avoid all NSAIDs during febrile illness.' });
    expect(bannerRes.status).toBe(201);

    const permissionRes = await request(app)
      .patch('/api/admin/medical-command/governance/roles/USER')
      .send({ permissionType: 'AGENTS', key: 'USE', value: false });
    expect(permissionRes.status).toBe(200);
    const invalidPermissionRes = await request(app)
      .patch('/api/admin/medical-command/governance/roles/USER')
      .send({ permissionType: 'AGENTS.$where', key: 'USE', value: false });
    expect(invalidPermissionRes.status).toBe(400);

    const mcpRes = await request(app)
      .post('/api/admin/medical-command/mcp-tools/execute')
      .send({ toolName: 'bd_medicine_lookup', args: { query: 'Sergel 20' } });
    expect(mcpRes.status).toBe(200);
    expect(mcpRes.body.ok).toBe(true);

    const seedRes = await request(app).post('/api/admin/medical-command/system/seed-demo');
    expect(seedRes.status).toBe(201);
    expect(seedRes.body.seeded).toBe(3);

    const triageRes = await request(app).get('/api/admin/medical-command/triage-safety');
    expect(triageRes.status).toBe(200);
    expect(triageRes.body.counts.totalScanned).toBeGreaterThanOrEqual(3);
    expect(triageRes.body.basis).toBe('persisted-triage-decision');
  });

  /**
   * The console must report *decisions*, not *matches*.
   *
   * These four tests are the guard on §F-40/F-41 in
   * `docs/REPOSITORY_DEEP_AUDIT.md`: severity and specialty in the admin surface
   * may only come from a persisted `emergency_triage_check` decision (and from
   * the handling agent), never from a word list scanning the patient's sentence.
   * A message whose conversation holds no stored decision is `unassessed`, no
   * matter how alarming or how mundane it reads.
   */
  const decisionContent = (severity, decided = true) => [
    {
      type: 'tool_call',
      tool_call: {
        id: 'call-1',
        name: 'emergency_triage_check_mcp_medical',
        args: { message: 'synthetic' },
        output:
          'Triage severity: X (ruleset 2.0.0-generation)\n' +
          `<<<TRIAGE_DECISION {"severity":"${severity}","severityCode":4,"decided":${decided},"classifier":"llm:synthetic","ruleset":"2.0.0-generation"}>>>`,
      },
    },
  ];

  async function insertConversation({ conversationId, text, content, agentId }) {
    const db = mongoose.connection.db;
    const now = new Date();
    await db.collection('conversations').insertOne({
      conversationId,
      user: patientUser._id,
      agent_id: agentId || 'agent_sub_emergency_triage',
      title: text.slice(0, 40),
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('messages').insertOne({
      messageId: `${conversationId}-user`,
      conversationId,
      user: patientUser._id,
      isCreatedByUser: true,
      text,
      createdAt: now,
    });
    if (content) {
      await db.collection('messages').insertOne({
        messageId: `${conversationId}-assistant`,
        conversationId,
        user: patientUser._id,
        isCreatedByUser: false,
        sender: 'Super-Power Doctor AI',
        content,
        createdAt: now,
      });
    }
  }

  it('reports a severity only when the record holds a triage decision', async () => {
    await insertConversation({
      conversationId: 'conv-evidence-emergency',
      text: 'Something is happening and I do not know how to say it',
      content: decisionContent('emergency'),
    });

    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/triage-safety');
    expect(res.status).toBe(200);
    expect(res.body.basis).toBe('persisted-triage-decision');
    const event = res.body.events.find((e) => e.conversationId === 'conv-evidence-emergency');
    expect(event.severity).toBe('emergency');
    expect(event.severityBasis).toBe('persisted-triage-decision');
    expect(event.triageDecisions).toBe(1);
    /** The handling agent is the label, not an inferred specialty. */
    expect(event.specialty).toBe('agent_sub_emergency_triage');
  });

  it('never upgrades a message from its wording: alarming text with no decision is unassessed', async () => {
    /**
     * This is the exact sentence the old lexicon scored as `emergency`
     * ("suicide", "chest pain", "ডেঙ্গু", "Napa"), with the old lexicon deleted.
     * It must now read as an absence of assessment — which is the truth about the
     * record — and must not be counted as a safety alert either way.
     */
    await insertConversation({
      conversationId: 'conv-no-decision',
      text: 'I have chest pain and thoughts of suicide after taking Napa, ডেঙ্গু প্লাটিলেট কম',
    });

    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/triage-safety');
    const event = res.body.events.find((e) => e.conversationId === 'conv-no-decision');
    expect(event.severity).toBe('unassessed');
    expect(event.severityBasis).toBe('none');
    expect(event.triageDecisions).toBe(0);
    expect(res.body.counts).toHaveProperty('unassessed');
    expect(res.body.notice).toMatch(/no stored decision|not assessed|not a clearance/i);
    /** No row may claim a made-up severity while its basis is `none`. */
    const unsupported = res.body.events.filter(
      (e) => e.severityBasis === 'none' && e.severity !== 'unassessed',
    );
    expect(unsupported).toEqual([]);
  });

  it('keeps an undecided classifier result undecided instead of inventing routine', async () => {
    await insertConversation({
      conversationId: 'conv-undecided',
      text: 'My father has been dizzy since morning',
      content: decisionContent('unknown', false),
    });

    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/triage-safety');
    const event = res.body.events.find((e) => e.conversationId === 'conv-undecided');
    expect(event.severity).toBe('unknown');
    expect(event.undecidedTriage).toBe(1);
    expect(res.body.counts.unknown).toBeGreaterThanOrEqual(1);
  });

  it('scans only the people its 200 rows mention, not the whole user collection', async () => {
    /**
     * The triage panel used to read every account in the deployment to decorate
     * 200 messages. This asserts the narrowing at the data layer: a message whose
     * author is not in `users` still renders (as "Patient").
     */
    const db = mongoose.connection.db;
    await db.collection('messages').insertOne({
      messageId: 'msg-orphan',
      conversationId: 'conv-audit-orphan',
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      text: 'chest pain since an hour',
      createdAt: new Date(),
    });
    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/triage-safety');
    expect(res.status).toBe(200);
    const orphan = res.body.events.find((event) => event.messageId === 'msg-orphan');
    expect(orphan).toBeDefined();
    expect(orphan.userName).toBe('Patient');
    /** Wording is not evidence: with no decision stored it is unassessed. */
    expect(orphan.severity).toBe('unassessed');
    expect(orphan.specialty).toBe('No agent recorded');
  });
});
