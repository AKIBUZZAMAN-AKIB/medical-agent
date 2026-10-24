export type AdminSectionId =
  | 'overview'
  | 'analytics'
  | 'agents'
  | 'mcp-tools'
  | 'formulary'
  | 'triage-safety'
  | 'consultations'
  | 'users'
  | 'governance'
  | 'system';

export interface DailySeriesPoint {
  date: string;
  messages: number;
  userQueries: number;
  toolInvocations: number;
  tokens: number;
  safetyAlerts: number;
}

export interface RecentConsultationSummary {
  conversationId: string;
  title: string;
  firstMessage: string;
  userName: string;
  userEmail: string;
  agentId: string;
  agentName: string;
  messages: number;
  toolCalls: number;
  subagentHandoffs: number;
  severity: 'emergency' | 'high' | 'moderate' | 'routine';
  specialty: string;
  flags: string[];
  updatedAt?: string;
}

export interface OverviewResponse {
  generatedAt: string;
  kpis: {
    totalUsers: number;
    adminUsers: number;
    patientUsers: number;
    totalAgents: number;
    coreSubagents: number;
    dynamicSubagents: number;
    totalConversations: number;
    sampledMessages: number;
    totalToolCalls: number;
    subagentDelegations: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    patientMemories: number;
    activeBanners: number;
    auditEntries: number;
    emergencyAlerts: number;
    dengueAlerts: number;
    pgxAlerts: number;
    mcpToolsTotal: number;
    mcpToolGroups: number;
    bdBrandsTotal: number;
    bdGenericsTotal: number;
  };
  dailySeries: DailySeriesPoint[];
  specialtyBreakdown: Array<{ specialty: string; count: number }>;
  recentConsultations: RecentConsultationSummary[];
  services: Array<{
    name: string;
    status: 'healthy' | 'degraded' | 'offline';
    latencyMs: number;
    detail: string;
  }>;
}

export interface AdminAgentItem {
  _id: string;
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider: string;
  model: string;
  tier: 'orchestrator' | 'core_subagent' | 'dynamic_subagent' | 'custom_agent';
  tools: string[];
  edges: Array<{ from?: string; to?: string[] | string; edgeType?: string; prompt?: string }>;
  publicAccess: boolean;
  conversationsCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PresetBlueprint {
  key: string;
  id: string;
  name: string;
  specialty: string;
  description: string;
  tools: string[];
  instructions: string;
  spawned: boolean;
}

export interface AgentRegistryResponse {
  parentAgentId: string;
  agents: AdminAgentItem[];
  presetBlueprints: PresetBlueprint[];
  mcpToolCatalog: Array<{
    toolId: string;
    shortName: string;
    group: string;
    summary: string;
  }>;
}

export interface McpToolItem {
  name: string;
  summary: string;
  sampleArgs: Record<string, unknown>;
}

export interface McpToolsResponse {
  serverName: string;
  totalGroups: number;
  totalTools: number;
  groups: Array<{
    id: string;
    label: string;
    bnLabel: string;
    tools: McpToolItem[];
  }>;
}

export interface FormularySummaryResponse {
  available: boolean;
  totalBrands: number;
  totalGenerics: number;
  totalManufacturers: number;
  totalClasses: number;
  totalDosageForms?: number;
  whoEmlGenerics: number;
  bdNemlGenerics: number;
  ddiMappedGenerics?: number;
  pricedBrands: number;
  topManufacturers: Array<{ name: string; count: number; sharePct: number }>;
  topForms: Array<{ name: string; count: number }>;
  priceTiers: Array<{ range: string; count: number; pct: number }>;
}

export interface FormularyBrandRow {
  brand: string;
  strength: string;
  dosageForm: string;
  generic: string;
  therapeuticClass: string;
  manufacturer: string;
  unitPriceBdt: number | null;
  stripPriceBdt: number | null;
  whoEml: boolean;
  bdNeml: boolean;
  pregnancyCategory: string | null;
  indication: string | null;
  doseSummary: string | null;
}

export interface FormularySearchResponse {
  totalMatches: number;
  items: FormularyBrandRow[];
  cheapestAlternatives: FormularyBrandRow[];
}

export interface TriageSafetyResponse {
  counts: {
    totalScanned: number;
    emergency: number;
    high: number;
    moderate: number;
    routine: number;
  };
  events: Array<{
    messageId: string;
    conversationId: string;
    userName: string;
    userEmail: string;
    text: string;
    severity: 'emergency' | 'high' | 'moderate' | 'routine';
    specialty: string;
    flags: string[];
    createdAt?: string;
  }>;
}

export interface ConsultationListItem {
  conversationId: string;
  title: string;
  firstUserPrompt: string;
  userName: string;
  userEmail: string;
  agentId: string;
  agentName: string;
  messagesCount: number;
  toolCalls: number;
  subagentCalls: number;
  severity: 'emergency' | 'high' | 'moderate' | 'routine';
  specialty: string;
  flags: string[];
  updatedAt?: string;
}

export interface ConsultationDetailResponse {
  conversation: {
    conversationId: string;
    title?: string;
    agent_id?: string;
    endpoint?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  patient?: {
    name?: string;
    email?: string;
    role?: string;
  } | null;
  messages: Array<{
    messageId: string;
    sender?: string;
    text?: string;
    isCreatedByUser?: boolean;
    model?: string;
    tokenCount?: number;
    createdAt?: string;
    content?: Array<{
      type: string;
      text?: string;
      think?: string;
      tool_call?: {
        id?: string;
        name?: string;
        args?: string;
        output?: string;
      };
    }>;
  }>;
  transactions: Array<{
    tokenType: string;
    model?: string;
    rawAmount: number;
    createdAt?: string;
  }>;
}

export interface AdminUserRecord {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  provider: string;
  emailVerified: boolean;
  tokenCredits: number;
  conversationsCount: number;
  memories: Array<{
    key: string;
    value: string;
    tokenCount: number;
    updatedAt?: string | null;
  }>;
  createdAt?: string | null;
}

export interface GovernanceResponse {
  roles: Array<{
    _id: string;
    name: string;
    permissions?: Record<string, Record<string, boolean>>;
  }>;
  systemGrants: Array<{
    _id: string;
    principalType: string;
    principalId: string;
    capability: string;
  }>;
  banners: Array<{
    bannerId: string;
    message: string;
    type?: string;
    persistable?: boolean;
    createdAt?: string;
  }>;
  auditLogs: Array<{
    eventId?: string;
    timestamp?: string;
    actorEmail?: string;
    actorRole?: string;
    action: string;
    outcome?: string;
    details?: Record<string, unknown>;
  }>;
}

export interface SystemOpsResponse {
  runtime: {
    nodeVersion: string;
    platform: string;
    cpus: number;
    loadAvg: number[];
    uptimeSeconds: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    totalSystemMemGb: number;
    freeSystemMemGb: number;
  };
  database: {
    readyState: number;
    dbName: string;
    totalCollections: number;
    totalDocuments: number;
    collections: Array<{ name: string; count: number }>;
  };
}

export async function adminFetchJson<T>(
  endpoint: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`/api/admin/medical-command${endpoint}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...headers,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string })?.error || `Admin API failed (${response.status})`,
    );
  }
  return payload as T;
}
