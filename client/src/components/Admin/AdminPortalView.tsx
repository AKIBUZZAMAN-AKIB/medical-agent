/* eslint-disable i18next/no-literal-string -- Bangladesh-specific admin navigation intentionally uses English headings with Bangla subtitles. */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { AdminSectionId, OverviewResponse } from './types';
import {
  ConsultationsTraceInspector,
  GovernanceRbacAndBanners,
  SystemInfrastructureOps,
  UsersAndPatientMemoryManager,
} from './AdminOperationsModules';
import {
  AgentSubagentStudio,
  BangladeshFormularyExplorer,
  ClinicalTriageSafetyMonitor,
  McpMedicalLab,
} from './AdminClinicalModules';
import { MultiSeriesAreaChart, SeverityBadge, SpecialtyDonutChart } from './AdminCharts';
import InsightsView from '~/components/Insights/InsightsView';
import { useAuthContext, useDocumentTitle } from '~/hooks';
import { adminFetchJson } from './types';

interface NavGroup {
  heading: string;
  items: Array<{
    id: AdminSectionId;
    icon: string;
    label: string;
    bnSubtitle: string;
    badgeKey?: keyof OverviewResponse['kpis'];
  }>;
}

const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    heading: 'COMMAND & ANALYTICS',
    items: [
      {
        id: 'overview',
        icon: '📊',
        label: 'Executive Command',
        bnSubtitle: 'এক্সিকিউটিভ হাসপাতাল ড্যাশবোর্ড',
      },
      {
        id: 'analytics',
        icon: '📈',
        label: 'Usage & Token Insights',
        bnSubtitle: 'ইউসেজ গ্রাফ ও টোকেন ইনসাইটস',
        badgeKey: 'totalConversations',
      },
    ],
  },
  {
    heading: 'CLINICAL AI & SPECIALISTS',
    items: [
      {
        id: 'agents',
        icon: '🧬',
        label: 'Sub-Agent Studio',
        bnSubtitle: 'এজেন্ট গ্রাফ ও সাব-এজেন্ট নির্মাতা',
        badgeKey: 'totalAgents',
      },
      {
        id: 'mcp-tools',
        icon: '🛠️',
        label: 'MCP 32-Tool Lab',
        bnSubtitle: '৩২টি মেডিকেল টুল টেস্ট প্লেগ্রাউন্ড',
        badgeKey: 'mcpToolsTotal',
      },
      {
        id: 'formulary',
        icon: '🇧🇩',
        label: 'BD Formulary (24.7k)',
        bnSubtitle: 'বাংলাদেশি ওষুধ ও সাশ্রয়ী দাম',
        badgeKey: 'bdBrandsTotal',
      },
      {
        id: 'triage-safety',
        icon: '🚨',
        label: 'Triage & Safety Guard',
        bnSubtitle: 'রেড-ফ্ল্যাগ, ডেঙ্গু ও ল্যাব অডিট',
        badgeKey: 'emergencyAlerts',
      },
    ],
  },
  {
    heading: 'OPERATIONS & GOVERNANCE',
    items: [
      {
        id: 'consultations',
        icon: '💬',
        label: 'Consultation Traces',
        bnSubtitle: 'রোগীর চ্যাট ও টুল-কল ট্রেস',
        badgeKey: 'sampledMessages',
      },
      {
        id: 'users',
        icon: '👥',
        label: 'Users & Memories',
        bnSubtitle: 'ইউজার, ক্রেডিট ও ক্লিনিক্যাল মেমোরি',
        badgeKey: 'totalUsers',
      },
      {
        id: 'governance',
        icon: '🔐',
        label: 'RBAC, Banners & Audit',
        bnSubtitle: 'রোল পারমিশন, ব্যানার ও অডিট লগ',
        badgeKey: 'auditEntries',
      },
      {
        id: 'system',
        icon: '⚙️',
        label: 'System & MongoDB Ops',
        bnSubtitle: 'সার্ভার হেলথ ও ডাটাবেস ইন্সপেক্টর',
      },
    ],
  },
];

