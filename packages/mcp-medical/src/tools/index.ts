import type { ServerEnv } from '../env.js';
import { clinicalTools } from './clinical.js';
import { conditionTools } from './conditions.js';
import { deviceTools } from './devices.js';
import { drugTools } from './drugs.js';
import { epidemiologyTools } from './epidemiology.js';
import { literatureTools } from './literature.js';
import { trialTools } from './trials.js';
import type { ToolSpec } from '../types.js';

/**
 * Every tool the server can publish, in the order a model should prefer them:
 * identify the entity, then read the authoritative record, then look for
 * evidence, then population context.
 */
export const allTools: ToolSpec[] = [
  ...literatureTools,
  ...drugTools,
  ...conditionTools,
  ...trialTools,
  ...epidemiologyTools,
  ...deviceTools,
  ...clinicalTools,
];

/**
 * Applies the operator's tool selection. Groups narrow the catalogue for small
 * models that are degraded by a long tool list; `MEDICAL_TOOL_EXCLUDE` removes
 * individual tools without splitting the groups around them.
 */
export function selectTools(env: ServerEnv, tools: ToolSpec[] = allTools): ToolSpec[] {
  return tools.filter((tool) => {
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
