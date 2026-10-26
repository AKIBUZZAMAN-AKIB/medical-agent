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
  });

  it('never labels a message it did not assess as routine', async () => {
    /**
     * The console surfaces a severity per message. A keyword matcher that
     * defaults to `routine` is clearing everything it does not understand, which
     * is the failure the medical package's triage tool refuses to produce. An
     * unassessed message must read as `unknown` and say so.
     */
    const res = await request(buildApp('ADMIN')).get('/api/admin/medical-command/triage-safety');
    expect(res.status).toBe(200);
    expect(res.body.basis).toBe('keyword-match');
    expect(res.body.notice).toMatch(/not a clearance|not assessed/i);
    expect(res.body.counts).toHaveProperty('unknown');
    /** Whatever the mix, no row may claim `routine` without a matched rule. */
    const unsupported = res.body.events.filter(
      (event) => event.severity === 'routine' && event.severityBasis === 'none',
    );
    expect(unsupported).toEqual([]);
    const unassessed = res.body.events.filter((event) => event.severityBasis === 'none');
    expect(unassessed.every((event) => event.severity === 'unknown')).toBe(true);
  });
});
