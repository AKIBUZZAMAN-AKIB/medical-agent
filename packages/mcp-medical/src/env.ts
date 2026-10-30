/**
 * Runtime configuration for the server, read once from the environment.
 *
 * Everything here is optional. The server is designed to be useful with no
 * configuration and no API keys: every upstream is a public, keyless endpoint,
 * and the optional keys only raise rate limits or unlock higher-volume tiers.
 */
export interface ServerEnv {
  /** Sent on every upstream request; several public APIs reject default agent strings. */
  userAgent: string;
  /** Per-request wall clock budget. */
  requestTimeoutMs: number;
  /** Total attempts per request, including the first. */
  maxAttempts: number;
  /** Default success-cache lifetime for a GET. */
  cacheTtlMs: number;
  /** Upper bound on cached responses held in memory. */
  cacheMaxEntries: number;
  /** Hard cap on characters returned to the model from one tool result. */
  maxResultChars: number;
  /**
   * Size of one disease_knowledge_search result in characters. That tool returns
   * every match in one result (full records for the top, one line for the rest)
   * and sizes itself to this budget instead of `maxResultChars`.
   */
  diseaseKbMaxChars?: number;
  /** Tool groups to expose, or null for all of them. */
  groups: Set<string> | null;
  /** Individual tool names to hide. */
  excludedTools: Set<string>;
  /** Optional NCBI key: raises E-utilities from 3 req/s to 10 req/s. */
  ncbiApiKey?: string;
  /** Optional openFDA key: raises the daily cap from 1,000 to 100,000 requests. */
  openfdaApiKey?: string;
  /** Contact address forwarded to NCBI, which asks API users to identify themselves. */
  contactEmail?: string;
}

const DEFAULTS = {
  userAgent:
    'LibreChat-MCP-Medical/0.1 (medical research lookup server for LibreChat; +https://librechat.ai)',
  requestTimeoutMs: 20_000,
  maxAttempts: 3,
  cacheTtlMs: 300_000,
  cacheMaxEntries: 500,
  maxResultChars: 24_000,
} as const;

type EnvSource = Record<string, string | undefined>;

function readInt(
  source: EnvSource,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[name];
  if (raw == null || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function readList(source: EnvSource, name: string): Set<string> | null {
  const raw = source[name];
  if (raw == null || raw.trim() === '' || raw.trim().toLowerCase() === 'all') {
    return null;
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

export function loadEnv(source: EnvSource = process.env): ServerEnv {
  return {
    userAgent: source.MEDICAL_USER_AGENT?.trim() || DEFAULTS.userAgent,
    requestTimeoutMs: readInt(
      source,
      'MEDICAL_REQUEST_TIMEOUT_MS',
      DEFAULTS.requestTimeoutMs,
      1_000,
      120_000,
    ),
    maxAttempts: readInt(source, 'MEDICAL_MAX_ATTEMPTS', DEFAULTS.maxAttempts, 1, 5),
    cacheTtlMs: readInt(source, 'MEDICAL_CACHE_TTL_MS', DEFAULTS.cacheTtlMs, 0, 3_600_000),
    cacheMaxEntries: readInt(
      source,
      'MEDICAL_CACHE_MAX_ENTRIES',
      DEFAULTS.cacheMaxEntries,
      1,
      10_000,
    ),
    maxResultChars: readInt(
      source,
      'MEDICAL_MAX_RESULT_CHARS',
      DEFAULTS.maxResultChars,
      1_000,
      400_000,
    ),
    diseaseKbMaxChars: readInt(source, 'MEDICAL_DISEASE_KB_MAX_CHARS', 160_000, 20_000, 350_000),
    groups: readList(source, 'MEDICAL_TOOL_GROUPS'),
    excludedTools: readList(source, 'MEDICAL_TOOL_EXCLUDE') ?? new Set<string>(),
    ncbiApiKey: source.NCBI_API_KEY?.trim() || undefined,
    openfdaApiKey: source.OPENFDA_API_KEY?.trim() || undefined,
    contactEmail: source.MEDICAL_CONTACT_EMAIL?.trim() || undefined,
  };
}
