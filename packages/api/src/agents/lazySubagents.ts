import { createHash } from 'crypto';
import type { Agent, AgentUpdateParams } from 'librechat-data-provider';

/**
 * The fields whose value is part of a lazy sub-agent's descriptor identity.
 *
 * This used to be a hand-written `Pick<Agent, ...>`, and like every hand-written
 * list of "things that matter" it went stale. `memory_scope` was added to it, but
 * the two fields introduced alongside it — `memory_policy` and `memory_profiles`
 * — were not, even though both change what `initializeAgent` produces: the policy
 * selects which memory-usage guard is appended to the instructions
 * (`initialize.ts:2123`) and the profile flag decides whether the memory tools
 * take a `profile` argument, whether the profile tools are registered at all, and
 * which guard text is appended (`initialize.ts:2113`, `2130-2137`). A descriptor
 * built before such an edit and initialised after it would pass the drift check
 * at `initialize.js:1246` — the check whose entire purpose is to catch exactly
 * that — and run with two different notions of the agent's memory behaviour.
 *
 * The list is therefore no longer the source of truth. `AgentUpdateParams` in
 * `librechat-data-provider` is: it is the API's own declaration of which agent
 * fields an editor may change, so any field in it can drift between descriptor
 * construction and initialisation. The assertion below makes that binding
 * mechanical — adding an updatable field upstream without fingerprinting it is a
 * compile error, not a silent hole.
 *
 * `endpoint`, `additional_instructions`, `actions` and `mcpServerNames` are
 * fingerprint inputs that are not part of the update payload; they are listed
 * explicitly because they also reach the initializer.
 */
export const LAZY_SUBAGENT_CONFIG_FIELDS = [
  // Everything the agent editor may change (see the exhaustiveness assertion).
  'name',
  'description',
  'avatar',
  'instructions',
  /** A create/update payload field, not a persisted one: it is folded into
   *  `tool_resources` before it is stored, so on a loaded agent it is always
   *  absent and contributes nothing. Listed because the exhaustiveness check
   *  is about the API's declaration, not about what a document happens to hold. */
  'file_ids',
  'tools',
  'tool_resources',
  'provider',
  'model',
  'model_parameters',
  'agent_ids',
  'edges',
  'end_after_tools',
  'hide_sequential_outputs',
  'stateful_code_sessions',
  'stateful_code_environment',
  'code_environment_id',
  'git_identity',
  'code_workspace_id',
  'repositoryInstructions',
  'artifacts',
  'recursion_limit',
  'category',
  'support_contact',
  'tool_options',
  'skills',
  'skills_enabled',
  'skill_authoring_enabled',
  'skills_scope',
  'subagents',
  'memory_scope',
  'memory_policy',
  'memory_profiles',
  // Inputs that reach the initializer but are not part of `AgentUpdateParams`:
  // they are set by tool/MCP configuration rather than by the agent editor, and
  // `tool_kwargs` in particular carries the per-tool token budget.
  'id',
  'endpoint',
  'additional_instructions',
  'tool_kwargs',
  'actions',
  'mcpServerNames',
] as const;

export type LazySubagentConfigField = (typeof LAZY_SUBAGENT_CONFIG_FIELDS)[number];

type VersionedAgent = Partial<Agent> &
  Partial<Record<LazySubagentConfigField, unknown>> & {
    version?: number;
    actions?: string[];
    mcpServerNames?: string[];
  };

/**
 * Compile-time exhaustiveness: every field the API lets an editor change must be
 * part of the fingerprint. If upstream adds one to `AgentUpdateParams` and this
 * file does not list it, `Covered` is not `never` and the assignment below fails
 * to typecheck.
 */
type UpdatableAgentField = keyof AgentUpdateParams;
type UncoveredUpdatableField = Exclude<UpdatableAgentField, LazySubagentConfigField>;
const _everyUpdatableFieldIsFingerprinted: UncoveredUpdatableField extends never
  ? true
  : UncoveredUpdatableField = true;
void _everyUpdatableFieldIsFingerprinted;

const sensitiveKeyPattern =
  /(?:^|[_-])(?:api[_-]?key|authorization|credentials?|password|secret|(?:access|refresh|id|auth)?[_-]?token)(?:$|[_-])/i;

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value !== 'object') {
    return 'null';
  }

  const entries = Object.entries(value)
    .filter(([key, entry]) => !isSensitiveKey(key) && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
}

/**
 * Returns only persisted fields that can change the initialized child graph.
 * `name` and `description` are intentionally included because they are
 * advertised to the parent model; request state, ACL-only display fields, and
 * secret values are excluded.
 */
export function selectLazySubagentConfig(agent: VersionedAgent): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of LAZY_SUBAGENT_CONFIG_FIELDS) {
    config[field] = agent[field];
  }
  return config;
}

/** Deterministic descriptor identity for a persisted lazy subagent. */
export function getLazySubagentConfigId(agent: VersionedAgent): string {
  const version =
    agent.version != null && Number.isInteger(agent.version) && agent.version >= 0
      ? agent.version
      : 0;
  const fingerprint = createHash('sha256')
    .update(canonicalize(selectLazySubagentConfig(agent)))
    .digest('hex');
  return `${agent.id}:${version}:${fingerprint}`;
}
