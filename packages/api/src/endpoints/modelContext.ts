import fs from 'fs';
import { logger } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types';

/**
 * Resolves a model's REAL context window from provider metadata instead of a
 * predefined number. Sources, first hit wins:
 *  1. the endpoint's token config (admin `tokenConfig`, or the context_length
 *     LibreChat already fetched from an OpenRouter-style model list);
 *  2. the model-context file (`MODEL_CONTEXT_FILE`), written from the
 *     providers' live model lists (e.g. ~/kilo-router/model_context.py, which
 *     also knows which real models sit behind a router alias such as
 *     `kilo/free-pool` and takes the smallest of their windows);
 *  3. the endpoint's own live `GET {baseURL}/models` list, when it reports
 *     context_length / context_window / max_input_tokens.
 * Returns `undefined` when no source knows the model; the caller decides.
 */
export interface ResolvedContextWindow {
  contextTokens: number;
  maxOutputTokens?: number;
  source: string;
}

type ContextEntry = { contextTokens: number; maxOutputTokens?: number };

const LIVE_TTL_MS = 10 * 60 * 1000;
const LIVE_FAIL_TTL_MS = 60 * 1000;
const LIVE_TIMEOUT_MS = 5000;

let fileCache: { path: string; mtimeMs: number; models: Record<string, ContextEntry> } | undefined;
const liveCache = new Map<string, { at: number; ttl: number; models: Record<string, ContextEntry> }>();

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Context window + max output from one model-list entry, provider-agnostic. */
export function contextFromModelEntry(entry: Record<string, unknown>): ContextEntry | undefined {
  const top = (entry.top_provider ?? {}) as Record<string, unknown>;
  let window = entry.context_window as unknown;
  if (window != null && typeof window === 'object') {
    window = (window as Record<string, unknown>).tokens;
  }
  const contextTokens =
    positiveInt(top.context_length) ??
    positiveInt(entry.context_length) ??
    positiveInt(window) ??
    positiveInt(entry.max_input_tokens) ??
    positiveInt(entry.max_context_length);
  if (contextTokens == null) {
    return undefined;
  }
  const maxOutputTokens =
    positiveInt(top.max_completion_tokens) ??
    positiveInt(entry.max_completion_tokens) ??
    positiveInt(entry.max_output_tokens);
  return { contextTokens, maxOutputTokens };
}

function readContextFile(): Record<string, ContextEntry> | undefined {
  const path = process.env.MODEL_CONTEXT_FILE;
  if (!path) {
    return undefined;
  }
  try {
    const { mtimeMs } = fs.statSync(path);
    if (fileCache && fileCache.path === path && fileCache.mtimeMs === mtimeMs) {
      return fileCache.models;
    }
    const doc = JSON.parse(fs.readFileSync(path, 'utf8')) as { models?: Record<string, unknown> };
    const models: Record<string, ContextEntry> = {};
    for (const [id, raw] of Object.entries(doc.models ?? {})) {
      const parsed = raw && typeof raw === 'object' ? contextFromModelEntry(raw as Record<string, unknown>) : undefined;
      if (parsed) {
        models[id] = parsed;
      }
    }
    fileCache = { path, mtimeMs, models };
    logger.info(`[modelContext] Loaded real context windows for ${Object.keys(models).length} models from ${path}`);
    return models;
  } catch (error) {
    logger.warn(`[modelContext] Could not read MODEL_CONTEXT_FILE ${path}: ${(error as Error).message}`);
    return fileCache?.models;
  }
}

async function readLiveModels(baseURL: string, apiKey?: string): Promise<Record<string, ContextEntry>> {
  const key = baseURL.replace(/\/+$/, '');
  const cached = liveCache.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) {
    return cached.models;
  }
  const models: Record<string, ContextEntry> = {};
  let ttl = LIVE_TTL_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${key}/models`, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: unknown[] } | unknown[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const entry = item as Record<string, unknown>;
      const id = (entry.id ?? entry.name) as string | undefined;
      const parsed = id ? contextFromModelEntry(entry) : undefined;
      if (id && parsed) {
        models[id] = parsed;
      }
    }
  } catch (error) {
    ttl = LIVE_FAIL_TTL_MS;
    logger.debug(`[modelContext] Live model list unavailable at ${key}/models: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  liveCache.set(key, { at: Date.now(), ttl, models });
  return models;
}

export async function resolveModelContextWindow(params: {
  model: string;
  baseURL?: string | null;
  apiKey?: string;
  endpointTokenConfig?: EndpointTokenConfig;
  /** False when the base URL is user-supplied: never query it. */
  allowLiveLookup?: boolean;
}): Promise<ResolvedContextWindow | undefined> {
  const { model, baseURL, apiKey, endpointTokenConfig, allowLiveLookup = true } = params;
  if (!model) {
    return undefined;
  }

  const configured = positiveInt(endpointTokenConfig?.[model]?.context);
  if (configured != null) {
    return { contextTokens: configured, source: 'endpoint token config' };
  }

  const fromFile = readContextFile()?.[model];
  if (fromFile) {
    return { ...fromFile, source: `model context file (${process.env.MODEL_CONTEXT_FILE})` };
  }

  if (allowLiveLookup && baseURL) {
    const live = (await readLiveModels(baseURL, apiKey))[model];
    if (live) {
      return { ...live, source: `live model list (${baseURL.replace(/\/+$/, '')}/models)` };
    }
  }
  return undefined;
}
