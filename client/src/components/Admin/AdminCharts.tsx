/* eslint-disable i18next/no-literal-string -- Bangladesh-specific charts intentionally mix English labels with Bangla clinical context. */
import React, { useMemo, useState } from 'react';
import type { AdminAgentItem, DailySeriesPoint } from './types';

/**
 * Severity badge for a triage decision.
 *
 * Labels are the triage engine's own vocabulary and nothing else. They used to
 * read "HIGH · DENGUE / CRITICAL" and "MODERATE · PGX / RENAL" — condition names
 * hard-wired to a severity level, so the badge asserted a diagnosis the system
 * had never made. Severity is a rung on the escalation ladder, not a disease.
 */
export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    emergency: {
      label: '🚨 EMERGENCY — classifier decision',
      cls: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
    },
    urgent: {
      label: '⚠️ URGENT — assessment today',
      cls: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    },
    routine: {
      label: 'ROUTINE — classifier decision',
      cls: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
    },
    informational: {
      label: 'ℹ️ INFORMATIONAL',
      cls: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
    },
    none: {
      label: 'NONE — no signal returned',
      cls: 'border-slate-600/40 bg-slate-600/15 text-slate-300',
    },
    /** The classifier ran and could not decide. Not a clearance. */
    unknown: {
      label: '— UNDECIDED BY CLASSIFIER',
      cls: 'border-violet-500/40 bg-violet-500/15 text-violet-300',
    },
    /** No persisted decision exists at all. Never rendered as `routine`. */
    unassessed: {
      label: '— NOT ASSESSED',
      cls: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
    },
  };
  const item = map[severity] || map.unassessed;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${item.cls}`}
    >
      {item.label}
    </span>
  );
}
export function MultiSeriesAreaChart({ series }: { series: DailySeriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [metric, setMetric] = useState<'messages' | 'toolInvocations' | 'tokens'>('messages');

  const computed = useMemo(() => {
    const safe = series.length > 0 ? series : [];
    const maxVal = Math.max(1, ...safe.map((d) => d[metric]));
    const W = 680;
    const H = 190;
    const padX = 28;
    const padTop = 18;
    const padBottom = 28;
    const innerW = W - padX * 2;
    const innerH = H - padTop - padBottom;

    const pts = safe.map((d, idx) => {
      const x = safe.length <= 1 ? W / 2 : padX + (idx / (safe.length - 1)) * innerW;
      const y = padTop + innerH - (d[metric] / maxVal) * innerH;
      return { ...d, x, y };
    });

    const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area =
      pts.length >= 2
        ? `M ${pts[0].x.toFixed(1)} ${padTop + innerH} L ${pts
            .map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
            .join(' L ')} L ${pts[pts.length - 1].x.toFixed(1)} ${padTop + innerH} Z`
        : '';

    return { pts, line, area, maxVal, W, H, padTop, innerH };
  }, [series, metric]);

  const active = hoverIdx != null ? computed.pts[hoverIdx] : computed.pts[computed.pts.length - 1];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            📈 ক্লিনিক্যাল ট্রাফিক, MCP টুল কল ও টোকেন ট্রেন্ড (14-Day Telemetry)
          </h3>
          <p className="text-xs text-slate-400">
            প্রতিদিনের রোগীর মেসেজ, অটোমেটিক টুল/সাব-এজেন্ট কল এবং মোট টোকেন খরচ
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5 text-xs">
          {(
            [
              ['messages', 'Messages'],
              ['toolInvocations', 'MCP & Sub-Agent Calls'],
              ['tokens', 'Tokens'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMetric(key)}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                metric === key
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {active && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-slate-800 bg-slate-950/80 px-3.5 py-2 text-xs">
          <span className="font-mono text-emerald-400">{active.date}</span>
          <span className="text-slate-300">
            Messages: <strong className="text-white">{active.messages}</strong>
          </span>
          <span className="text-slate-300">
            Tool/Sub-Agent Calls:{' '}
            <strong className="text-cyan-300">{active.toolInvocations}</strong>
          </span>
          <span className="text-slate-300">
            Tokens: <strong className="text-violet-300">{active.tokens.toLocaleString()}</strong>
          </span>
          <span className="text-slate-300">
            Safety Alerts: <strong className="text-rose-300">{active.safetyAlerts}</strong>
          </span>
        </div>
      )}

      <div className="relative w-full overflow-hidden">
        <svg viewBox={`0 0 ${computed.W} ${computed.H}`} className="h-48 w-full">
          <defs>
            <linearGradient id="medAdminGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((step) => {
            const y = computed.padTop + computed.innerH * step;
            return (
              <line
                key={step}
                x1={24}
                x2={computed.W - 24}
                y1={y}
                y2={y}
                stroke="#1e293b"
                strokeDasharray="4 4"
              />
            );
          })}
          {computed.area && <path d={computed.area} fill="url(#medAdminGrad)" />}
          {computed.line && (
            <polyline
              fill="none"
              stroke="#10b981"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={computed.line}
            />
          )}
          {computed.pts.map((pt, idx) => (
            <g
              key={pt.date}
              className="cursor-pointer"
              onMouseEnter={() => setHoverIdx(idx)}
              onClick={() => setHoverIdx(idx)}
            >
              <rect x={pt.x - 16} y={0} width={32} height={computed.H} fill="transparent" />
              <circle
                cx={pt.x}
                cy={pt.y}
                r={hoverIdx === idx ? 5 : 3}
                fill={pt.safetyAlerts > 0 ? '#fb7185' : '#34d399'}
                stroke="#0f172a"
                strokeWidth="1.5"
              />
              {idx % 2 === 0 && (
                <text x={pt.x} y={computed.H - 6} textAnchor="middle" fill="#64748b" fontSize="10">
                  {pt.date.slice(5)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

const DONUT_PALETTE = [
  '#10b981',
  '#06b6d4',
  '#8b5cf6',
  '#f59e0b',
  '#f43f5e',
  '#3b82f6',
  '#14b8a6',
  '#eab308',
];

export function SpecialtyDonutChart({
  data,
}: {
  data: Array<{ specialty: string; count: number }>;
}) {
  const total = Math.max(
    1,
    data.reduce((s, d) => s + d.count, 0),
  );
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-100">
        🩺 ডিপার্টমেন্ট ও স্পেশালিটি বণ্টন (Clinical Domain Mix)
      </h3>
      <p className="mb-4 text-xs text-slate-400">
        রোগীদের প্রশ্ন অনুযায়ী কোন বিশেষজ্ঞ বিভাগ সবচেয়ে বেশি ব্যবহৃত হচ্ছে
      </p>
      {data.length === 0 ? (
        <div className="py-10 text-center text-xs text-slate-400">
          এখনো কোনো কনসাল্টেশন ডাটা নেই — System Ops থেকে Demo Cases যুক্ত করুন।
        </div>
      ) : (
        <div className="flex flex-col items-center gap-5 sm:flex-row">
          <svg viewBox="0 0 160 160" className="size-36 shrink-0">
            <circle cx="80" cy="80" r={radius} fill="none" stroke="#1e293b" strokeWidth="18" />
            {data.slice(0, 8).map((item, idx) => {
              const frac = item.count / total;
              const dash = frac * circumference;
              const offset = -cumulative * circumference;
              cumulative += frac;
              return (
                <circle
                  key={item.specialty}
                  cx="80"
                  cy="80"
                  r={radius}
                  fill="none"
                  stroke={DONUT_PALETTE[idx % DONUT_PALETTE.length]}
                  strokeWidth="18"
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={offset}
                  transform="rotate(-90 80 80)"
                />
              );
            })}
            <text x="80" y="76" textAnchor="middle" fill="#f8fafc" fontSize="18" fontWeight="700">
              {total}
            </text>
            <text x="80" y="94" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
              queries
            </text>
          </svg>
          <div className="grid w-full flex-1 grid-cols-1 gap-1.5 text-xs">
            {data.slice(0, 7).map((item, idx) => (
              <div
                key={item.specialty}
                className="flex items-center justify-between rounded-md bg-slate-950/60 px-2.5 py-1.5"
              >
                <span className="flex items-center gap-2 truncate text-slate-200">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: DONUT_PALETTE[idx % DONUT_PALETTE.length] }}
                  />
                  <span className="truncate">{item.specialty}</span>
                </span>
                <span className="ml-2 font-mono font-semibold text-slate-300">
                  {item.count} ({Math.round((item.count / total) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function OrchestrationTopologyGraph({
  agents,
  selectedId,
  onSelectAgent,
}: {
  agents: AdminAgentItem[];
  selectedId: string;
  onSelectAgent: (agent: AdminAgentItem) => void;
}) {
  const orchestrator = agents.find((a) => a.tier === 'orchestrator') || agents[0];
  const coreAgents = agents.filter((a) => a.tier === 'core_subagent');
  const dynAgents = agents.filter((a) => a.tier !== 'orchestrator' && a.tier !== 'core_subagent');

  const maxRows = Math.max(coreAgents.length, dynAgents.length, 4);
  const svgH = Math.max(300, maxRows * 46 + 44);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/95 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            🕸️ Live Multi-Agent Handoff Topology (Click Any Node to Inspect / Edit)
          </h3>
          <p className="text-xs text-slate-400">
            বাম দিকে চিফ অর্কেস্ট্রেটর → মাঝখানে ৭টি কোর সাব-এজেন্ট → ডান দিকে অন-ডিমান্ড তৈরি হওয়া
            ডায়নামিক সাব-এজেন্ট
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="flex items-center gap-1.5 text-emerald-300">
            <span className="size-2.5 rounded-full bg-emerald-400" /> Chief Orchestrator (1)
          </span>
          <span className="flex items-center gap-1.5 text-cyan-300">
            <span className="size-2.5 rounded-full bg-cyan-400" /> Core Specialists (
            {coreAgents.length})
          </span>
          <span className="flex items-center gap-1.5 text-violet-300">
            <span className="size-2.5 rounded-full bg-violet-400" /> Dynamic Spawned (
            {dynAgents.length})
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 920 ${svgH}`} className="w-full min-w-[760px]">
          {/* Edges from Orchestrator -> Core & Dynamic */}
          {coreAgents.map((ag, i) => {
            const y2 = 34 + i * 44;
            return (
              <path
                key={`edge-core-${ag.id}`}
                d={`M 235 ${svgH / 2} C 300 ${svgH / 2}, 305 ${y2}, 365 ${y2}`}
                fill="none"
                stroke={selectedId === ag.id ? '#34d399' : '#0ea5e9'}
                strokeOpacity={selectedId === ag.id ? 0.95 : 0.45}
                strokeWidth={selectedId === ag.id ? 2.4 : 1.4}
              />
            );
          })}
          {dynAgents.map((ag, i) => {
            const y2 = 34 + i * 44;
            return (
              <path
                key={`edge-dyn-${ag.id}`}
                d={`M 235 ${svgH / 2} C 430 ${svgH / 2}, 545 ${y2}, 650 ${y2}`}
                fill="none"
                stroke="#a78bfa"
                strokeDasharray="5 3"
                strokeOpacity={selectedId === ag.id ? 1 : 0.65}
                strokeWidth={selectedId === ag.id ? 2.5 : 1.6}
              />
            );
          })}

          {/* Orchestrator Node */}
          {orchestrator && (
            <g className="cursor-pointer" onClick={() => onSelectAgent(orchestrator)}>
              <rect
                x={18}
                y={svgH / 2 - 34}
                width={217}
                height={68}
                rx={12}
                fill="#064e3b"
                stroke={selectedId === orchestrator.id ? '#6ee7b7' : '#10b981'}
                strokeWidth={selectedId === orchestrator.id ? 2.6 : 1.6}
              />
              <text x={32} y={svgH / 2 - 8} fill="#ecfdf5" fontSize="12" fontWeight="700">
                🩺 Super-Power Doctor AI
              </text>
              <text x={32} y={svgH / 2 + 10} fill="#6ee7b7" fontSize="10">
                Chief Orchestrator · {orchestrator.tools.length} tools
              </text>
              <text x={32} y={svgH / 2 + 24} fill="#a7f3d0" fontSize="9.5">
                {coreAgents.length + dynAgents.length} active specialist handoffs
              </text>
            </g>
          )}

          {/* Core Sub-Agents */}
          {coreAgents.map((ag, i) => {
            const y = 16 + i * 44;
            const active = selectedId === ag.id;
            return (
              <g key={ag.id} className="cursor-pointer" onClick={() => onSelectAgent(ag)}>
                <rect
                  x={365}
                  y={y}
                  width={250}
                  height={36}
                  rx={8}
                  fill={active ? '#0c4a6e' : '#0f172a'}
                  stroke={active ? '#38bdf8' : '#1e3a8a'}
                  strokeWidth={active ? 2 : 1.2}
                />
                <text x={377} y={y + 16} fill="#e0f2fe" fontSize="10.5" fontWeight="600">
                  {ag.name.length > 33 ? `${ag.name.slice(0, 32)}…` : ag.name}
                </text>
                <text x={377} y={y + 29} fill="#7dd3fc" fontSize="9">
                  {ag.id} · {ag.tools.length} MCP tools
                </text>
              </g>
            );
          })}

          {/* Dynamic Sub-Agents */}
          {dynAgents.length === 0 ? (
            <g>
              <rect
                x={650}
                y={svgH / 2 - 32}
                width={252}
                height={64}
                rx={10}
                fill="#1e1b4b"
                stroke="#6366f1"
                strokeDasharray="4 4"
              />
              <text x={776} y={svgH / 2 - 4} textAnchor="middle" fill="#c7d2fe" fontSize="11">
                No Dynamic Sub-Agents Spawned Yet
              </text>
              <text x={776} y={svgH / 2 + 14} textAnchor="middle" fill="#a5b4fc" fontSize="9.5">
                Spawn 1-click below or ask in Patient Chat!
              </text>
            </g>
          ) : (
            dynAgents.map((ag, i) => {
              const y = 16 + i * 44;
              const active = selectedId === ag.id;
              return (
                <g key={ag.id} className="cursor-pointer" onClick={() => onSelectAgent(ag)}>
                  <rect
                    x={650}
                    y={y}
                    width={254}
                    height={36}
                    rx={8}
                    fill={active ? '#3b0764' : '#1e1b4b'}
                    stroke={active ? '#e879f9' : '#8b5cf6'}
                    strokeWidth={active ? 2.2 : 1.3}
                  />
                  <text x={662} y={y + 16} fill="#f5d0fe" fontSize="10.5" fontWeight="600">
                    ⚡ {ag.name.length > 31 ? `${ag.name.slice(0, 30)}…` : ag.name}
                  </text>
                  <text x={662} y={y + 29} fill="#c4b5fd" fontSize="9">
                    {ag.id} · Dynamic Specialist ({ag.tools.length} tools)
                  </text>
                </g>
              );
            })
          )}
        </svg>
      </div>
    </div>
  );
}
