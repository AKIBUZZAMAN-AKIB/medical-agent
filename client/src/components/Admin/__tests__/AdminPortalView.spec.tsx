/* eslint-disable i18next/no-literal-string -- Test fixture labels are not shipped product copy. */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import AdminPortalView from '../AdminPortalView';

let mockRole = 'ADMIN';

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({
    isAuthenticated: true,
    token: 'test-admin-jwt',
    user: { id: 'admin-1', name: 'Dr. Admin', email: 'admin@medical.ai', role: mockRole },
  }),
  useDocumentTitle: () => undefined,
}));

jest.mock('~/components/Insights/InsightsView', () => ({
  __esModule: true,
  default: () => <div data-testid="embedded-insights-view">Native Usage Insights Embedded</div>,
}));

jest.mock('../AdminCharts', () => ({
  MultiSeriesAreaChart: () => <div data-testid="admin-area-chart" />,
  SeverityBadge: ({ severity }: { severity: string }) => <span>{severity}</span>,
  SpecialtyDonutChart: () => <div data-testid="admin-specialty-chart" />,
}));

jest.mock('../AdminClinicalModules', () => ({
  AgentSubagentStudio: () => <div>Multi-Agent & Dynamic Sub-Agent Studio</div>,
  BangladeshFormularyExplorer: () => <div>Amlodipine + Olmesartan Medoxomil</div>,
  ClinicalTriageSafetyMonitor: () => <div>Triage Safety Monitor</div>,
  McpMedicalLab: () => <div>Medical MCP Lab</div>,
}));

jest.mock('../AdminOperationsModules', () => ({
  ConsultationsTraceInspector: () => <div>Consultation Trace Inspector</div>,
  GovernanceRbacAndBanners: () => <div>Governance RBAC</div>,
  SystemInfrastructureOps: () => <div>System Infrastructure Ops</div>,
  UsersAndPatientMemoryManager: () => <div>Users and Patient Memories</div>,
}));

const sampleOverview = {
  generatedAt: '2026-10-24T12:00:00.000Z',
  kpis: {
    totalUsers: 4,
    adminUsers: 1,
    patientUsers: 3,
    totalAgents: 9,
    coreSubagents: 7,
    dynamicSubagents: 1,
    totalConversations: 18,
    sampledMessages: 52,
    totalToolCalls: 34,
    subagentDelegations: 12,
    promptTokens: 14500,
    completionTokens: 8200,
    totalTokens: 22700,
    patientMemories: 6,
    activeBanners: 1,
    auditEntries: 9,
    emergencyAlerts: 2,
    dengueAlerts: 4,
    pgxAlerts: 3,
    mcpToolsTotal: 32,
    mcpToolGroups: 7,
    bdBrandsTotal: 24725,
    bdGenericsTotal: 1553,
  },
  dailySeries: [
    {
      date: '2026-10-23',
      messages: 20,
      userQueries: 9,
      toolInvocations: 14,
      tokens: 9000,
      safetyAlerts: 2,
    },
    {
      date: '2026-10-24',
      messages: 32,
      userQueries: 14,
      toolInvocations: 20,
      tokens: 13700,
      safetyAlerts: 3,
    },
  ],
  specialtyBreakdown: [
    { specialty: 'Tropical Medicine & Dengue', count: 6 },
    { specialty: 'Cardiology & Emergency Triage', count: 4 },
  ],
  recentConsultations: [
    {
      conversationId: 'convo-dengue-1',
      title: 'Dengue Day 5 Warning Case',
      firstMessage: 'Platelet 38,000 and abdominal pain',
      userName: 'Rahim Uddin',
      userEmail: 'patient@medical.ai',
      agentId: 'agent_medical_research',
      agentName: 'Super-Power Doctor AI',
      messages: 4,
      toolCalls: 3,
      subagentHandoffs: 1,
      severity: 'high',
      specialty: 'Tropical Medicine & Dengue',
      flags: ['Dengue Hemorrhagic Guard'],
    },
  ],
  services: [
    {
      name: 'MongoDB Clinical Store (:27017)',
      status: 'healthy',
      latencyMs: 1,
      detail: '9 agents',
    },
  ],
};

