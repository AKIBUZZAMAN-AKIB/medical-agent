import type { ServerEnv } from './env.js';

/** An upstream a result was derived from, rendered so the model can cite it. */
export interface SourceRef {
  /** Service name as the citation should read, e.g. `PubMed`. */
  name: string;
  /** Human-facing landing page for the specific record or query. */
  url: string;
  /** Optional qualifier, e.g. `keyless tier, 429-prone`. */
  note?: string;
}

export interface ToolOutput {
  text: string;
  /** Marks a failure the model should report rather than paper over. */
  isError?: boolean;
}

export interface ComposeInput {
  /** One line naming what was looked up and what came back. */
  headline: string;
  /** Free-form body blocks, already formatted. */
  sections?: string[];
  sources: SourceRef[];
  /** Caveats the model must carry into its answer, not silently drop. */
  notices?: string[];
  env: ServerEnv;
}

const TRUNCATION_NOTICE =
  '[truncated: the full record set is longer than the result budget for one tool call — narrow the query or raise MEDICAL_MAX_RESULT_CHARS]';

/** Formats a bullet list, skipping empty entries so gaps never read as data. */
export function bulletList(items: unknown[]): string {
  const kept = items
    .map((item) => stringifyValue(item))
    .map((item) => item.replace(/\s*\n\s*/g, ' ').trim())
    .filter((item) => item.length > 0);
  if (kept.length === 0) {
    return '';
  }
  return kept.map((item) => `- ${item}`).join('\n');
}

/**
 * Renders an upstream value as one line of text. Loosely typed JSON upstreams
 * hand back numbers, booleans, and objects, and a field that exists but is
 * unusable must read as absent rather than as `undefined` in a citation.
 */
export function stringifyValue(value: unknown): string {
  if (value == null || value === false) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** `label: value` pairs, dropping anything the upstream left empty. */
export function definitionList(entries: Array<[string, unknown]>): string {
  const lines: string[] = [];
  for (const [label, value] of entries) {
    const text = stringifyValue(value)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (text.length === 0 || text === 'undefined' || text === 'null') {
      continue;
    }
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

export function heading(text: string): string {
  return `${text}\n${'-'.repeat(Math.min(text.length, 80))}`;
}

export function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value == null || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Collapses upstream whitespace without destroying paragraph boundaries. */
export function normalizeText(value: string | null | undefined): string {
  if (value == null) {
    return '';
  }
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Returns a readable single-line excerpt, for previews and list rows. */
export function excerpt(value: unknown, max = 320): string {
  const text = normalizeText(stringifyValue(value)).replace(/\s+/g, ' ');
  if (text.length === 0) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatSources(sources: SourceRef[]): string {
  const unique = new Map<string, SourceRef>();
  for (const source of sources) {
    if (source.url.length === 0) {
      continue;
    }
    unique.set(`${source.name}|${source.url}`, source);
  }
  if (unique.size === 0) {
    return '';
  }
  const lines = [...unique.values()].map(
    (source) => `- ${source.name}: ${source.url}${source.note ? ` (${source.note})` : ''}`,
  );
  return `Sources:\n${lines.join('\n')}`;
}

/**
 * Assembles a tool result: headline, sections, caveats, citations, and a hard
 * character budget.
 *
 * The budget is applied to the body alone. Caveats and citations are the parts a
 * model must not lose — a truncated answer with no visible source reads as
 * complete and unsourced — so they are reserved first and the body is cut to
 * whatever remains, always leaving an explicit truncation marker.
 */
export function composeResult({
  headline,
  sections = [],
  sources,
  notices = [],
  env,
}: ComposeInput): ToolOutput {
  const body = [
    headline,
    ...sections.map((section) => section.trim()).filter((section) => section.length > 0),
  ];

  const tail: string[] = [];
  if (notices.length > 0) {
    tail.push(`Caveats:\n${notices.map((notice) => `- ${notice}`).join('\n')}`);
  }
  const sourceBlock = formatSources(sources);
  if (sourceBlock.length > 0) {
    tail.push(sourceBlock);
  }

  let text = [...body, ...tail].join('\n\n');
  if (text.length <= env.maxResultChars) {
    return { text };
  }

  /** Over-long caveats and source lists are the one case where dropping detail is worse than cutting body. */
  const mandatory = tail.join('\n\n');
  const reserved = Math.min(mandatory.length + TRUNCATION_NOTICE.length + 2, env.maxResultChars);
  const bodyBudget = Math.max(0, env.maxResultChars - reserved - 2);
  const kept: string[] = [];
  let used = 0;
  for (const part of body) {
    if (used + part.length > bodyBudget) {
      break;
    }
    kept.push(part);
    used += part.length + 2;
  }
  const tailText =
    mandatory.length + TRUNCATION_NOTICE.length + 2 > env.maxResultChars ? '' : mandatory;
  text = [...kept, tailText, TRUNCATION_NOTICE].filter((part) => part.length > 0).join('\n\n');
  return { text };
}

export function errorResult(message: string): ToolOutput {
  return { text: message, isError: true };
}
