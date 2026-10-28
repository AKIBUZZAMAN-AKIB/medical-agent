import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { clampInt, composeResult, definitionList, heading, type SourceRef } from '../format.js';
import { defineTool } from '../types.js';
import { expandQuery, hasBangla } from './diseaseLexicon.js';

/**
 * `disease_knowledge_search` — hybrid retrieval over the local "Global Disease
 * Master Chart" knowledge base (one chunk per disease).
 *
 *  1. keyword: BM25 over name / synonyms / definition / symptoms / causes, with
 *     Bangla and Banglish words expanded to English (diseaseLexicon.ts);
 *  2. semantic: cosine similarity against int8 multilingual-e5-base vectors built
 *     by scripts/build_disease_kb.py, with the query embedded by medtools;
 *  3. reciprocal-rank fusion of the two, then the medtools cross-encoder
 *     (mmarco-mMiniLMv2, multilingual) reranks the top candidates.
 *
 * Any medtools failure degrades to keyword-only search; it never fails the call.
 * The index file is built locally and is not committed (no licence stated for
 * the source workbook): see docs/DISEASE_KB.md.
 */

interface DiseaseRecord {
  id: string;
  dup_ids: string[];
  name: string;
  alt: string[];
  category: string;
  subcategory: string;
  definition: string;
  symptoms: string[];
  other_signs: string;
  causes: string;
  risk_factors: string;
  transmission: string;
  age_group: string;
  severity: string;
  warning_signs: string;
  diagnosis: string;
  prevention_management: string;
  source_name: string;
  source_url: string;
  source_is_homepage: boolean;
  reviewed: string;
  terse: boolean;
}

interface KnowledgeBaseFile {
  dataset: string;
  version: string;
  built: string;
  dim: number | null;
  records: DiseaseRecord[];
  vectors: Array<{ s: number; q: string }> | null;
}

interface LoadedKb {
  file: KnowledgeBaseFile;
  vectors: Int8Array[] | null;
  scales: number[];
  docTokens: Map<string, number>[];
  docLen: number[];
  avgLen: number;
  df: Map<string, number>;
  nameKeys: string[][];
}

const KB_FILE = 'disease-kb/disease-kb.json.gz';
let cached: LoadedKb | null = null;

const STOP = new Set(
  (
    'the a an of and or to in on for with is are was be what which who how why when does do can my me i it ' +
    'this that from about any have has had symptom symptoms sign signs disease diseases tell please ' +
    'ki kি keno kemon hoy hoyeche hole kora korbo koro ar er o na ta te ke ki? amar amr apnar amake ache ase asche ' +
    'theke jonno moto kivabe kibhabe bolo bolen jante chai'
  ).split(/\s+/),
);

const GENERIC_KEYS = new Set(
  'fever pain rash itching cough headache vomiting bleeding weakness fatigue seizure symptom cause prevention child children pregnancy test diagnosis infection disease syndrome chest pain joint pain abdominal pain'.split(
    ' ',
  ).concat(['chest pain', 'joint pain', 'abdominal pain', 'sore throat', 'common cold']),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('is') ? t.slice(0, -1) : t));
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

function docText(r: DiseaseRecord): Array<[string, number]> {
  return [
    [r.name, 4],
    [r.alt.join(' '), 3],
    [r.definition, 1],
    [r.symptoms.join(' '), 1],
    [r.other_signs, 1],
    [r.category + ' ' + r.subcategory, 1],
    [r.causes, 1],
    [r.transmission, 1],
  ];
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
  const docTokens: Map<string, number>[] = [];
  const docLen: number[] = [];
  const df = new Map<string, number>();
  const nameKeys: string[][] = [];
  for (const r of kb.records) {
    const tf = new Map<string, number>();
    let len = 0;
    for (const [text, weight] of docText(r)) {
      for (const t of tokenize(text)) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
        len += weight;
      }
    }
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    docTokens.push(tf);
    docLen.push(len);
    nameKeys.push(
      [r.name, r.name.replace(/\s*\(.*?\)\s*/g, ' '), ...r.alt]
        .map((n) => {
          // Skip a variant that loses a one-letter word ("Q fever" -> "fever",
          // "Hepatitis B" -> "hepatitis"), and bare symptom words that would
          // match half the questions.
          const words = n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
          return words.some((w) => w.length === 1) ? '' : tokenize(n).join(' ');
        })
        .filter((n) => n.length >= 4 && !GENERIC_KEYS.has(n)),
    );
  }
  let vectors: Int8Array[] | null = null;
  const scales: number[] = [];
  if (kb.vectors != null && kb.vectors.length === kb.records.length) {
    vectors = kb.vectors.map((v) => {
      scales.push(v.s);
      const buf = Buffer.from(v.q, 'base64');
      return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
  }
  const loaded: LoadedKb = {
    file: kb,
    vectors,
    scales,
    docTokens,
    docLen,
    avgLen: docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length),
    df,
    nameKeys,
  };
  if (path == null) {
    cached = loaded;
  }
  return loaded;
}

