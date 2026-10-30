import { z } from 'zod';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { composeResult, definitionList, heading, type SourceRef } from '../format.js';
import { hasBangla, lexiconTerms } from './diseaseLexicon.js';
import { defineTool } from '../types.js';

/**
 * `disease_knowledge_search` — keyword lookup over the whole local "Global
 * Disease Master Chart" dataset (every snapshot workbook and every name list in
 * data/disease-kb/source/, built by scripts/build_disease_kb.py).
 *
 *  1. The model passes keywords (disease names, symptoms, causes; English,
 *     Bangla or Banglish). Bangla/Banglish keywords are also read through the
 *     lexicon (diseaseLexicon.ts) as English phrases.
 *  2. EVERY record that contains any keyword as a whole word or phrase, in any
 *     field (name, alternative names, symptoms, causes, risk factors, ...), is
 *     returned with every field. There is no top-k: results are paged, and each
 *     page says how to fetch the next one.
 *  3. After the keyword matches come workbook rows from the other sheets
 *     (categories, source register, QC, read me) that contain a keyword, then a
 *     few semantic neighbours found with the medtools embeddings and reranker
 *     that did not match a keyword.
 *
 * The keyword order is deterministic, so paging is stable. Any medtools failure
 * only drops the semantic extras; it never fails the call.
 */

interface DiseaseRecord {
  key: string;
  id: string;
  name: string;
  raw_name?: string;
  alt: string[];
  name_only: boolean;
  category?: string;
  subcategory?: string;
  definition?: string;
  symptoms?: string[];
  other_signs?: string;
  causes?: string;
  risk_factors?: string;
  transmission?: string;
  age_group?: string;
  severity?: string;
  warning_signs?: string;
  diagnosis?: string;
  prevention_management?: string;
  source_name?: string;
  source_url?: string;
  source_is_homepage?: boolean;
  verification?: string;
  reviewed?: string;
  terse?: boolean;
  versions?: string[];
  superseded?: boolean;
  superseded_by?: string;
  realigned?: string;
  extra_cells?: string[];
  same_name_as?: string[];
  name_lines?: string[];
  name_list_file?: string;
}

interface SheetRow {
  kind: string;
  sheet: string;
  cells: string[];
  versions: string[];
}

interface KnowledgeBaseFile {
  dataset: string;
  version: string;
  built: string;
  dim: number | null;
  stats?: Record<string, unknown>;
  records: DiseaseRecord[];
  sheet_rows?: SheetRow[];
  vectors: Array<{ s: number; q: string }> | null;
}

/** Searchable fields, in the order a match is reported. */
const FIELDS: Array<[keyof DiseaseRecord | 'names', string]> = [
  ['names', 'name'],
  ['category', 'category'],
  ['subcategory', 'subcategory'],
  ['definition', 'definition'],
  ['symptoms', 'symptoms'],
  ['other_signs', 'other signs'],
  ['causes', 'causes'],
  ['risk_factors', 'risk factors'],
  ['transmission', 'transmission'],
  ['age_group', 'age group'],
  ['severity', 'severity'],
  ['warning_signs', 'warning signs'],
  ['diagnosis', 'diagnosis'],
  ['prevention_management', 'prevention/management'],
  ['source_name', 'source'],
  ['extra_cells', 'extra cells'],
];

interface LoadedKb {
  file: KnowledgeBaseFile;
  vectors: Int8Array[] | null;
  scales: number[];
  /** Per record: normalized " tok tok " text per searchable field. */
  fieldText: string[][];
  /** Per record: normalized full names (name, raw name, alternatives, name lines). */
  nameSet: Set<string>[];
  sheetText: string[];
}

const KB_FILE = 'disease-kb/disease-kb.json.gz';
let cached: LoadedKb | null = null;

/** Keywords that would match nearly every record; they are skipped with a notice. */
const TOO_GENERIC = new Set(
  (
    'disease diseases disorder disorders illness condition conditions symptom symptoms sign signs ' +
    'cause causes treatment treatments problem problems syndrome infection infections health medical ' +
    'the a an of and or in on to for with what is are ki rog rogh oshukh osukh ' +
    'patient patients people person human'
  ).split(' '),
);

/**
 * Lower-case, strip Latin accents, keep letters/digits as words (Bangla vowel
 * signs and the virama are marks, so they stay inside the word), singularize
 * plain plurals.
 */
export function normalizeText(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w));
  return words.length ? ` ${words.join(' ')} ` : '';
}

function fieldValue(r: DiseaseRecord, f: keyof DiseaseRecord | 'names'): string {
  if (f === 'names') {
    return [r.name, r.raw_name ?? '', ...(r.alt ?? []), ...(r.name_lines ?? [])].join(' ; ');
  }
  const v = r[f];
  if (Array.isArray(v)) return v.join(' ; ');
  return typeof v === 'string' ? v : '';
}