describe('AdminPortalView 10-Module Medical AI Command Center', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockRole = 'ADMIN';
    jest.spyOn(window, 'setInterval').mockReturnValue(0);
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) {
        return {
          ok: true,
          json: async () => ({
            parentAgentId: 'agent_medical_research',
            agents: [
              {
                _id: '1',
                id: 'agent_medical_research',
                name: 'Super-Power Doctor AI',
                description: 'Lead Orchestrator',
                instructions: 'Coordinate all specialists.',
                provider: 'DoctorEngine',
                model: 'super-power-doctor-pro',
                tier: 'orchestrator',
                tools: ['bd_medicine_lookup_mcp_medical'],
                edges: [],
                publicAccess: true,
                conversationsCount: 18,
              },
            ],
            presetBlueprints: [
              {
                key: 'dermatology',
                id: 'agent_dyn_dermatology',
                name: 'Dermatology Sub-Agent',
                specialty: 'Dermatology',
                description: 'Skin & drug rash specialist',
                tools: ['bd_medicine_lookup'],
                instructions: 'Screen SJS/TEN first.',
                spawned: false,
              },
            ],
            mcpToolCatalog: [],
          }),
        } as Response;
      }
      if (url.includes('/formulary/search')) {
        return {
          ok: true,
          json: async () => ({
            totalMatches: 1,
            items: [
              {
                brand: 'Bizoran',
                strength: '5 mg+20 mg',
                dosageForm: 'Tablet',
                generic: 'Amlodipine + Olmesartan Medoxomil',
                therapeuticClass: 'Antihypertensive',
                manufacturer: 'Beximco Pharmaceuticals Ltd.',
                unitPriceBdt: 25,
                stripPriceBdt: 250,
                whoEml: true,
                bdNeml: true,
                pregnancyCategory: 'D',
                indication: 'Hypertension',
                doseSummary: 'Once daily',
              },
            ],
            cheapestAlternatives: [],
          }),
        } as Response;
      }
      if (url.includes('/formulary')) {
        return {
          ok: true,
          json: async () => ({
            available: true,
            totalBrands: 24725,
            totalGenerics: 1553,
            totalManufacturers: 387,
            totalClasses: 495,
            whoEmlGenerics: 412,
            bdNemlGenerics: 295,
            pricedBrands: 23900,
            topManufacturers: [{ name: 'Square Pharmaceuticals PLC', count: 1450, sharePct: 5.9 }],
            topForms: [],
            priceTiers: [],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => sampleOverview,
      } as Response;
    }) as jest.Mock;
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function renderAdmin(initialEntry = '/admin') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/admin" element={<AdminPortalView />} />
          <Route path="/admin/:section" element={<AdminPortalView />} />
          <Route path="/c/new" element={<div>Patient Chat View</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('redirects non-ADMIN users safely away to /c/new', async () => {
    mockRole = 'USER';
    renderAdmin('/admin');
    expect(await screen.findByText('Patient Chat View')).toBeInTheDocument();
  });

  it('renders executive KPIs and navigates seamlessly across distinct Admin modules', async () => {
    const user = userEvent.setup();
    renderAdmin('/admin');

    expect(await screen.findByText('MEDICAL ADMIN OS')).toBeInTheDocument();
    expect((await screen.findAllByText('24,725')).length).toBeGreaterThan(0);

    // Switch to Sub-Agent Studio
    await user.click(screen.getByRole('button', { name: /Sub-Agent Studio/i }));
    expect(await screen.findByText(/Multi-Agent & Dynamic Sub-Agent Studio/i)).toBeInTheDocument();

    // Switch to Bangladesh Formulary Explorer
    await user.click(screen.getByRole('button', { name: /BD Formulary/i }));
    expect(await screen.findByText('Amlodipine + Olmesartan Medoxomil')).toBeInTheDocument();

    // Switch to Usage & Token Insights module
    await user.click(screen.getByRole('button', { name: /Usage & Token Insights/i }));
    expect(await screen.findByTestId('embedded-insights-view')).toBeInTheDocument();
  });
});