function bm25(kb: LoadedKb, terms: string[]): number[] {
  const N = kb.docTokens.length;
  const k1 = 1.2;
  const b = 0.75;
  const unique = [...new Set(terms)];
  return kb.docTokens.map((tf, i) => {
    let score = 0;
    for (const t of unique) {
      const f = tf.get(t);
      if (!f) continue;
      const n = kb.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * kb.docLen[i]) / kb.avgLen));
    }
    return score;
  });
}

function nameBoost(kb: LoadedKb, normalizedQuery: string): number[] {
  const q = ` ${normalizedQuery} `;
  return kb.nameKeys.map((keys) => {
    let best = 0;
    for (const k of keys) {
      if (q.includes(` ${k} `)) best = Math.max(best, k.split(' ').length);
    }
    return best;
  });
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
    r.alt.length ? `(${r.alt.slice(0, 6).join(', ')})` : '',
    r.definition,
    `Symptoms: ${r.symptoms.join('; ')}`,
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

function ranks(scores: number[], top: number): Map<number, number> {
  const order = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, top);
  return new Map(order.map(([, i], r) => [i, r]));
}

export interface DiseaseHit {
  record: DiseaseRecord;
  rerankScore: number | null;
  via: string[];
}

export async function searchDiseases(
  query: string,
  limit: number,
  kbOverride?: LoadedKb,
): Promise<{ hits: DiseaseHit[]; expansion: string[]; modes: string[]; errors: string[] } | null> {
  const kb = kbOverride ?? loadDiseaseKb();
  if (kb == null) return null;
  const expansion = expandQuery(query);
  const englishQuery = [query.replace(/[\u0980-\u09FF]+/g, ' '), ...expansion].join(' ').replace(/\s+/g, ' ').trim();
  const terms = tokenize(englishQuery);
  const modes: string[] = [];
  const errors: string[] = [];

  const kw = bm25(kb, terms);
  const boost = nameBoost(kb, terms.join(' '));
  modes.push('keyword');

  let sem: number[] | null = null;
  try {
    const embedQuery = expansion.length ? `${query} (${expansion.join(', ')})` : query;
    sem = await semanticScores(kb, embedQuery);
    if (sem) modes.push('semantic');
  } catch (e) {
    errors.push(`semantic search unavailable (${(e as Error).message}); keyword results only`);
  }

  const kwRank = ranks(kw, 50);
  const semRank = sem ? ranks(sem, 50) : new Map<number, number>();
  const fused = new Map<number, number>();
  const add = (m: Map<number, number>, w: number) => {
    for (const [i, r] of m) fused.set(i, (fused.get(i) ?? 0) + w / (60 + r));
  };
  add(kwRank, 1);
  add(semRank, 1);
  boost.forEach((b, i) => {
    if (b > 0) fused.set(i, (fused.get(i) ?? 0) + 0.02 * b);
  });
  const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([i]) => i);
  if (candidates.length === 0) {
    return { hits: [], expansion, modes, errors };
  }

  let order: Array<{ i: number; score: number | null }> = candidates.map((i) => ({ i, score: null }));
  try {
    const rq = hasBangla(query) || expansion.length ? englishQuery : query;
    const rs = await rerank(rq, candidates.map((i) => rerankText(kb.file.records[i])));
    if (rs) {
      modes.push('rerank');
      // Keep an exact name hit in front of a reranker that prefers a longer neighbour.
      order = candidates
        .map((i, k) => ({ i, score: rs[k], key: rs[k] + (boost[i] > 0 ? 1 : 0) }))
        .sort((a, b) => b.key - a.key);
    }
  } catch (e) {
    errors.push(`reranker unavailable (${(e as Error).message}); fused order used`);
  }

  const hits = order.slice(0, limit).map(({ i, score }) => ({
    record: kb.file.records[i],
    rerankScore: score,
    via: [kwRank.has(i) ? 'keyword' : '', semRank.has(i) ? 'semantic' : '', boost[i] > 0 ? 'name' : ''].filter(Boolean),
  }));
  return { hits, expansion, modes, errors };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderRecord(r: DiseaseRecord, citation: string, detailed: boolean): string {
  const max = detailed ? 700 : 260;
  const rows: Array<[string, unknown]> = [
    ['Also called', clip(r.alt.join(', '), 200)],
    ['Category', clip(`${r.category}${r.subcategory ? ` — ${r.subcategory}` : ''}`, 160)],
    ['Definition', clip(r.definition, max)],
    ['Key symptoms', clip(r.symptoms.join('; '), max)],
    ['Other signs', detailed ? clip(r.other_signs, max) : ''],
    ['Causes', clip(r.causes, max)],
    ['Risk factors', detailed ? clip(r.risk_factors, max) : ''],
    ['Transmission', clip(r.transmission, 200)],
    ['Commonly affected', clip(r.age_group, 200)],
    ['Severity (dataset wording)', clip(r.severity, 240)],
    ['Warning signs / complications', clip(r.warning_signs, max)],
    ['Diagnosis', detailed ? clip(r.diagnosis, max) : ''],
    ['Prevention / management notes (dataset)', detailed ? clip(r.prevention_management, max) : ''],
    ['Dataset cites', `${r.source_name}${r.source_url ? ` — ${r.source_url}` : ''}`],
    ['Cite as', citation],
  ];
  const flags: string[] = [];
  if (r.terse) flags.push('record is terse/abbreviated');
  if (r.source_is_homepage) flags.push('cited source is a homepage, not a specific page');
  if (flags.length) rows.push(['Quality flags', flags.join('; ')]);
  return `${heading(`${r.name} [${r.id}]`)}\n${definitionList(rows)}`;
}

