import { z } from 'zod';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { clampInt, composeResult, definitionList, heading, type SourceRef } from '../format.js';
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

/** Lower-case, strip accents, keep letters/digits as words, singularize plain plurals. */
export function normalizeText(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
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
  skipped?: string;
}

export interface DiseaseMatch {
  record: DiseaseRecord;
  /** Keywords (as sent) this record matched. */
  keywords: string[];
  /** Fields where a keyword was found. */
  fields: string[];
  /** 0 = a keyword is the record's full name, 1 = in the name, 2 = elsewhere. */
  tier: number;
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
    const plan: KeywordPlan = { keyword, phrases, readAs: lex };
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
  return plans;
}

/** Every record and sheet row containing any keyword, in a stable order. */
export function keywordMatches(
  kb: LoadedKb,
  plans: KeywordPlan[],
): { matches: DiseaseMatch[]; sheetMatches: SheetMatch[] } {
  const matches: DiseaseMatch[] = [];
  kb.file.records.forEach((record, i) => {
    const kws: string[] = [];
    const fields = new Set<string>();
    let tier = 3;
    let hits = 0;
    for (const plan of plans) {
      let matched = false;
      for (const phrase of plan.phrases) {
        kb.fieldText[i].forEach((text, f) => {
          if (text.includes(phrase)) {
            matched = true;
            fields.add(FIELDS[f][1]);
            hits += 1;
            if (f === 0) {
              tier = Math.min(tier, kb.nameSet[i].has(phrase) ? 0 : 1);
            } else {
              tier = Math.min(tier, 2);
            }
          }
        });
      }
      if (matched) kws.push(plan.keyword);
    }
    if (kws.length) {
      matches.push({ record, keywords: kws, fields: [...fields], tier });
      (matches[matches.length - 1] as DiseaseMatch & { _h: number; _i: number })._h = hits;
      (matches[matches.length - 1] as DiseaseMatch & { _h: number; _i: number })._i = i;
    }
  });
  matches.sort((a, b) => {
    const A = a as DiseaseMatch & { _h: number; _i: number };
    const B = b as DiseaseMatch & { _h: number; _i: number };
    return (
      A.tier - B.tier ||
      B.keywords.length - A.keywords.length ||
      Number(Boolean(A.record.name_only)) - Number(Boolean(B.record.name_only)) ||
      B._h - A._h ||
      A._i - B._i
    );
  });
  for (const m of matches) {
    delete (m as Partial<DiseaseMatch & { _h: number; _i: number }>)._h;
    delete (m as Partial<DiseaseMatch & { _h: number; _i: number }>)._i;
  }
  const sheetMatches: SheetMatch[] = [];
  (kb.file.sheet_rows ?? []).forEach((row, i) => {
    const kws = plans
      .filter((p) => p.phrases.some((ph) => kb.sheetText[i].includes(ph)))
      .map((p) => p.keyword);
    if (kws.length) sheetMatches.push({ row, keywords: kws });
  });
  return { matches, sheetMatches };
}

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
  const { matches, sheetMatches } = keywordMatches(kb, plans);
  const semantic: SemanticHit[] = [];
  if (opts.semantic !== false && kb.vectors != null) {
    const english = plans.flatMap((p) => [p.keyword, ...p.readAs]);
    const text = [question ?? '', english.join(', ')].filter(Boolean).join(' — ');
    try {
      const sem = await semanticScores(kb, text);
      if (sem) {
        const taken = new Set(matches.map((m) => m.record.key));
        const cand = sem
          .map((s, i) => [s, i] as const)
          .filter(([, i]) => !taken.has(kb.file.records[i].key) && !kb.file.records[i].superseded)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 20)
          .map(([, i]) => i);
        let scored: Array<{ i: number; score: number }> | null = null;
        try {
          const rq = hasBangla(text)
            ? english.filter((e) => !hasBangla(e)).join(', ') || text
            : text;
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
        `semantic search unavailable (${(e as Error).message}); keyword matches are complete`,
      );
    }
  }
  return { plans, matches, sheetMatches, semantic, errors };
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

type Item =
  | { kind: 'match'; m: DiseaseMatch }
  | { kind: 'sheet'; s: SheetMatch }
  | { kind: 'semantic'; h: SemanticHit };