function resolveKbPath(): string | null {
  const override = process.env.DISEASE_KB_PATH;
  const candidates = [
    override ?? '',
    process.argv[1] ? resolve(dirname(process.argv[1]), '../data', KB_FILE) : '',
    resolve(process.cwd(), 'data', KB_FILE),
    resolve(process.cwd(), 'packages/mcp-medical/data', KB_FILE),
  ].filter((c) => c.length > 0);
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function loadDiseaseKb(path?: string): LoadedKb | null {
  if (cached != null && path == null) {
    return cached;
  }
  const file = path ?? resolveKbPath();
  if (file == null) {
    return null;
  }
  const kb = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as KnowledgeBaseFile;
  const fieldText = kb.records.map((r) => FIELDS.map(([f]) => normalizeText(fieldValue(r, f))));
  const nameSet = kb.records.map(
    (r) =>
      new Set(
        [r.name, r.raw_name ?? '', ...(r.alt ?? []), ...(r.name_lines ?? [])]
          .map((n) => normalizeText(n))
          .filter(Boolean),
      ),
  );
  const sheetText = (kb.sheet_rows ?? []).map((row) => normalizeText(row.cells.join(' ; ')));
  let vectors: Int8Array[] | null = null;
  const scales: number[] = [];
  if (kb.vectors != null && kb.vectors.length === kb.records.length) {
    vectors = kb.vectors.map((v) => {
      scales.push(v.s);
      const buf = Buffer.from(v.q, 'base64');
      return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
  }
  const loaded: LoadedKb = { file: kb, vectors, scales, fieldText, nameSet, sheetText };
  if (path == null) {
    cached = loaded;
  }
  return loaded;
}

async function postJson<T>(url: string, key: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function medtoolsBase(): { base: string; key: string } | null {
  const base = process.env.MEDTOOLS_URL ?? '';
  const key = process.env.MEDTOOLS_API_KEY ?? '';
  return base && key ? { base: base.replace(/\/+$/, ''), key } : null;
}

async function semanticScores(kb: LoadedKb, text: string): Promise<number[] | null> {
  const mt = medtoolsBase();
  if (kb.vectors == null || mt == null) return null;
  const res = await postJson<{ data: Array<{ embedding: number[] }> }>(
    `${mt.base}/v1/embeddings`,
    mt.key,
    { input: [text.slice(0, 300)] },
    15_000,
  );
  const q = res.data[0]?.embedding;
  if (!q || q.length !== kb.vectors[0].length) return null;
  let norm = 0;
  for (const x of q) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return kb.vectors.map((v, i) => {
    let dot = 0;
    for (let j = 0; j < v.length; j += 1) dot += v[j] * q[j];
    return (dot * kb.scales[i]) / norm;
  });
}

function rerankText(r: DiseaseRecord): string {
  return [
    r.name,
    r.alt?.length ? `(${r.alt.slice(0, 6).join(', ')})` : '',
    r.definition ?? '',
    r.symptoms?.length ? `Symptoms: ${r.symptoms.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

async function rerank(query: string, docs: string[]): Promise<number[] | null> {
  const mt = medtoolsBase();
  if (mt == null) return null;
  const res = await postJson<{ results: Array<{ index: number; relevance_score: number }> }>(
    `${mt.base}/v1/rerank`,
    mt.key,
    { query, documents: docs, return_documents: false },
    20_000,
  );
  const scores = new Array<number>(docs.length).fill(Number.NEGATIVE_INFINITY);
  for (const r of res.results) scores[r.index] = r.relevance_score;
  return scores;
}

export interface KeywordPlan {
  /** The keyword as the model sent it. */
  keyword: string;
  /** Normalized phrases searched for this keyword (the keyword and its lexicon readings). */
  phrases: string[];
  /** Lexicon readings used (English), if any. */
  readAs: string[];
  /**
   * Query concept this keyword belongs to. Keywords that share a searched phrase
   * ("jor", "জ্বর" and "fever" all search "fever") are one concept, so a record
   * is ranked by how many different things the user described, not by how many
   * spellings of one symptom the model sent.
   */
  concept: number;
  skipped?: string;
}

export interface DiseaseMatch {
  record: DiseaseRecord;
  /** Keywords (as sent) this record matched. */
  keywords: string[];
  /** Fields where a keyword was found. */
  fields: string[];
  /** Per keyword: the fields it was found in and the phrase that matched there. */
  where: Array<{ keyword: string; fields: string[]; phrases: Record<string, string> }>;
  /** 0 = a keyword is the record's full name, 1 = in the name, 2 = elsewhere. */
  tier: number;
  /** Distinct query concepts found anywhere in the record. */
  concepts: number;
  /** Distinct query concepts found in the name, definition or symptoms. */
  coreConcepts: number;
  /** Number of (phrase, field) hits. */
  hits: number;
  /** Position in the dataset (stable tie-break). */
  index: number;
  /** Similarity to the question (reranker score for the leading block, embedding cosine otherwise). */
  relevance?: number;
}

export interface SheetMatch {
  row: SheetRow;
  keywords: string[];
}

export interface SemanticHit {
  record: DiseaseRecord;
  score: number;
}

export interface DiseaseSearchResult {
  plans: KeywordPlan[];
  matches: DiseaseMatch[];
  sheetMatches: SheetMatch[];
  semantic: SemanticHit[];
  errors: string[];
}

/** Fields that describe what the disease is and how it presents. */
const CORE_FIELDS = new Set([0, 3, 4]);

export function planKeywords(keywords: string[]): KeywordPlan[] {
  const plans: KeywordPlan[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const keyword = raw.trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    const { phrases: lex } = lexiconTerms(keyword);
    const phrases: string[] = [];
    const own = normalizeText(keyword);
    const ownGeneric = own
      .trim()
      .split(' ')
      .every((w) => TOO_GENERIC.has(w));
    if (own && !ownGeneric) phrases.push(own);
    for (const p of lex) {
      const n = normalizeText(p);
      if (n && !phrases.includes(n)) phrases.push(n);
    }
    const plan: KeywordPlan = { keyword, phrases, readAs: lex, concept: plans.length };
    if (phrases.length === 0) {
      if (own && ownGeneric) {
        plan.skipped =
          'too generic (it would match almost every record); send the disease or symptom words instead';
      } else if (hasBangla(keyword)) {
        plan.skipped = 'Bangla word not in the lexicon; send its English name too';
      } else {
        plan.skipped = 'no searchable word';
      }
    }
    plans.push(plan);
  }
  // Union keywords that search a common phrase into one concept.
  const parent = plans.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < plans.length; a++) {
    for (let b = a + 1; b < plans.length; b++) {
      if (plans[a].phrases.some((p) => plans[b].phrases.includes(p))) {
        parent[find(b)] = find(a);
      }
    }
  }
  const ids = new Map<number, number>();
  for (let i = 0; i < plans.length; i++) {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    plans[i].concept = ids.get(root)!;
  }
  return plans;
}

/**
 * Ranking: a keyword that is the record's full name first, then how many of the
 * described things the record covers (name, definition, symptoms), then anywhere,
 * then similarity to the question. A keyword inside a longer name ("fever" in
 * "Yellow fever") is not ranked above similarity, so symptom words do not pull
 * every "... fever" disease to the top.
 */
export function compareMatches(a: DiseaseMatch, b: DiseaseMatch): number {
  return (
    Number(b.tier === 0) - Number(a.tier === 0) ||
    b.coreConcepts - a.coreConcepts ||
    b.concepts - a.concepts ||
    Number(Boolean(a.record.name_only)) - Number(Boolean(b.record.name_only)) ||
    Number(Boolean(a.record.superseded)) - Number(Boolean(b.record.superseded)) ||
    (b.relevance ?? 0) - (a.relevance ?? 0) ||
    b.hits - a.hits ||
    a.index - b.index
  );
}

/** Every record and sheet row containing any keyword, ranked. */
export function keywordMatches(
  kb: LoadedKb,
  plans: KeywordPlan[],
): { matches: DiseaseMatch[]; sheetMatches: SheetMatch[] } {
  const matches: DiseaseMatch[] = [];
  kb.file.records.forEach((record, i) => {
    const where: DiseaseMatch['where'] = [];
    const fields = new Set<string>();
    const concepts = new Set<number>();
    const core = new Set<number>();
    let tier = 3;
    let hits = 0;
    for (const plan of plans) {
      const kwFields: string[] = [];
      const kwPhrases: Record<string, string> = {};
      for (const phrase of plan.phrases) {
        kb.fieldText[i].forEach((text, f) => {
          if (text.includes(phrase)) {
            const label = FIELDS[f][1];
            fields.add(label);
            if (!kwFields.includes(label)) kwFields.push(label);
            if (!(label in kwPhrases)) kwPhrases[label] = phrase.trim();
            hits += 1;
            concepts.add(plan.concept);
            if (CORE_FIELDS.has(f)) core.add(plan.concept);
            if (f === 0) {
              tier = Math.min(tier, kb.nameSet[i].has(phrase) ? 0 : 1);
            } else {
              tier = Math.min(tier, 2);
            }
          }
        });
      }
      if (kwFields.length)
        where.push({ keyword: plan.keyword, fields: kwFields, phrases: kwPhrases });
    }
    if (where.length) {
      matches.push({
        record,
        keywords: where.map((w) => w.keyword),
        fields: [...fields],
        where,
        tier,
        concepts: concepts.size,
        coreConcepts: core.size,
        hits,
        index: i,
      });
    }
  });
  matches.sort(compareMatches);
  const sheetMatches: SheetMatch[] = [];
  (kb.file.sheet_rows ?? []).forEach((row, i) => {
    const kws = plans
      .filter((p) => p.phrases.some((ph) => kb.sheetText[i].includes(ph)))
      .map((p) => p.keyword);
    if (kws.length) sheetMatches.push({ row, keywords: kws });
  });
  return { matches, sheetMatches };
}

/** How many leading matches the reranker re-orders (by meaning) inside equal coverage. */
const RERANK_TOP = 40;
/** Upper bound on the reranked block (one medtools call, about 2 s for 150 records). */
const RERANK_MAX = 160;

export async function searchDiseases(
  keywords: string[],
  question?: string,
  opts: { semantic?: boolean } = {},
): Promise<DiseaseSearchResult | null> {
  const kb = loadDiseaseKb();
  if (kb == null) {
    return null;
  }
  const errors: string[] = [];
  const plans = planKeywords(keywords);
  const found = keywordMatches(kb, plans);
  let matches = found.matches;
  const sheetMatches = found.sheetMatches;
  const semantic: SemanticHit[] = [];
  if (opts.semantic !== false && kb.vectors != null) {
    const english = plans.flatMap((p) => [p.keyword, ...p.readAs]);
    const text = [question ?? '', english.join(', ')].filter(Boolean).join(' — ');
    // The reranker reads English best: rank by the English readings of what was described.
    const readings = [
      ...new Set(
        plans.filter((p) => !p.skipped).flatMap((p) => (p.readAs.length ? p.readAs : [p.keyword])),
      ),
    ].filter((e) => !hasBangla(e));
    const rq = readings.length ? readings.join(', ') : text;
    try {
      const sem = await semanticScores(kb, text);
      if (sem) {
        // Order every match of equal coverage by similarity to the question.
        for (const m of matches) m.relevance = sem[m.index];
        matches.sort(compareMatches);
        if (matches.length > 1) {
          // Rerank the whole leading coverage group (records covering the most described
          // things), so the order inside it is by meaning, not by dataset position.
          const lead = matches.filter((m) => m.coreConcepts === matches[0].coreConcepts).length;
          const headSize = Math.min(RERANK_MAX, Math.max(RERANK_TOP, lead));
          const head = matches.slice(0, headSize);
          try {
            const rs = await rerank(
              rq,
              head.map((m) => rerankText(m.record)),
            );
            if (rs) {
              head.forEach((m, k) => {
                m.relevance = rs[k];
              });
              head.sort(compareMatches);
              matches = [...head, ...matches.slice(headSize)];
            }
          } catch (e) {
            errors.push(
              `reranker unavailable (${(e as Error).message}); matches of equal coverage are ordered by embedding similarity`,
            );
          }
        }
        const taken = new Set(matches.map((m) => m.record.key));
        const cand = sem
          .map((s, i) => [s, i] as const)
          .filter(([, i]) => !taken.has(kb.file.records[i].key) && !kb.file.records[i].superseded)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 20)
          .map(([, i]) => i);
        let scored: Array<{ i: number; score: number }> | null = null;
        if (cand.length) {
          try {
            const rs = await rerank(
              rq,
              cand.map((i) => rerankText(kb.file.records[i])),
            );
            if (rs) scored = cand.map((i, k) => ({ i, score: rs[k] }));
          } catch (e) {
            errors.push(
              `reranker unavailable (${(e as Error).message}); semantic extras filtered by similarity only`,
            );
          }
        }
        // medtools returns sigmoid relevance 0..1; keep clearly related neighbours only.
        const kept = scored
          ? scored.filter((s) => s.score >= 0.3).sort((a, b) => b.score - a.score)
          : cand.map((i) => ({ i, score: sem[i] })).filter((s) => s.score >= 0.86);
        for (const s of kept.slice(0, 6)) {
          semantic.push({ record: kb.file.records[s.i], score: s.score });
        }
      }
    } catch (e) {
      errors.push(
        `semantic search unavailable (${(e as Error).message}); keyword matches are complete, ranked by coverage only`,
      );
    }
  }
  return { plans, matches, sheetMatches, semantic, errors };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A short piece of the raw field text around where the phrase matched. */
export function snippet(raw: string, phrase: string, width = 70): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const words = phrase.trim().split(' ').filter(Boolean);
  const re = words.length
    ? new RegExp(words.map((w) => escapeRe(w)).join('[^\\p{L}\\p{N}]+'), 'iu')
    : null;
  const m = re ? re.exec(text) : null;
  if (m == null) {
    return text.length > width * 2 ? `${text.slice(0, width * 2).trim()}…` : text;
  }
  const s = Math.max(0, m.index - width);
  const e = Math.min(text.length, m.index + m[0].length + width);
  return `${s > 0 ? '…' : ''}${text.slice(s, e).trim()}${e < text.length ? '…' : ''}`;
}

const FIELD_BY_LABEL = new Map(FIELDS.map(([f, label]) => [label, f]));

/**
 * One line per record: ID, name, where each keyword matched, the symptoms, and
 * the text around matches outside the name and symptoms. Level 0 is complete;
 * higher levels shorten symptoms and snippets so very long lists still fit.
 */
export function compactLine(m: DiseaseMatch, level: number): string {
  const r = m.record;
  const tag = r.superseded
    ? ` (older version of ${r.superseded_by})`
    : r.name_only
      ? ' — name only, no details in the dataset'
      : r.category
        ? ` (${r.category})`
        : '';
  const matched = m.where.map((w) => `${w.keyword} → ${w.fields.join('/')}`).join('; ');
  let line = `- ${r.key} ${r.name}${tag} | matched: ${matched}`;
  if (level <= 2 && !r.name_only && r.symptoms?.length) {
    let sym = r.symptoms.join('; ');
    const cap = level === 0 ? Infinity : level === 1 ? 160 : 70;
    if (sym.length > cap) sym = `${sym.slice(0, cap).replace(/\s+\S*$/, '')}…`;
    line += ` | symptoms: ${sym}`;
  }
  if (level <= 1) {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const w of m.where) {
      for (const label of w.fields) {
        if (label === 'name' || label === 'symptoms' || seen.has(label)) continue;
        seen.add(label);
        const f = FIELD_BY_LABEL.get(label);
        if (f == null) continue;
        parts.push(
          `${label}: "${snippet(fieldValue(r, f), w.phrases[label] ?? w.keyword, level === 0 ? 70 : 40)}"`,
        );
      }
    }
    if (parts.length) line += ` | ${parts.slice(0, level === 0 ? 3 : 1).join(' | ')}`;
  }
  return line;
}

function renderRecord(r: DiseaseRecord, label: string, note: string): string {
  const title = `${r.name} [${r.key}]${r.superseded ? ` (older version, replaced by ${r.superseded_by})` : ''}`;
  if (r.name_only) {
    return (
      heading(title) +
      '\n' +
      definitionList([
        ['Dataset ID', r.id],
        ['Raw name line', r.raw_name ?? ''],
        ['All name lines for this ID', (r.name_lines ?? []).join(' | ')],
        ['Same name as', (r.same_name_as ?? []).join(', ')],
        [
          'Details',
          `Name only: the dataset lists this name (${r.name_list_file ?? 'name list'}) but holds no definition, symptoms or other details for it. Use condition_lookup / pubmed_search / web_search for the facts.`,
        ],
        ['Matched', note],
      ]) +
      `\n_Cite as: ${label}, record ${r.key} (name list only)._`
    );
  }
  return (
    heading(title) +
    '\n' +
    definitionList([
      ['Dataset ID', r.id],
      ['Raw name', r.raw_name ?? ''],
      ['Also called', (r.alt ?? []).join(', ')],
      ['Category', [r.category, r.subcategory].filter(Boolean).join(' — ')],
      ['Definition', r.definition ?? ''],
      ['Symptoms', (r.symptoms ?? []).join('; ')],
      ['Other signs (dataset column; sometimes holds treatment notes)', r.other_signs ?? ''],
      ['Causes', r.causes ?? ''],
      ['Risk factors', r.risk_factors ?? ''],
      ['Transmission', r.transmission ?? ''],
      ['Commonly affected', r.age_group ?? ''],
      ['Severity (dataset wording)', r.severity ?? ''],
      ['Warning signs / complications', r.warning_signs ?? ''],
      ['Diagnosis', r.diagnosis ?? ''],
      ['Prevention / management notes (background only)', r.prevention_management ?? ''],
      [
        'Source cited',
        `${r.source_name ?? ''}${r.source_is_homepage ? ' (homepage only, not the topic page)' : ''}`,
      ],
      ['Source URL', r.source_url ?? ''],
      ['Verification', r.verification ?? ''],
      ['Last reviewed', r.reviewed ?? ''],
      ['Workbook versions', (r.versions ?? []).join(', ')],
      ['Extra cells', (r.extra_cells ?? []).join(' | ')],
      ['Realigned', r.realigned ?? ''],
      ['Same name as', (r.same_name_as ?? []).join(', ')],
      ['Matched', note],
    ]) +
    `\n_Cite as: ${label}, record ${r.key} (source: ${r.source_name || 'not stated'})._`
  );
}

function renderSheetRow(row: SheetRow, keywords: string[]): string {
  return `- [${row.sheet}] ${row.cells.join(' | ')} (workbook versions ${row.versions.join(', ')}; matched: ${keywords.join(', ')})`;
}

function matchNote(m: DiseaseMatch): string {
  return m.where.map((w) => `"${w.keyword}" in ${w.fields.join(', ')}`).join('; ');
}

/** Default size of one disease_knowledge_search result (characters, about 40k tokens). */
export const DEFAULT_DISEASE_KB_MAX_CHARS = 160_000;
/** Minimum number of top-ranked records given with every field. */
const MIN_FULL = 5;
/** Records fetchable in full by ID in one call. */
const MAX_IDS = 40;

export interface LayoutPlan {
  full: DiseaseMatch[];
  compact: DiseaseMatch[];
  level: number;
  fullText: string[];
  compactText: string[];
}

/**
 * Split ranked matches into records given with every field and records given
 * as one compact line, so that every match is in one result within `budget`.
 * Every match always appears (compact level 3 is ID, name and match fields).
 * Only one record per disease goes in full (the dataset holds the same disease
 * under several IDs from different chart versions); the other versions stay in
 * the compact list. The full set grows while the compact list still fits at
 * its best level.
 */
export function layoutMatches(
  matches: DiseaseMatch[],
  budget: number,
  renderFull: (m: DiseaseMatch) => string,
): LayoutPlan {
  const fullBudget = Math.floor(budget * 0.4);
  const isFull = new Array<boolean>(matches.length).fill(false);
  const lineLen = [0, 1, 2, 3].map((level) => matches.map((m) => compactLine(m, level).length + 1));
  const shownNames = new Set<string>();
  const shownIds = new Set<string>();
  const nameKey = (r: DiseaseRecord) => normalizeText(r.name).trim();
  const isDup = (r: DiseaseRecord) =>
    shownNames.has(nameKey(r)) || (r.same_name_as ?? []).some((id) => shownIds.has(id));
  const compactLen = (level: number, except = -1): number => {
    let n = 0;
    for (let k = 0; k < matches.length; k++) if (!isFull[k] && k !== except) n += lineLen[level][k];
    return n;
  };
  const texts = new Map<number, string>();
  let used = 0;
  let count = 0;
  const take = (k: number, t: string) => {
    isFull[k] = true;
    texts.set(k, t);
    used += t.length;
    count += 1;
    shownNames.add(nameKey(matches[k].record));
    shownIds.add(matches[k].record.id);
  };
  // 1. Full records for the top of the ranking, one per disease.
  for (let k = 0; k < matches.length; k++) {
    if (isDup(matches[k].record)) continue;
    const t = renderFull(matches[k]);
    if (count >= MIN_FULL && used + t.length > fullBudget) break;
    take(k, t);
  }
  // 2. The best compact level that fits the rest.
  let level = 0;
  while (level < 3 && used + compactLen(level) > budget) level += 1;
  // 3. Spare room at level 0: give more records in full (still one per disease).
  if (level === 0) {
    for (let k = 0; k < matches.length; k++) {
      if (isFull[k] || isDup(matches[k].record)) continue;
      const t = renderFull(matches[k]);
      if (used + t.length + compactLen(0, k) > budget) break;
      take(k, t);
    }
  }
  const full: DiseaseMatch[] = [];
  const fullText: string[] = [];
  const compact: DiseaseMatch[] = [];
  matches.forEach((m, k) => {
    if (isFull[k]) {
      full.push(m);
      fullText.push(texts.get(k)!);
    } else {
      compact.push(m);
    }
  });
  return { full, compact, level, fullText, compactText: compact.map((m) => compactLine(m, level)) };
}

function recordSource(r: DiseaseRecord, label: string): SourceRef {
  return {
    name: `${label} — ${r.name} [${r.key}]`,
    url: r.source_url || 'local dataset',
    note: r.name_only
      ? 'local disease dataset; name only'
      : `local disease dataset; the record cites ${r.source_name || 'no authority'}`,
  };
}

const CITE_RULE =
  'CITING: you may cite only what this turn\'s tool results actually contain. From this result that is "' +
  'Global Disease Master Chart" with a record ID shown here, and the authority that record names in its "Source cited" field (write it as "the dataset cites CDC", since you did not read the CDC page yourself). Do not name WHO, DGHS, NHS, CDC or any guideline as a source of your answer unless a tool result in this turn returned that page or quote.';

export const diseaseKnowledgeTools = [
  defineTool({
    name: 'disease_knowledge_search',
    group: 'conditions',
    title: 'Disease knowledge base keyword search (Global Disease Master Chart, full dataset)',
    description:
      'Keyword lookup over the whole local disease dataset ("Global Disease Master Chart": every workbook snapshot and name list; about 2,000 disease records D0001–D2000 plus the categories and source register). ' +
      'MUST be called, before answering, whenever the user mentions a disease, a symptom or anything related to a disease. Pass `keywords`: the disease names and symptoms the user actually mentioned, in English plus the Bangla/Banglish words the user used. For a named disease pass only its names, not its symptoms (e.g. ["dengue", "ডেঙ্গু"]); for described symptoms pass every symptom described (e.g. ["fever", "jor", "body ache", "gaye betha"]). ' +
      'ONE call returns EVERY record that contains any keyword in any field — nothing is paged or dropped: the best-ranked records with every field, and every other match as one compact line (ID, name, where each keyword matched, symptoms, and the text around the match). Records are ranked by how many of the described symptoms they cover (name, definition, symptoms), then by similarity to the question. ' +
      'To read every field of records from the compact list, call again with `ids` (e.g. ["D0052", "D0300"]). ' +
      'Records D1401–D2000 are mostly name-only (no details in the dataset). It is a compiled reference table, not a guideline: never take a dose, a threshold or a treatment decision from it — use drug_label / pubmed_search / web_search for those.',
    readOnly: true,
    inputSchema: {
      keywords: z
        .array(z.string().min(1).max(120))
        .max(40)
        .optional()
        .describe(
          'The disease names and symptoms the user mentioned: English names plus the user\'s Bangla/Banglish words, one per item. A named disease gets only its names, e.g. ["typhoid", "enteric fever", "টাইফয়েড"]; described symptoms get every symptom, e.g. ["fever", "jor", "body ache", "gaye betha"]. A match on any keyword returns the record.',
        ),
      question: z
        .string()
        .max(400)
        .optional()
        .describe(
          "The user's question as written (used to rank matches by meaning and to find related records that match no keyword).",
        ),
      ids: z
        .array(z.string().min(1).max(20))
        .max(MAX_IDS)
        .optional()
        .describe(
          'Record IDs to return with every field, e.g. ["D0052", "D1187"] — use for records that came back as compact lines. Can be sent without keywords.',
        ),
    },
    async handler(args, { env }) {
      const kb = loadDiseaseKb();
      if (kb == null) {
        return {
          text:
            'The disease knowledge base index is not installed on this server (data/disease-kb/disease-kb.json.gz). ' +
            'Answer from the other tools (condition_lookup, pubmed_search, web_search) and say the local disease dataset was unavailable.',
          isError: true,
        };
      }
      const label = `${kb.file.dataset ?? 'Global Disease Master Chart'} v${kb.file.version || '?'}`;
      const budget = Math.max(20_000, env.diseaseKbMaxChars ?? DEFAULT_DISEASE_KB_MAX_CHARS);
      // The tool sizes its own output; never let the generic cap cut it.
      const outEnv = { ...env, maxResultChars: Math.max(env.maxResultChars, budget + 40_000) };
      const keywords = args.keywords ?? [];
      const ids = (args.ids ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);

      // --- Full records by ID -------------------------------------------------
      if (ids.length && keywords.length === 0) {
        const found: DiseaseRecord[] = [];
        const missing: string[] = [];
        for (const id of ids) {
          const recs = kb.file.records.filter(
            (r) => r.key.toUpperCase() === id || r.id.toUpperCase() === id,
          );
          if (recs.length) found.push(...recs.filter((r) => !found.includes(r)));
          else missing.push(id);
        }
        const sections = found.map((r) => renderRecord(r, label, 'requested by ID'));
        return composeResult({
          headline: `${found.length} record(s) from the ${label} dataset, every field.`,
          sections,
          notices: [
            ...(missing.length ? [`No record with ID: ${missing.join(', ')}.`] : []),
            CITE_RULE,
            'Never take a dose, a lab threshold or a treatment choice from this dataset, even where a record mentions one.',
          ],
          sources: found.map((r) => recordSource(r, label)),
          env: outEnv,
        });
      }
      if (keywords.length === 0) {
        return {
          text: 'Pass `keywords` (the disease names or symptoms the user mentioned) or `ids` (record IDs such as "D0051").',
          isError: true,
        };
      }

      const result = await searchDiseases(keywords, args.question, { semantic: true });
      if (result == null) {
        return { text: 'The disease knowledge base index could not be loaded.', isError: true };
      }
      const searched = result.plans
        .map((p) =>
          p.skipped
            ? `"${p.keyword}" skipped (${p.skipped})`
            : `"${p.keyword}"${p.readAs.length ? ` (also read as: ${p.readAs.join(', ')})` : ''}`,
        )
        .join('; ');
      const conceptCount = new Set(result.plans.filter((p) => !p.skipped).map((p) => p.concept))
        .size;
      const noKeyword = result.plans.filter(
        (p) => !p.skipped && !result.matches.some((m) => m.keywords.includes(p.keyword)),
      );

      if (result.matches.length + result.sheetMatches.length + result.semantic.length === 0) {
        return composeResult({
          headline: `No record in the ${label} disease dataset contains any of the keywords.`,
          notices: [
            `Searched: ${searched}.`,
            'Not covered by the local dataset. Use condition_lookup, pubmed_search or web_search instead, and do not fill the gap from memory. Try other keywords (English disease name, synonyms, symptoms) if the user wrote it differently.',
            ...result.errors,
          ],
          sources: [],
          env: outEnv,
        });
      }

      // Extras (related by meaning, other sheets) are small; reserve their room first.
      const semLines = result.semantic.map(
        (h) =>
          `${compactLine({ record: h.record, keywords: [], fields: [], where: [], tier: 3, concepts: 0, coreConcepts: 0, hits: 0, index: 0 }, 0).replace(' | matched: ', ` | relevance ${h.score.toFixed(2)}`)}`,
      );
      const sheetLines = result.sheetMatches
        .slice(0, 60)
        .map((s) => renderSheetRow(s.row, s.keywords));
      const extrasLen = semLines.join('\n').length + sheetLines.join('\n').length + 4000;
      const plan = layoutMatches(result.matches, Math.max(10_000, budget - extrasLen), (m) =>
        renderRecord(m.record, label, matchNote(m)),
      );

      const sections: string[] = [];
      const total = result.matches.length;
      if (plan.full.length) {
        sections.push(
          heading(
            plan.compact.length
              ? `${plan.full.length} of ${total} matching records with every field: the best-ranked diseases, one record each (ranked by how many described symptoms they cover, then by similarity to the question; other chart versions of the same disease are in the compact list)`
              : `All ${total} matching records, every field`,
          ),
          ...plan.fullText,
        );
      }
      if (plan.compact.length) {
        const what = [
          'the complete symptom list and the text around every match',
          'symptoms shortened to 160 characters and one match excerpt',
          'symptoms shortened to 70 characters',
          'ID, name and the fields each keyword matched',
        ][plan.level];
        sections.push(
          `${heading(`The other ${plan.compact.length} matching records, ranked (one line each: ${what})`)}\n${plan.compactText.join('\n')}`,
        );
      }
      if (semLines.length) {
        sections.push(
          `${heading('Related records found by meaning (no keyword match)')}\n${semLines.join('\n')}`,
        );
      }
      if (sheetLines.length) {
        sections.push(
          `${heading('Workbook rows from the other sheets that contain a keyword')}\n${sheetLines.join('\n')}` +
            (result.sheetMatches.length > sheetLines.length
              ? `\n… ${result.sheetMatches.length - sheetLines.length} more rows (categories / source register / quality control), not disease records.`
              : ''),
        );
      }

      const notices = [
        `COMPLETE: all ${total} matching disease records are in this one result (${plan.full.length} with every field, ${plan.compact.length} as compact lines). Nothing is paged; there is no next page to fetch.`,
        conceptCount > 1
          ? `The user described ${conceptCount} different things; records covering more of them are ranked first. Read the whole list: build your list of possible causes from the records whose symptoms fit the person's age, duration and story, not only the first few.`
          : 'Read the whole list, not only the first few records.',
        plan.compact.length
          ? `For any compact-line record that fits the person's story better than the full ones, call disease_knowledge_search with ids=[...] (up to ${MAX_IDS}) to read every field before you rely on it.`
          : '',
        `Searched: ${searched}. Matching is whole word/phrase, case-insensitive, in every field.`,
        CITE_RULE,
        'It is a compiled reference table (marked self-verified, no author or licence stated): good for orientation, not proof. Never take a dose, a lab threshold or a treatment choice from it, even where a record mentions one. Its "prevention" and "other signs" columns often hold management notes; report them only as general background.',
        'A symptom match is a list of conditions to consider, not a diagnosis. Judge urgency yourself from the whole message.',
      ].filter(Boolean);
      if (noKeyword.length) {
        notices.push(
          `No disease record contains: ${noKeyword.map((p) => `"${p.keyword}"`).join(', ')}.`,
        );
      }
      notices.push(...result.errors);
      const counts = `${total} disease record(s), ${result.sheetMatches.length} workbook row(s), ${result.semantic.length} related by meaning`;
      return composeResult({
        headline: `${counts} from the ${label} dataset for keywords ${result.plans.map((p) => `"${p.keyword}"`).join(', ')} — complete in this result.`,
        sections,
        notices,
        sources: [...plan.full.map((m) => m.record), ...result.semantic.map((h) => h.record)]
          .slice(0, 40)
          .map((r) => recordSource(r, label)),
        env: outEnv,
      });
    },
  }),
];