export const diseaseKnowledgeTools = [
  defineTool({
    name: 'disease_knowledge_search',
    group: 'conditions',
    title: 'Disease knowledge base search (Global Disease Master Chart, local RAG)',
    description:
      'Hybrid (keyword + semantic + rerank) search over a local knowledge base of ~900 diseases (the "Global Disease Master Chart" v2.3 dataset): definition, key symptoms, causes, risk factors, transmission, affected age group, severity wording, warning signs/complications, diagnostic methods and prevention/management notes, each with the authority the dataset cites (WHO, CDC, NIH, NHS, specialty societies). ' +
      'Use it FIRST for general questions about what a disease is, its symptoms, causes, spread, who it affects and how it is diagnosed or prevented, and to list conditions that match a symptom picture as background (never as a diagnosis). Accepts English, Bangla or Banglish; an English disease name gives the best match. ' +
      'It is a compiled reference table, not a guideline: never take a dose, a threshold or a treatment decision from it — use drug_label / pubmed_search / web_search (DGHS, WHO) for those and for anything current such as outbreak status. Run emergency_triage_check before this tool when the user describes symptoms.',
    readOnly: true,
    inputSchema: {
      query: z
        .string()
        .min(2)
        .max(400)
        .describe(
          'Disease name or question, e.g. "dengue warning signs", "typhoid causes", "ডেঙ্গুর লক্ষণ", "kalajor ki". Prefer the English disease name when you know it.',
        ),
      limit: z.number().int().min(1).max(6).optional().describe('How many diseases to return (default 3).'),
    },
    async handler(args, { env }) {
      const limit = clampInt(args.limit, 1, 6, 3);
      const result = await searchDiseases(args.query, limit);
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
      if (result.hits.length === 0) {
        return composeResult({
          headline: `No disease in the ${label} knowledge base matched "${args.query}".`,
          notices: [
            'Not covered by the local dataset. Use condition_lookup, pubmed_search or web_search instead, and do not fill the gap from memory.',
            ...result.errors,
          ],
          sources: [],
          env,
        });
      }
      const top = result.hits[0];
      // medtools returns sigmoid relevance in 0..1; below ~0.1 the best record is off-topic.
      const weak = top.rerankScore != null && top.rerankScore < 0.1 && !top.via.includes('name');
      const sections = result.hits.map((h, k) =>
        renderRecord(h.record, `${label}, record ${h.record.id} (source: ${h.record.source_name || 'not stated'})`, k < 2),
      );
      const sources: SourceRef[] = result.hits.map((h) => ({
        name: `${label} — ${h.record.name} [${h.record.id}]`,
        url: h.record.source_url || 'local dataset',
        note: `local disease dataset; cites ${h.record.source_name || 'no authority'}`,
      }));
      const notices = [
        `Cite this as "${label}" plus the record ID, and name the authority it cites (e.g. "CDC-এর তথ্য অনুযায়ী, Global Disease Master Chart [D0051]"). It is a compiled reference table (marked self-verified, no author or licence stated): good for orientation, not proof. Confirm anything decision-relevant with the cited authority, a guideline (pubmed_search) or web_search.`,
        'Never take a dose, a lab threshold or a treatment choice from this dataset. Its "prevention" column often holds management notes; report them only as general background and refer treatment to a clinician.',
        'A symptom match is a list of conditions to consider, not a diagnosis. Keep the emergency triage result first in the reply.',
      ];
      if (weak) {
        notices.unshift('Weak match: the reranker scored even the best record low, so the dataset may not cover this question. Say so, or use web_search / pubmed_search.');
      }
      if (result.expansion.length) {
        notices.push(`Bangla/Banglish words were read as: ${result.expansion.join('; ')}.`);
      }
      notices.push(...result.errors);
      return composeResult({
        headline: `${result.hits.length} match(es) from the ${label} disease knowledge base for "${args.query}" (${result.modes.join(' + ')} search).`,
        sections,
        notices,
        sources,
        env,
      });
    },
  }),
];
