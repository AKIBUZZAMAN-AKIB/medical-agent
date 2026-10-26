/* eslint-disable i18next/no-literal-string -- Bangladesh-specific clinical modules intentionally mix English labels with Bangla guidance. */
import React, { useCallback, useEffect, useState } from 'react';
import type {
  AdminAgentItem,
  AgentRegistryResponse,
  FormularySearchResponse,
  FormularySummaryResponse,
  McpToolsResponse,
  TriageSafetyResponse,
} from './types';
import { OrchestrationTopologyGraph, SeverityBadge } from './AdminCharts';
import { adminFetchJson } from './types';

/* ============================================================================
 * MODULE 2: AGENT & DYNAMIC SUB-AGENT STUDIO
 * ========================================================================== */
export function AgentSubagentStudio({
  token,
  onMutated,
}: {
  token?: string;
  onMutated?: () => void;
}) {
  const [data, setData] = useState<AgentRegistryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<AdminAgentItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editTools, setEditTools] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Custom Sub-Agent Creator state
  const [showCreator, setShowCreator] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSpecialty, setNewSpecialty] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [newTools, setNewTools] = useState<string[]>([
    'bd_medicine_lookup',
    'pubmed_search',
    'clinical_calculator',
  ]);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetchJson<AgentRegistryResponse>('/agents', token);
      setData(res);
      setSelectedAgent((prev) => {
        const next =
          res.agents.find((a) => a.id === prev?.id) ||
          res.agents.find((a) => a.tier === 'dynamic_subagent') ||
          res.agents[0] ||
          null;
        if (next) {
          setEditName(next.name);
          setEditDesc(next.description);
          setEditInstructions(next.instructions);
          setEditTools(next.tools.filter((t) => t !== 'sys__server__sys'));
        }
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const selectAgent = (ag: AdminAgentItem) => {
    setSelectedAgent(ag);
    setEditName(ag.name);
    setEditDesc(ag.description);
    setEditInstructions(ag.instructions);
    setEditTools(ag.tools.filter((t) => t !== 'sys__server__sys'));
  };

  const handleSpawnPreset = async (presetKey: string) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await adminFetchJson<{ agent: { id: string; name: string } }>(
        '/agents/spawn',
        token,
        {
          method: 'POST',
          body: JSON.stringify({ presetKey }),
        },
      );
      setStatusMsg(
        `✅ স্পেশালিস্ট সাব-এজেন্ট তৈরি ও সংযুক্ত হয়েছে: ${res.agent.name} (${res.agent.id})`,
      );
      await loadAgents();
      onMutated?.();
    } catch (e) {
      setStatusMsg(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await adminFetchJson<{ agent: { id: string; name: string } }>(
        '/agents/spawn',
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            name: newName,
            specialty: newSpecialty || newName,
            description: newDesc,
            instructions: newInstructions,
            tools: newTools,
          }),
        },
      );
      setStatusMsg(`✅ কাস্টম সাব-এজেন্ট তৈরি হয়েছে: ${res.agent.name} (${res.agent.id})`);
      setShowCreator(false);
      setNewName('');
      setNewSpecialty('');
      setNewDesc('');
      setNewInstructions('');
      await loadAgents();
      onMutated?.();
    } catch (err) {
      setStatusMsg(`❌ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSelected = async () => {
    if (!selectedAgent) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      await adminFetchJson(`/agents/${selectedAgent.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          description: editDesc,
          instructions: editInstructions,
          tools: editTools,
        }),
      });
      setStatusMsg(`✅ MongoDB-তে এজেন্ট আপডেট সংরক্ষিত হয়েছে: ${editName}`);
      await loadAgents();
      onMutated?.();
    } catch (err) {
      setStatusMsg(`❌ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDynamic = async () => {
    if (!selectedAgent) return;
    setBusy(true);
    try {
      await adminFetchJson(`/agents/${selectedAgent.id}`, token, { method: 'DELETE' });
      setStatusMsg(`🗑️ ডায়নামিক সাব-এজেন্ট মুছে ফেলা হয়েছে: ${selectedAgent.name}`);
      await loadAgents();
      onMutated?.();
    } catch (err) {
      setStatusMsg(`❌ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return <div className="p-8 text-sm text-slate-400">Loading Multi-Agent Registry…</div>;
  }
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <div>
          <h2 className="text-base font-bold text-white">
            🧬 Multi-Agent & Dynamic Sub-Agent Studio ({data.agents.length} Active Agents)
          </h2>
          <p className="text-xs text-slate-400">
            ১ ক্লিকে নতুন বিশেষজ্ঞ সাব-এজেন্ট তৈরি করুন, অথবা যেকোনো এজেন্টের প্রম্পট ও MCP টুলসেট
            সরাসরি এডিট করুন
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreator((v) => !v)}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-emerald-500"
        >
          {showCreator ? '✕ Close Custom Builder' : '➕ Create Custom Specialty Sub-Agent'}
        </button>
      </div>

      {statusMsg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs font-medium text-emerald-200">
          {statusMsg}
        </div>
      )}

      {showCreator && (
        <form
          onSubmit={handleCreateCustom}
          className="space-y-4 rounded-xl border border-violet-500/40 bg-slate-900 p-5"
        >
          <h3 className="text-sm font-bold text-violet-300">
            ⚡ নতুন কাস্টম মেডিকেল সাব-এজেন্ট নির্মাতা (Persists Directly to MongoDB + Handoff
            Graph)
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-300">Agent Display Name *</label>
              <input
                aria-label="Custom Agent Name"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Rheumatology & Autoimmune Lupus Sub-Agent"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-300">Specialty ID Slug</label>
              <input
                value={newSpecialty}
                onChange={(e) => setNewSpecialty(e.target.value)}
                placeholder="e.g. rheumatology_lupus"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-300">Short Clinical Scope</label>
            <input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="SLE, rheumatoid arthritis, DMARD monitoring & steroid safety"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-300">
              Specialist System Prompt & Safety Rules
            </label>
            <textarea
              rows={3}
              value={newInstructions}
              onChange={(e) => setNewInstructions(e.target.value)}
              placeholder="Screen red flags first, cite PubMed PMIDs, verify renal/hepatic dosing & Bangladesh brand prices..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-white"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-slate-300">
              Assign MCP Medical Tools ({newTools.length} selected)
            </label>
            <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 md:grid-cols-4">
              {data.mcpToolCatalog.map((tool) => {
                const checked = newTools.includes(tool.shortName);
                return (
                  <label
                    key={tool.toolId}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-900"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setNewTools((prev) =>
                          checked
                            ? prev.filter((x) => x !== tool.shortName)
                            : [...prev, tool.shortName],
                        )
                      }
                    />
                    <span className="truncate font-mono">{tool.shortName}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreator(false)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
            >
              🚀 Spawn & Connect to Orchestrator
            </button>
          </div>
        </form>
      )}

      <OrchestrationTopologyGraph
        agents={data.agents}
        selectedId={selectedAgent?.id || ''}
        onSelectAgent={selectAgent}
      />

      {/* 1-Click Specialty Blueprint Spawner */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">
          ⚡ 1-Click Specialty Blueprint Spawner (১০টি রেডিমেড মেডিকেল ডিপার্টমেন্ট)
        </h3>
        <p className="mb-3 text-xs text-slate-400">
          যে ডিপার্টমেন্ট এখনো তৈরি হয়নি তাতে ক্লিক করলেই সাথে সাথে MongoDB-তে তৈরি হয়ে মূল
          ডাক্তারের সাথে যুক্ত হবে
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {data.presetBlueprints.map((bp) => (
            <div
              key={bp.key}
              className={`flex flex-col justify-between rounded-lg border p-3 ${
                bp.spawned
                  ? 'border-emerald-500/30 bg-emerald-950/20'
                  : 'border-slate-800 bg-slate-950/80'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold text-slate-100">{bp.specialty}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      bp.spawned
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {bp.spawned ? 'ACTIVE' : 'READY'}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{bp.description}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleSpawnPreset(bp.key)}
                className={`mt-3 w-full rounded-md py-1.5 text-[11px] font-semibold transition ${
                  bp.spawned
                    ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                    : 'bg-violet-600 text-white hover:bg-violet-500'
                }`}
              >
                {bp.spawned ? '↻ Sync / Refresh Blueprint' : '⚡ Spawn Sub-Agent'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Live Selected Agent Editor */}
      {selectedAgent && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-mono text-xs text-emerald-400">{selectedAgent.id}</span>
              <h3 className="text-base font-bold text-white">{selectedAgent.name}</h3>
            </div>
            <div className="flex items-center gap-2">
              {selectedAgent.tier !== 'orchestrator' && selectedAgent.tier !== 'core_subagent' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDeleteDynamic}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
                >
                  🗑️ Delete Dynamic Agent
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={handleSaveSelected}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                💾 Save Agent Configuration
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-400">Display Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Clinical Description</label>
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-xs text-slate-400">
              System Instructions & Clinical Guardrails
            </label>
            <textarea
              rows={5}
              value={editInstructions}
              onChange={(e) => setEditInstructions(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-emerald-100"
            />
          </div>

          <div className="mt-3">
            <span className="mb-1.5 block text-xs text-slate-400">
              Assigned MCP Tools ({editTools.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {editTools.map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-cyan-500/30 bg-cyan-950/40 px-2 py-0.5 font-mono text-[11px] text-cyan-300"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * MODULE 3: 32-TOOL MCP MEDICAL LAB & HEALTH PROBE
 * ========================================================================== */
export function McpMedicalLab({ token }: { token?: string }) {
  const [catalog, setCatalog] = useState<McpToolsResponse | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>('bd_medicine_lookup');
  const [jsonInput, setJsonInput] = useState<string>(
    JSON.stringify({ query: 'Bizoran 5/20', max_alternatives: 8 }, null, 2),
  );
  const [execOutput, setExecOutput] = useState<{
    latencyMs: number;
    result?: unknown;
    error?: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [healthResults, setHealthResults] = useState<
    Array<{ name: string; tool: string; status: string; latencyMs: number; error?: string }>
  >([]);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    adminFetchJson<McpToolsResponse>('/mcp-tools', token)
      .then(setCatalog)
      .catch(() => undefined);
  }, [token]);

  const handlePickTool = (name: string, sampleArgs: Record<string, unknown>) => {
    setSelectedTool(name);
    setJsonInput(JSON.stringify(sampleArgs, null, 2));
    setExecOutput(null);
  };

  const handleExecute = async () => {
    setRunning(true);
    setExecOutput(null);
    try {
      const parsed = JSON.parse(jsonInput || '{}');
      const res = await adminFetchJson<{ latencyMs: number; result: unknown }>(
        '/mcp-tools/execute',
        token,
        {
          method: 'POST',
          body: JSON.stringify({ toolName: selectedTool, args: parsed }),
        },
      );
      setExecOutput({ latencyMs: res.latencyMs, result: res.result });
    } catch (err) {
      setExecOutput({ latencyMs: 0, error: (err as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const handleHealthProbe = async () => {
    setProbing(true);
    try {
      const res = await adminFetchJson<{
        results: Array<{
          name: string;
          tool: string;
          status: string;
          latencyMs: number;
          error?: string;
        }>;
      }>('/mcp-tools/health-check', token, { method: 'POST' });
      setHealthResults(res.results);
    } finally {
      setProbing(false);
    }
  };

  let outputText = '// Click "▶ Run Live MCP Tool" to inspect live clinical data output';
  if (execOutput?.error) {
    outputText = `ERROR: ${execOutput.error}`;
  } else if (execOutput) {
    outputText = JSON.stringify(execOutput.result, null, 2) ?? '';
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <div>
          <h2 className="text-base font-bold text-white">
            🛠️ 32-Tool Medical MCP Live Playground & Upstream Diagnostics
          </h2>
          <p className="text-xs text-slate-400">
            যেকোনো ক্লিনিক্যাল MCP টুল সরাসরি অ্যাডমিন প্যানেল থেকে লাইভ রান করে লেটেন্সি ও আউটপুট
            পরীক্ষা করুন
          </p>
        </div>
        <button
          type="button"
          disabled={probing}
          onClick={handleHealthProbe}
          className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500"
        >
          {probing ? '⏳ Probing Upstreams…' : '⚡ Run Live 6-Upstream Health Check'}
        </button>
      </div>

      {healthResults.length > 0 && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {healthResults.map((h) => (
            <div
              key={h.name}
              className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 text-xs"
            >
              <div>
                <div className="font-semibold text-slate-100">{h.name}</div>
                <div className="font-mono text-[11px] text-slate-400">{h.tool}</div>
              </div>
              <div className="text-right">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                    h.status === 'healthy'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  {h.status.toUpperCase()}
                </span>
                <div className="mt-1 font-mono text-[11px] text-cyan-300">{h.latencyMs} ms</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="max-h-[620px] space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/90 p-4 lg:col-span-5">
          {catalog?.groups.map((grp) => (
            <div key={grp.id}>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-emerald-400">
                {grp.label} ({grp.tools.length})
              </div>
              <div className="space-y-1">
                {grp.tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => handlePickTool(tool.name, tool.sampleArgs)}
                    className={`w-full rounded-lg border p-2.5 text-left transition ${
                      selectedTool === tool.name
                        ? 'border-emerald-500/60 bg-emerald-950/40'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-mono text-xs font-semibold text-slate-100">
                      {tool.name}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{tool.summary}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/90 p-5 lg:col-span-7">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-slate-400">Selected MCP Tool</span>
              <h3 className="font-mono text-base font-bold text-emerald-300">{selectedTool}</h3>
            </div>
            <button
              type="button"
              disabled={running}
              onClick={handleExecute}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-500"
            >
              {running ? '⏳ Executing…' : '▶ Run Live MCP Tool'}
            </button>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">JSON Arguments Payload</label>
            <textarea
              aria-label="MCP JSON Arguments"
              rows={6}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-cyan-200"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span>Live Execution Output</span>
              {execOutput && (
                <span className="font-mono text-emerald-400">
                  Latency: {execOutput.latencyMs} ms
                </span>
              )}
            </div>
            <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-slate-200">
              {outputText}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * MODULE 4: BANGLADESH FORMULARY & BDT PRICE INTELLIGENCE (24,725 BRANDS)
 * ========================================================================== */
export function BangladeshFormularyExplorer({ token }: { token?: string }) {
  const [summary, setSummary] = useState<FormularySummaryResponse | null>(null);
  const [query, setQuery] = useState('Bizoran');
  const [manufacturer, setManufacturer] = useState('');
  const [emlOnly, setEmlOnly] = useState(false);
  const [results, setResults] = useState<FormularySearchResponse | null>(null);

  useEffect(() => {
    adminFetchJson<FormularySummaryResponse>('/formulary', token)
      .then(setSummary)
      .catch(() => undefined);
  }, [token]);

  const runSearch = useCallback(
    async (qVal: string, mfrVal: string, emlVal: boolean) => {
      const params = new URLSearchParams({
        q: qVal,
        manufacturer: mfrVal,
        emlOnly: String(emlVal),
        limit: '35',
      });
      const res = await adminFetchJson<FormularySearchResponse>(
        `/formulary/search?${params.toString()}`,
        token,
      );
      setResults(res);
    },
    [token],
  );

  useEffect(() => {
    runSearch(query, manufacturer, emlOnly);
  }, [query, manufacturer, emlOnly, runSearch]);

  const quickQueries = [
    'Bizoran',
    'Sergel',
    'Napa Extend',
    'Clopid',
    'Monas',
    'Empagliflozin',
    'Cefixime',
    'Rosuvastatin',
  ];

  return (
    <div className="space-y-5">
      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {[
            ['BD Brand Medicines', summary.totalBrands.toLocaleString()],
            ['INN Generics', summary.totalGenerics.toLocaleString()],
            ['Pharmaceutical Mfrs', summary.totalManufacturers.toLocaleString()],
            ['Therapeutic Classes', summary.totalClasses.toLocaleString()],
            ['WHO 2025 EML Generics', summary.whoEmlGenerics.toLocaleString()],
            ['BD NEML Essential', summary.bdNemlGenerics.toLocaleString()],
          ].map(([label, val]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5">
              <div className="text-[11px] text-slate-400">{label}</div>
              <div className="mt-1 text-xl font-bold text-emerald-300">{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search & Filter Studio */}
      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            aria-label="Search Bangladesh Formulary"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any Bangladeshi brand or generic (e.g. Bizoran 5/20, Sergel 20, Napa Extend)…"
            className="min-w-[260px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white"
          />
          <select
            aria-label="Filter Manufacturer"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          >
            <option value="">All 387 Manufacturers</option>
            {summary?.topManufacturers.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} ({m.count})
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={emlOnly}
              onChange={(e) => setEmlOnly(e.target.checked)}
            />
            WHO / BD Essential Medicines Only
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {quickQueries.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setQuery(item)}
              className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[11px] text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            >
              🔎 {item}
            </button>
          ))}
        </div>
      </div>

      {/* Results Table + Cheapest Alternatives */}
      {results && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/90 p-4 xl:col-span-8">
            <h3 className="mb-3 text-sm font-semibold text-white">
              💊 Matched Brands ({results.totalMatches.toLocaleString()} matches)
            </h3>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2 pr-3">Brand & Strength</th>
                  <th className="py-2 pr-3">Generic (INN)</th>
                  <th className="py-2 pr-3">Manufacturer</th>
                  <th className="py-2 pr-3 text-right">Unit (৳)</th>
                  <th className="py-2 text-right">EML</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {results.items.map((row, idx) => (
                  <tr key={`${row.brand}-${row.strength}-${idx}`} className="hover:bg-slate-800/40">
                    <td className="py-2.5 pr-3">
                      <div className="font-semibold text-white">
                        {row.brand}{' '}
                        <span className="font-normal text-slate-400">{row.strength}</span>
                      </div>
                      <div className="text-[11px] text-slate-500">{row.dosageForm}</div>
                    </td>
                    <td className="py-2.5 pr-3 text-cyan-300">{row.generic}</td>
                    <td className="py-2.5 pr-3 text-slate-300">{row.manufacturer}</td>
                    <td className="py-2.5 pr-3 text-right font-mono font-bold text-emerald-300">
                      {row.unitPriceBdt != null ? `৳${row.unitPriceBdt.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right">
                      {row.whoEml && (
                        <span className="mr-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          WHO
                        </span>
                      )}
                      {row.bdNeml && (
                        <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-300">
                          BD
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-4 xl:col-span-4">
            <div className="rounded-xl border border-emerald-500/30 bg-slate-900/90 p-4">
              <h3 className="mb-2 text-sm font-semibold text-emerald-300">
                💰 Cheapest Same-Generic Alternatives in Bangladesh
              </h3>
              <div className="space-y-2">
                {results.cheapestAlternatives.map((alt, i) => (
                  <div
                    key={`${alt.brand}-${i}`}
                    className="flex items-center justify-between rounded-lg bg-slate-950/80 px-3 py-2 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-white">
                        {alt.brand} {alt.strength}
                      </div>
                      <div className="text-[11px] text-slate-400">{alt.manufacturer}</div>
                    </div>
                    <span className="font-mono font-bold text-emerald-400">
                      ৳{alt.unitPriceBdt?.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {summary && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
                <h3 className="mb-2.5 text-sm font-semibold text-white">
                  🏭 Top Pharmaceutical Manufacturers
                </h3>
                <div className="space-y-2">
                  {summary.topManufacturers.slice(0, 8).map((m) => (
                    <div key={m.name} className="text-xs">
                      <div className="flex justify-between text-slate-300">
                        <span>{m.name}</span>
                        <span className="font-mono">
                          {m.count} ({m.sharePct}%)
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-800">
                        <div
                          className="h-1.5 rounded-full bg-cyan-500"
                          style={{ width: `${Math.min(100, m.sharePct * 7)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * MODULE 5: CLINICAL TRIAGE, RED-FLAG & DETERMINISTIC CALCULATOR MONITOR
 * ========================================================================== */
export function ClinicalTriageSafetyMonitor({ token }: { token?: string }) {
  const [data, setData] = useState<TriageSafetyResponse | null>(null);
  const [cr, setCr] = useState('2.1');
  const [age, setAge] = useState('64');
  const [sex, setSex] = useState('male');
  const [calcOut, setCalcOut] = useState<unknown>(null);

  useEffect(() => {
    adminFetchJson<TriageSafetyResponse>('/triage-safety', token)
      .then(setData)
      .catch(() => undefined);
  }, [token]);

  const verifyEgfr = async () => {
    const res = await adminFetchJson<{ result: unknown }>('/mcp-tools/execute', token, {
      method: 'POST',
      body: JSON.stringify({
        toolName: 'clinical_calculator',
        args: {
          calculator: 'ckd_epi_2021',
          inputs: { creatinine_mg_dl: Number(cr), age: Number(age), sex },
        },
      }),
    });
    setCalcOut(res.result);
  };

  return (
    <div className="space-y-5">
      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ['Prompts Sampled', data.counts.totalScanned, 'text-white'],
            ['🚨 Emergency (classifier)', data.counts.emergency, 'text-rose-400'],
            ['⚠️ Urgent (classifier)', data.counts.urgent, 'text-amber-300'],
            ['✅ Routine (classifier)', data.counts.routine, 'text-sky-300'],
            ['— No triage decision', data.counts.unassessed, 'text-slate-300'],
          ].map(([label, val, color]) => (
            <div
              key={String(label)}
              className="rounded-xl border border-slate-800 bg-slate-900 p-4"
            >
              <div className="text-xs text-slate-400">{label}</div>
              <div className={`mt-1 text-2xl font-bold ${color}`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Deterministic MedCalc Verifier */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <h3 className="text-sm font-bold text-white">
          🧮 Live 2021 CKD-EPI eGFR Clinical Equation Verifier (Zero Mental-Math Error)
        </h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] text-slate-400">Serum Creatinine (mg/dL)</label>
            <input
              value={cr}
              onChange={(e) => setCr(e.target.value)}
              className="mt-1 w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400">Age (years)</label>
            <input
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400">Biological Sex</label>
            <select
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              className="mt-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
            >
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <button
            type="button"
            onClick={verifyEgfr}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            Compute Deterministic eGFR
          </button>
        </div>
        {calcOut != null && (
          <pre className="mt-3 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-emerald-300">
            {JSON.stringify(calcOut, null, 2)}
          </pre>
        )}
      </div>

      {/* Live Safety Surveillance Feed */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <h3 className="text-sm font-semibold text-white">🛡️ Persisted Triage Decisions</h3>
        <p className="mb-3 mt-1 text-[11px] leading-relaxed text-slate-400">
          {data?.notice ??
            'Severities are the decisions a triage classifier actually returned, read back from stored tool results. No wording in a message is matched against a word list; a row without a stored decision reads “not assessed”.'}
        </p>
        <div className="space-y-2.5">
          {data?.events.map((ev) => (
            <div
              key={ev.messageId}
              className="rounded-lg border border-slate-800 bg-slate-950/80 p-3.5 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={ev.severity} />
                  <span className="font-semibold text-cyan-300">{ev.specialty}</span>
                </div>
                <span className="text-slate-400">
                  {ev.userName} ({ev.userEmail})
                </span>
              </div>
              <p className="mt-2 text-slate-200">{ev.text}</p>
              {ev.flags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ev.flags.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300"
                    >
                      🔧 {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
