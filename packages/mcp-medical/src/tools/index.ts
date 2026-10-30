import type { ToolSpec } from '../types.js';
import type { ServerEnv } from '../env.js';
import { pharmacogenomicsTools } from './pharmacogenomics.js';
import { diseaseKnowledgeTools } from './diseaseKnowledge.js';
import { orchestrationTools } from './orchestration.js';
import { epidemiologyTools } from './epidemiology.js';
import { calculatorTools } from './calculators.js';
import { literatureTools } from './literature.js';
import { conditionTools } from './conditions.js';
import { formularyTools } from './formulary.js';
import { clinicalTools } from './clinical.js';
import { deviceTools } from './devices.js';
import { trialTools } from './trials.js';
import { drugTools } from './drugs.js';

/**
 * Every tool the server can publish, in the order a model should prefer them:
 * resolve regional/brand formulary & identifiers, compute exact clinical/lab math, check
 * pharmacogenomics and authoritative labels, read primary evidence, and
 * orchestrate specialized sub-agents when multi-system reasoning is needed.
 */
export const allTools: ToolSpec[] = [
  ...formularyTools,
  ...drugTools,
  ...pharmacogenomicsTools,
  ...calculatorTools,
  ...diseaseKnowledgeTools,
  ...literatureTools,
  ...conditionTools,
  ...trialTools,
  ...epidemiologyTools,
  ...deviceTools,
  ...clinicalTools,
  ...orchestrationTools,
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
