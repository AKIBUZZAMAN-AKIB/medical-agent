import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  diseaseKnowledgeTools,
  keywordMatches,
  loadDiseaseKb,
  normalizeText,
  planKeywords,
} from '../tools/diseaseKnowledge.js';
import { HttpClient } from '../http.js';
import { loadEnv } from '../env.js';

// The built index is committed (data/disease-kb/disease-kb.json.gz), so these
// tests run against the real dataset.
const KB = resolve(__dirname, '../../data/disease-kb/disease-kb.json.gz');
const env = loadEnv({});
const tool = diseaseKnowledgeTools[0];
const http = new HttpClient({
  env,
  sleep: async () => undefined,
  fetchImpl: async () => new Response('[]'),
});

beforeAll(() => {
  process.env.DISEASE_KB_PATH = KB;
  delete process.env.MEDTOOLS_URL;
  delete process.env.MEDTOOLS_API_KEY;
});

function kb() {
  const loaded = loadDiseaseKb(KB);
  if (loaded == null) throw new Error('index missing');
  return loaded;
}

/** Brute force: every record with the phrase anywhere in its JSON text. */
function bruteForce(phrase: string): Set<string> {
  const p = normalizeText(phrase);
  const out = new Set<string>();
  for (const r of kb().file.records) {
    const values = Object.entries(r)
      .filter(
        ([k]) =>
          ![
            'key',
            'id',
            'source_url',
            'verification',
            'reviewed',
            'versions',
            'same_name_as',
            'superseded_by',
            'realigned',
            'name_list_file',
            'superseded',
            'terse',
            'name_only',
            'source_is_homepage',
          ].includes(k),
      )
      .map(([, v]) => (Array.isArray(v) ? v.join(' ; ') : String(v ?? '')));
    if (values.some((v) => normalizeText(v).includes(p))) out.add(r.key);
  }
  return out;
}

async function allPages(
  keywords: string[],
): Promise<{ keys: string[]; pages: number; texts: string[] }> {
  const keys: string[] = [];
  const texts: string[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const out = await tool.handler({ keywords, offset }, { env, http });
    const text = String(out.text ?? out);
    texts.push(text);
    pages += 1;
    for (const m of text.matchAll(
      /^(.+) \[(D\d{4}(?:@v[\d.]+|-[a-z])?)\](?: \(older version[^)]*\))?\n-+$/gm,
    )) {
      keys.push(m[2]);
    }
    const next = /next_offset=(\d+)/.exec(text);
    if (!next) break;
    offset = Number(next[1]);
    if (pages > 200) throw new Error('runaway paging');
  }
  return { keys, pages, texts };
}

