import type { ToolSpec } from '../types.js';
import type { ServerEnv } from '../env.js';
import { pharmacogenomicsTools } from './pharmacogenomics.js';
import { orchestrationTools } from './orchestration.js';
import { epidemiologyTools } from './epidemiology.js';
import { calculatorTools } from './calculators.js';
import { literatureTools } from './literature.js';
import { conditionTools } from './conditions.js';
import { formularyTools } from './formulary.js';
import { clinicalTools } from './clinical.js';
import { deviceTools } from './devices.js';
import { emergencyTools } from './emergency.js';
import { trialTools } from './trials.js';
import { drugTools } from './drugs.js';

/**
 * Every tool the server can publish, in the order a model should prefer them:
 * screen for an emergency before anything else, then resolve regional/brand
 * formulary & identifiers, compute exact clinical/lab math, check
 * pharmacogenomics and authoritative labels, read primary evidence, and
 * orchestrate specialized sub-agents when multi-system reasoning is needed.
 */
export const allTools: ToolSpec[] = [
  ...emergencyTools,
  ...formularyTools,
  ...drugTools,
  ...pharmacogenomicsTools,
  ...calculatorTools,
  ...literatureTools,
  ...conditionTools,
  ...trialTools,
  ...epidemiologyTools,
  ...deviceTools,
  ...clinicalTools,
  ...orchestrationTools,
];

/**
 * Tools an operator may not remove.
 *
 * Every other tool can be dropped by group or by name, because a deployment on a
 * small model may legitimately want a shorter catalogue. The emergency screen is
 * not that kind of tool: a configuration that silently switches off the only
 * deterministic safety check in the system is a configuration nobody audits. It
 * stays, and `MEDICAL_TOOL_EXCLUDE=emergency_triage_check` is ignored rather
 * than honoured.
 */
export const safetyToolNames: ReadonlySet<string> = new Set(
  emergencyTools.map((tool) => tool.name),
);

/**
 * Applies the operator's tool selection. Groups narrow the catalogue for small
 * models that are degraded by a long tool list; `MEDICAL_TOOL_EXCLUDE` removes
 * individual tools without splitting the groups around them. The safety floor
 * survives both.
 */
export function selectTools(env: ServerEnv, tools: ToolSpec[] = allTools): ToolSpec[] {
  return tools.filter((tool) => {
    if (safetyToolNames.has(tool.name)) {
      return true;
    }
    if (env.excludedTools.has(tool.name.toLowerCase())) {
      return false;
    }
    return env.groups == null || env.groups.has(tool.group);
  });
}

export function describeToolGroups(tools: ToolSpec[] = allTools): string {
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const names = groups.get(tool.group) ?? [];
    names.push(tool.name);
    groups.set(tool.group, names);
  }
  return [...groups.entries()].map(([group, names]) => `${group}: ${names.join(', ')}`).join('\n');
}
