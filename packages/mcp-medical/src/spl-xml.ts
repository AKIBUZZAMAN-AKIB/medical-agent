import { decodeEntities } from './pubmed-xml.js';

/**
 * Minimal reader for DailyMed SPL (Structured Product Label) XML.
 *
 * Only the top-level label sections are extracted, keyed by the section's
 * LOINC-coded `displayName` (for example `INDICATIONS & USAGE SECTION`). The
 * document is a deeply nested HL7 v3 tree; a full parser would buy nothing here
 * because a label is read by section name and nothing else.
 */
export interface SplSection {
  /** Section name as the labeler publishes it, e.g. `DRUG INTERACTIONS`. */
  name: string;
  /** Section code, when present, e.g. `34066-2`. */
  code?: string;
  /** Section body as plain text, with nested subsections inlined. */
  text: string;
}

const SECTION_TOKEN = /<section(?:\s[^>]*)?>|<\/section>/g;

interface Range {
  start: number;
  end: number;
  depth: number;
}

/** Locates every `<section>` block with its nesting depth. */
function findSections(xml: string): Range[] {
  const ranges: Range[] = [];
  const open: number[] = [];
  for (const match of xml.matchAll(SECTION_TOKEN)) {
    if (match[0] === '</section>') {
      const start = open.pop();
      if (start != null) {
        ranges.push({ start, end: match.index, depth: open.length + 1 });
      }
    } else {
      open.push(match.index);
    }
  }
  return ranges;
}

function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1] == null ? undefined : decodeEntities(match[1]);
}

function firstCodeDisplayName(fragment: string): { code?: string; displayName?: string } {
  const match = /<code\b([^>]*)\/>/.exec(fragment);
  if (match?.[1] == null) {
    return {};
  }
  return {
    code: attributeOf(match[1], 'code'),
    displayName: attributeOf(match[1], 'displayName'),
  };
}

function sectionText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** Returns the top-level label sections of an SPL document. */
export function extractSplSections(xml: string): SplSection[] {
  const sections: SplSection[] = [];
  for (const range of findSections(xml)) {
    if (range.depth !== 1) {
      continue;
    }
    const fragment = xml.slice(range.start, range.end);
    const head = fragment.slice(0, 1_200);
    const { code, displayName } = firstCodeDisplayName(head);
    const name = displayName ?? code;
    const text = sectionText(fragment);
    if (name == null || text.length === 0) {
      continue;
    }
    sections.push({ name, code, text });
  }
  return sections;
}

/** Case- and punctuation-insensitive key for matching a requested section name. */
export function normalizeSectionName(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Finds the section whose name contains `wanted`, preferring the closest match. */
export function findSplSection(sections: SplSection[], wanted: string): SplSection | undefined {
  const target = normalizeSectionName(wanted);
  let best: { section: SplSection; score: number } | undefined;
  for (const section of sections) {
    const name = normalizeSectionName(section.name);
    if (!name.includes(target)) {
      continue;
    }
    const score = Math.abs(name.length - target.length);
    if (best == null || score < best.score) {
      best = { section, score };
    }
  }
  return best?.section;
}