describe('disease knowledge base index (full dataset)', () => {
  it('is committed and loads', () => {
    expect(existsSync(KB)).toBe(true);
    expect(kb().file.records.length).toBeGreaterThan(0);
  });

  it('holds every ID D0001-D2000, every chart version and the name-only IDs', () => {
    const recs = kb().file.records;
    const ids = new Set(recs.map((r) => r.id));
    for (let i = 1; i <= 2000; i += 1) {
      expect(ids.has(`D${String(i).padStart(4, '0')}`)).toBe(true);
    }
    expect(ids.size).toBe(2000);
    expect(recs.filter((r) => !r.name_only)).toHaveLength(1402);
    expect(recs.filter((r) => r.name_only)).toHaveLength(601);
    expect(recs).toHaveLength(2003);
    expect(new Set(recs.map((r) => r.key)).size).toBe(recs.length);
    expect(kb().vectors?.length ?? recs.length).toBe(recs.length);
  });

  it('keeps both versions of the IDs that changed between workbook snapshots', () => {
    for (const id of ['D1300', 'D1350']) {
      const versions = kb().file.records.filter((r) => r.id === id);
      expect(versions).toHaveLength(2);
      expect(versions.filter((r) => r.superseded)).toHaveLength(1);
      expect(versions.find((r) => r.superseded)?.key).toMatch(new RegExp(`^${id}@v`));
    }
  });

  it('does not merge different IDs that name the same disease', () => {
    const g6pd = kb().file.records.filter((r) => r.id === 'D0291' || r.id === 'D0745');
    expect(g6pd).toHaveLength(2);
  });

  it('realigns shifted rows without dropping text', () => {
    const r = kb().file.records.find((x) => x.key === 'D0164');
    expect(r?.realigned).toMatch(/shifted left/);
    expect(r?.source_url).toMatch(/^https?:\/\//);
    expect(r?.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r?.severity).toMatch(/Lifelong/);
    const stray = kb().file.records.find((x) => x.key === 'D0893');
    expect(stray?.extra_cells).toEqual(['202']);
    for (const rec of kb().file.records.filter((x) => !x.name_only)) {
      expect(rec.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps the rows of the other workbook sheets', () => {
    const sheets = new Set((kb().file.sheet_rows ?? []).map((r) => r.sheet));
    expect([...sheets].sort()).toEqual([
      'Disease Categories',
      'Quality Control',
      'Read Me',
      'Source Register',
    ]);
  });
});

describe('disease_knowledge_search keyword matching', () => {
  it('returns every record that contains the keyword in any field', () => {
    const { matches } = keywordMatches(kb(), planKeywords(['dengue']));
    const got = new Set(matches.map((m) => m.record.key));
    expect(got).toEqual(bruteForce('dengue'));
    expect(matches[0].record.name).toMatch(/dengue/i);
    expect(got.size).toBeGreaterThan(3);
  });

  it('matches any of several keywords (union)', () => {
    const a = bruteForce('typhoid');
    const b = bruteForce('cholera');
    const { matches } = keywordMatches(kb(), planKeywords(['typhoid', 'cholera']));
    expect(new Set(matches.map((m) => m.record.key))).toEqual(new Set([...a, ...b]));
  });

  it('reads Banglish and Bangla keywords through the lexicon', () => {
    const plans = planKeywords(['jor', 'ডেঙ্গু', 'kalajor']);
    expect(plans[0].readAs).toContain('fever');
    expect(plans[1].readAs).toContain('dengue');
    expect(plans[2].readAs).toContain('kala-azar');
    const { matches } = keywordMatches(kb(), plans);
    const keys = new Set(matches.map((m) => m.record.key));
    for (const k of bruteForce('fever')) expect(keys.has(k)).toBe(true);
    for (const k of bruteForce('dengue')) expect(keys.has(k)).toBe(true);
  });

  it('skips keywords that would match everything', () => {
    const plans = planKeywords(['disease', 'symptoms']);
    expect(plans.every((p) => p.skipped)).toBe(true);
  });

  it('finds name-only records from the D1401-D2000 lists', () => {
    const nameOnly = kb().file.records.find(
      (r) => r.name_only && r.id >= 'D1401' && !(r.same_name_as ?? []).length,
    );
    expect(nameOnly).toBeDefined();
    const { matches } = keywordMatches(kb(), planKeywords([nameOnly!.name]));
    expect(matches.map((m) => m.record.key)).toContain(nameOnly!.key);
  });
});

describe('disease_knowledge_search tool output', () => {
  it('pages through every match without losing or repeating one', async () => {
    const expected = keywordMatches(kb(), planKeywords(['fever'])).matches.map((m) => m.record.key);
    expect(expected.length).toBeGreaterThan(50);
    const { keys, pages, texts } = await allPages(['fever']);
    expect(pages).toBeGreaterThan(1);
    expect(keys).toEqual(expected);
    expect(texts[0]).toMatch(new RegExp(`All ${expected.length} keyword-matched disease records`));
    expect(texts[texts.length - 1]).toMatch(/Complete: results/);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(env.maxResultChars);
  });

  it('returns every field of a match', async () => {
    const out = await tool.handler({ keywords: ['dengue'] }, { env, http });
    const text = String(out.text ?? out);
    for (const label of [
      'Definition:',
      'Symptoms:',
      'Causes:',
      'Risk factors:',
      'Transmission:',
      'Diagnosis:',
      'Source URL:',
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Never take a dose/);
  });

  it('says when nothing matches', async () => {
    const out = await tool.handler({ keywords: ['zzqxv'] }, { env, http });
    expect(String(out.text ?? out)).toMatch(/No record in the .* contains any of the keywords/);
  });
});