const VALID_SECTIONS = new Set<AdminSectionId>([
  'overview',
  'analytics',
  'agents',
  'mcp-tools',
  'formulary',
  'triage-safety',
  'consultations',
  'users',
  'governance',
  'system',
]);

export default function AdminPortalView() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { user, token, isAuthenticated } = useAuthContext();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  const [inspectConvoId, setInspectConvoId] = useState<string>('');

  const activeSection: AdminSectionId =
    section && VALID_SECTIONS.has(section as AdminSectionId)
      ? (section as AdminSectionId)
      : 'overview';

  useDocumentTitle('🛡️ Medical AI Admin Command Center');

  const fetchOverview = useCallback(async () => {
    try {
      const data = await adminFetchJson<OverviewResponse>('/overview?days=14', token);
      setOverview(data);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoadingOverview(false);
    }
  }, [token]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchOverview();
  }, [isAuthenticated, fetchOverview]);

  useEffect(() => {
    if (!isAuthenticated || !autoSync) return;
    const id = window.setInterval(fetchOverview, 15000);
    return () => window.clearInterval(id);
  }, [isAuthenticated, autoSync, fetchOverview]);

  if (!isAuthenticated) {
    return null;
  }

  if (user && String(user.role || '').toUpperCase() !== 'ADMIN') {
    return <Navigate to="/c/new" replace />;
  }

  const switchSection = (target: AdminSectionId, convoId?: string) => {
    if (convoId) {
      setInspectConvoId(convoId);
    }
    navigate(target === 'overview' ? '/admin' : `/admin/${target}`);
  };

  const kpis = overview?.kpis;

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-slate-950 text-slate-100">
      {/* Dedicated Enterprise Medical AI Admin Sidebar */}
      <aside
        aria-label="Medical Admin Navigation"
        className={`flex shrink-0 flex-col border-r border-slate-800 bg-slate-900/95 transition-all duration-200 ${
          sidebarOpen ? 'w-72' : 'w-16'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-800 px-4">
          {sidebarOpen && (
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-extrabold tracking-tight text-emerald-400">
                <span>🛡️</span>
                <span className="truncate">MEDICAL ADMIN OS</span>
              </div>
              <div className="truncate text-[11px] text-slate-400">
                Super-Power Doctor Governance
              </div>
            </div>
          )}
          <button
            type="button"
            aria-label="Toggle Admin Sidebar"
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300 hover:border-emerald-500"
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.heading}>
              {sidebarOpen && (
                <div className="mb-1.5 px-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {group.heading}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive = activeSection === item.id;
                  const badgeVal = item.badgeKey && kpis ? kpis[item.badgeKey] : undefined;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => switchSection(item.id)}
                      className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition ${
                        isActive
                          ? 'border border-emerald-500/40 bg-emerald-500/15 text-white shadow-sm'
                          : 'border border-transparent text-slate-300 hover:bg-slate-800/70'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="text-base">{item.icon}</span>
                        {sidebarOpen && (
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold">{item.label}</div>
                            <div className="truncate text-[10px] text-slate-400">
                              {item.bnSubtitle}
                            </div>
                          </div>
                        )}
                      </div>
                      {sidebarOpen && badgeVal !== undefined && (
                        <span className="ml-1 rounded-full bg-slate-950 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
                          {Number(badgeVal).toLocaleString()}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-2 border-t border-slate-800 p-3">
          <Link
            to="/c/new"
            className="flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/50 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/50"
          >
            <span>🩺</span>
            {sidebarOpen && <span>Open Doctor Chat Console</span>}
          </Link>
          {sidebarOpen && (
            <div className="rounded-lg bg-slate-950 px-3 py-2 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">{user?.name || 'Hospital Admin'}</div>
              <div className="truncate font-mono text-[10px] text-emerald-400">{user?.email}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Workspace Pane */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top Command Header */}
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 px-6 py-3">
          <div>
            <h1 className="text-base font-bold text-white">
              {ADMIN_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === activeSection)?.icon}{' '}
              {ADMIN_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === activeSection)?.label}{' '}
              <span className="ml-1 text-xs font-normal text-emerald-400">
                ·{' '}
                {
                  ADMIN_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === activeSection)
                    ?.bnSubtitle
                }
              </span>
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setAutoSync((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                autoSync
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {autoSync ? '● Live Sync (15s)' : '○ Auto-Sync Paused'}
            </button>
            <button
              type="button"
              onClick={fetchOverview}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-emerald-500"
            >
              ↻ Refresh Telemetry
            </button>
          </div>
        </header>

        {/* Scrollable Content Area */}
        {activeSection === 'analytics' ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <InsightsView />
          </div>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            {errorMsg && (
              <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
                ⚠️ Telemetry Warning: {errorMsg}
              </div>
            )}

            {activeSection === 'overview' && (
              <div className="space-y-6">
                {loadingOverview && !overview ? (
                  <div className="p-8 text-sm text-slate-400">
                    Loading Hospital AI Executive Telemetry…
                  </div>
                ) : (
                  overview && (
                    <>
                      {/* 8 Distinct Deep KPI Cards */}
                      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
                        <button
                          type="button"
                          onClick={() => switchSection('consultations')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-emerald-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            💬 Total Clinical Consultations
                          </div>
                          <div className="mt-2 text-3xl font-extrabold text-white">
                            {overview.kpis.totalConversations.toLocaleString()}
                          </div>
                          <div className="mt-1 text-[11px] text-emerald-400">
                            {overview.kpis.sampledMessages.toLocaleString()} messages · Click to
                            inspect traces →
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('agents')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-violet-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            🧬 Active Orchestrator & Sub-Agents
                          </div>
                          <div className="mt-2 text-3xl font-extrabold text-violet-300">
                            {overview.kpis.totalAgents}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-300">
                            1 Chief + {overview.kpis.coreSubagents} Core +{' '}
                            <strong className="text-violet-300">
                              {overview.kpis.dynamicSubagents} Dynamic Spawned
                            </strong>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('formulary')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-cyan-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            🇧🇩 Bangladesh Formulary Index
                          </div>
                          <div className="mt-2 text-3xl font-extrabold text-cyan-300">
                            {overview.kpis.bdBrandsTotal.toLocaleString()}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-300">
                            {overview.kpis.bdGenericsTotal.toLocaleString()} INN generics ·{' '}
                            {overview.kpis.mcpToolsTotal} live MCP tools →
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('triage-safety')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-rose-500/50"
                        >
                          <div className="text-xs text-slate-400">🚨 Triage Decisions Recorded</div>
                          <div className="mt-2 text-3xl font-extrabold text-rose-300">
                            {overview.kpis.emergencyAlerts}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-300">
                            {overview.kpis.assessedMessages} assessed ·{' '}
                            {overview.kpis.unassessedMessages} unassessed ·{' '}
                            {overview.kpis.undecidedMessages} undecided
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('users')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-emerald-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            👥 Users & Longitudinal Memories
                          </div>
                          <div className="mt-2 text-2xl font-bold text-white">
                            {overview.kpis.totalUsers} Users · {overview.kpis.patientMemories}{' '}
                            Memories
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            {overview.kpis.adminUsers} Admins · {overview.kpis.patientUsers}{' '}
                            Patients
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('mcp-tools')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-cyan-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            ⚙️ MCP Tool & Sub-Agent Calls
                          </div>
                          <div className="mt-2 text-2xl font-bold text-emerald-300">
                            {overview.kpis.totalToolCalls.toLocaleString()} Actions
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            {overview.kpis.subagentDelegations} specialist sub-agent handoffs
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('analytics')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-emerald-500/50"
                        >
                          <div className="text-xs text-slate-400">🪙 Total Token Volume</div>
                          <div className="mt-2 text-2xl font-bold text-amber-300">
                            {overview.kpis.totalTokens.toLocaleString()}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            Prompt {overview.kpis.promptTokens.toLocaleString()} · Completion{' '}
                            {overview.kpis.completionTokens.toLocaleString()}
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => switchSection('governance')}
                          className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 text-left hover:border-amber-500/50"
                        >
                          <div className="text-xs text-slate-400">
                            🔐 Governance Banners & Audit Log
                          </div>
                          <div className="mt-2 text-2xl font-bold text-white">
                            {overview.kpis.activeBanners} Banners · {overview.kpis.auditEntries}{' '}
                            Audits
                          </div>
                          <div className="mt-1 text-[11px] text-emerald-400">
                            Manage RBAC roles & hospital alerts →
                          </div>
                        </button>
                      </div>

                      {/* Service Health Strip */}
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {overview.services.map((svc) => (
                          <div
                            key={svc.name}
                            className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-white">{svc.name}</span>
                              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                                ● {svc.status.toUpperCase()} ({svc.latencyMs}ms)
                              </span>
                            </div>
                            <p className="mt-1.5 text-[11px] text-slate-400">{svc.detail}</p>
                          </div>
                        ))}
                      </div>

                      {/* Charts Row */}
                      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                        <div className="xl:col-span-7">
                          <MultiSeriesAreaChart series={overview.dailySeries} />
                        </div>
                        <div className="xl:col-span-5">
                          <SpecialtyDonutChart data={overview.specialtyBreakdown} />
                        </div>
                      </div>

                      {/* Latest Enriched Clinical Consultations Table */}
                      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/90 p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-bold text-white">
                              🩺 Live Clinical Consultations & Safety Triage Stream
                            </h3>
                            <p className="text-xs text-slate-400">
                              যেকোনো রো-তে ক্লিক করলে ঐ রোগীর সম্পূর্ণ চ্যাট থ্রেড ও MCP টুল ট্রেস
                              ওপেন হবে
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => switchSection('consultations')}
                            className="text-xs font-semibold text-emerald-400 hover:underline"
                          >
                            View All Consultations →
                          </button>
                        </div>

                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-slate-800 text-slate-400">
                            <tr>
                              <th className="py-2 pr-3">Triage Level</th>
                              <th className="py-2 pr-3">Patient</th>
                              <th className="py-2 pr-3">Specialty</th>
                              <th className="py-2 pr-3">Consultation Topic</th>
                              <th className="py-2 text-right">Msgs / Tools</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/70">
                            {overview.recentConsultations.map((row) => (
                              <tr
                                key={row.conversationId}
                                onClick={() => switchSection('consultations', row.conversationId)}
                                className="cursor-pointer hover:bg-slate-800/50"
                              >
                                <td className="py-2.5 pr-3">
                                  <SeverityBadge severity={row.severity} />
                                </td>
                                <td className="py-2.5 pr-3">
                                  <div className="font-semibold text-white">{row.userName}</div>
                                  <div className="text-[11px] text-slate-400">{row.userEmail}</div>
                                </td>
                                <td className="py-2.5 pr-3 text-cyan-300">{row.specialty}</td>
                                <td className="max-w-md truncate py-2.5 pr-3 text-slate-200">
                                  {row.firstMessage || row.title}
                                </td>
                                <td className="py-2.5 text-right font-mono text-emerald-300">
                                  {row.messages} / {row.toolCalls}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )
                )}
              </div>
            )}

            {activeSection === 'agents' && (
              <AgentSubagentStudio token={token} onMutated={fetchOverview} />
            )}
            {activeSection === 'mcp-tools' && <McpMedicalLab token={token} />}
            {activeSection === 'formulary' && <BangladeshFormularyExplorer token={token} />}
            {activeSection === 'triage-safety' && <ClinicalTriageSafetyMonitor token={token} />}
            {activeSection === 'consultations' && (
              <ConsultationsTraceInspector token={token} initialConversationId={inspectConvoId} />
            )}
            {activeSection === 'users' && (
              <UsersAndPatientMemoryManager token={token} onMutated={fetchOverview} />
            )}
            {activeSection === 'governance' && (
              <GovernanceRbacAndBanners token={token} onMutated={fetchOverview} />
            )}
            {activeSection === 'system' && (
              <SystemInfrastructureOps token={token} onMutated={fetchOverview} />
            )}
          </main>
        )}
      </div>
    </div>
  );
}