export const diseaseKnowledgeTools = [
  defineTool({
    name: 'disease_knowledge_search',
    group: 'conditions',
    title: 'Disease knowledge base keyword search (Global Disease Master Chart, full dataset)',
    description:
      'Keyword lookup over the whole local disease dataset ("Global Disease Master Chart": every workbook snapshot and name list; about 2,000 disease records D0001–D2000 plus the categories and source register). ' +
      'MUST be called, before answering, whenever the user mentions a disease, a symptom or anything related to a disease. Pass `keywords`: the disease names and symptoms the user actually mentioned, in English plus the Bangla/Banglish words the user used. For a named disease pass only its names, not its symptoms (e.g. ["dengue", "ডেঙ্গু"]); for described symptoms pass the symptoms (e.g. ["fever", "jor", "rash"]). ' +
      'It returns EVERY record that contains any keyword in any field (name, alternative names, symptoms, other signs, causes, risk factors, transmission, age group, severity, warning signs, diagnosis, prevention), with every field of every match — no top-k. The first page lists all matches by name; when the result says there is a next page, call again with the same keywords and `offset` = next_offset to get the rest. ' +
      'Records D1401–D2000 are mostly name-only (no details in the dataset). It is a compiled reference table, not a guideline: never take a dose, a threshold or a treatment decision from it — use drug_label / pubmed_search / web_search (DGHS, WHO) for those.',
    readOnly: true,
    inputSchema: {
      keywords: z
        .array(z.string().min(1).max(120))
        .min(1)
        .max(40)
        .describe(
          'The disease names and symptoms the user mentioned: English names plus the user\'s Bangla/Banglish words, one per item. A named disease gets only its names, e.g. ["typhoid", "enteric fever", "টাইফয়েড"]; described symptoms get the symptoms, e.g. ["fever", "jor"]. A match on any keyword returns the record.',
        ),
      question: z
        .string()
        .max(400)
        .optional()
        .describe(
          "The user's question as written (used only to find related records that match no keyword).",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Result offset for the next page: pass next_offset from the previous page, with the same keywords.',
        ),
    },
    async handler(args, { env }) {
      const offset = clampInt(args.offset, 0, 100_000, 0);
      const result = await searchDiseases(args.keywords, args.question, { semantic: true });
      if (result == null) {
        return {
          text:
            'The disease knowledge base index is not installed on this server (data/disease-kb/disease-kb.json.gz). ' +
            'Answer from the other tools (condition_lookup, pubmed_search, web_search) and say the local disease dataset was unavailable.',
          isError: true,
        };
      }
      const kb = loadDiseaseKb();
      const label = `${kb?.file.dataset ?? 'Global Disease Master Chart'} v${kb?.file.version || '?'}`;
      const searched = result.plans
        .map((p) =>
          p.skipped
            ? `"${p.keyword}" skipped (${p.skipped})`
            : `"${p.keyword}"${p.readAs.length ? ` (also read as: ${p.readAs.join(', ')})` : ''}`,
        )
        .join('; ');
      const items: Item[] = [
        ...result.matches.map((m) => ({ kind: 'match' as const, m })),
        ...result.sheetMatches.map((s) => ({ kind: 'sheet' as const, s })),
        ...result.semantic.map((h) => ({ kind: 'semantic' as const, h })),
      ];
      const total = items.length;
      const noKeyword = result.plans.filter(
        (p) => !p.skipped && !result.matches.some((m) => m.keywords.includes(p.keyword)),
      );

      if (total === 0) {
        return composeResult({
          headline: `No record in the ${label} disease dataset contains any of the keywords.`,
          notices: [
            `Searched: ${searched}.`,
            'Not covered by the local dataset. Use condition_lookup, pubmed_search or web_search instead, and do not fill the gap from memory. Try other keywords (English disease name, synonyms, symptoms) if the user wrote it differently.',
            ...result.errors,
          ],
          sources: [],
          env,
        });
      }
      if (offset >= total) {
        return composeResult({
          headline: `No more results: all ${total} result(s) for these keywords were already returned (offset ${offset}).`,
          notices: [`Searched: ${searched}.`],
          sources: [],
          env,
        });
      }

      // Fill the page up to the character budget; always at least one item.
      const budget = Math.max(6000, env.maxResultChars - 7000);
      const sections: string[] = [];
      const sources: SourceRef[] = [];
      let used = 0;
      let end = offset;

      if (offset === 0 && result.matches.length > 1) {
        const index = result.matches.map((m, k) => `${k + 1}. ${m.record.name} [${m.record.key}]`);
        let text = index.join('; ');
        if (text.length > 6000) {
          let cut = 0;
          let len = 0;
          while (cut < index.length && len + index[cut].length + 2 <= 6000) {
            len += index[cut].length + 2;
            cut += 1;
          }
          text = `${index.slice(0, cut).join('; ')}; … and ${index.length - cut} more (their full records follow on the next pages, in this order)`;
        }
        const listing = `${heading(`All ${result.matches.length} keyword-matched disease records`)}\n${text}`;
        sections.push(listing);
        used += listing.length;
      }

      let sheetOpen = false;
      let semOpen = false;
      while (end < total) {
        const it = items[end];
        let block: string;
        if (it.kind === 'match') {
          const note = `keywords ${it.m.keywords.map((k) => `"${k}"`).join(', ')} in ${it.m.fields.join(', ')}`;
          block = renderRecord(it.m.record, label, note);
        } else if (it.kind === 'sheet') {
          block =
            (sheetOpen
              ? ''
              : `${heading('Workbook rows from the other sheets that contain a keyword')}\n`) +
            renderSheetRow(it.s.row, it.s.keywords);
        } else {
          block =
            (semOpen ? '' : `${heading('Related records found by meaning (no keyword match)')}\n`) +
            renderRecord(
              it.h.record,
              label,
              `semantic neighbour, relevance ${it.h.score.toFixed(2)}`,
            );
        }
        if (end > offset && used + block.length > budget) break;
        if (it.kind === 'sheet') sheetOpen = true;
        if (it.kind === 'semantic') semOpen = true;
        sections.push(block);
        used += block.length;
        if (it.kind !== 'sheet') {
          const r = it.kind === 'match' ? it.m.record : it.h.record;
          if (sources.length < 12) {
            sources.push({
              name: `${label} — ${r.name} [${r.key}]`,
              url: r.source_url || 'local dataset',
              note: r.name_only
                ? 'local disease dataset; name only'
                : `local disease dataset; cites ${r.source_name || 'no authority'}`,
            });
          }
        }
        end += 1;
      }

      const more = end < total;
      const notices = [
        more
          ? `NEXT PAGE: results ${offset + 1}–${end} of ${total} shown. Call disease_knowledge_search again with the same keywords and offset=${end} (next_offset) to get the rest; do not answer from a partial list.`
          : `Complete: results ${offset + 1}–${end} of ${total}; nothing more to fetch.`,
        `Searched: ${searched}. Matching is whole word/phrase, case-insensitive, in every field.`,
        `Cite this as "${label}" plus the record ID, and name the authority it cites (e.g. "CDC-এর তথ্য অনুযায়ী, Global Disease Master Chart [D0051]"). It is a compiled reference table (marked self-verified, no author or licence stated): good for orientation, not proof. Confirm anything decision-relevant with the cited authority, a guideline (pubmed_search) or web_search.`,
        'Never take a dose, a lab threshold or a treatment choice from this dataset, even where a record mentions one. Its "prevention" and "other signs" columns often hold management notes; report them only as general background.',
        'A symptom match is a list of conditions to consider, not a diagnosis. Judge urgency yourself from the whole message.',
      ];
      if (noKeyword.length) {
        notices.push(
          `No disease record contains: ${noKeyword.map((p) => `"${p.keyword}"`).join(', ')}.`,
        );
      }
      notices.push(...result.errors);
      const counts = `${result.matches.length} disease record(s), ${result.sheetMatches.length} workbook row(s), ${result.semantic.length} related by meaning`;
      return composeResult({
        headline: `${counts} from the ${label} dataset for keywords ${result.plans.map((p) => `"${p.keyword}"`).join(', ')} — page ${offset + 1}–${end} of ${total}${more ? `, next_offset=${end}` : ', complete'}.`,
        sections,
        notices,
        sources,
        env,
      });
    },
  }),
];
