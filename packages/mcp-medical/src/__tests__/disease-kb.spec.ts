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

const FULL_RE = /^(.+) \[(D\d{4}(?:@v[\d.]+|-[a-z])?)\](?: \(older version[^)]*\))?\n-+$/gm;
const COMPACT_RE = /^- (D\d{4}(?:@v[\d.]+|-[a-z])?) .* \| matched: /gm;

async function oneCall(
  args: Record<string, unknown>,
  callEnv = env,
): Promise<{ full: string[]; names: string[]; compact: string[]; text: string }> {
  const out = await tool.handler(args, { env: callEnv, http });
  const text = String(out.text ?? out);
  const full = [...text.matchAll(FULL_RE)];
  return {
    full: full.map((m) => m[2]),
    names: full.map((m) => m[1]),
    compact: [...text.matchAll(COMPACT_RE)].map((m) => m[1]),
    text,
  };
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

  it('groups spellings of one symptom into one concept', () => {
    const plans = planKeywords(['fever', 'jor', 'জ্বর', 'body ache', 'gaye betha']);
    expect(new Set(plans.slice(0, 3).map((p) => p.concept)).size).toBe(1);
    expect(plans[3].concept).toBe(plans[4].concept);
    expect(plans[3].concept).not.toBe(plans[0].concept);
    expect(plans[4].readAs).toContain('myalgia');
  });

  it('keeps Bangla words whole when normalizing', () => {
    expect(normalizeText('জ্বর').trim()).toBe('জ্বর');
    expect(normalizeText('গায়ে ব্যথা').trim().split(' ')).toHaveLength(2);
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
  const SYMPTOMS = ['fever', 'jor', 'body ache', 'gaye betha'];

  it('puts every match in one result, with no paging', async () => {
    const expected = keywordMatches(kb(), planKeywords(SYMPTOMS)).matches.map((m) => m.record.key);
    expect(expected.length).toBeGreaterThan(200);
    const { full, compact, text } = await oneCall({ keywords: SYMPTOMS });
    const got = [...full, ...compact];
    expect(new Set(got).size).toBe(got.length);
    expect(new Set(got)).toEqual(new Set(expected));
    expect(full.length).toBeGreaterThanOrEqual(5);
    expect(text).toMatch(new RegExp(`COMPLETE: all ${expected.length} matching disease records`));
    expect(text).not.toMatch(/next_offset/);
    expect(text.length).toBeLessThanOrEqual((env.diseaseKbMaxChars ?? 160_000) + 40_000);
  });

  it('keeps every match even when the budget is small (compact lines shrink instead)', async () => {
    const expected = keywordMatches(kb(), planKeywords(SYMPTOMS)).matches.map((m) => m.record.key);
    const { full, compact, text } = await oneCall(
      { keywords: SYMPTOMS },
      { ...env, diseaseKbMaxChars: 20_000 },
    );
    expect(new Set([...full, ...compact])).toEqual(new Set(expected));
    expect(text).toMatch(/one line each: (symptoms shortened|ID, name)/);
  });

  it('ranks records that cover more of the described symptoms first', () => {
    const { matches } = keywordMatches(kb(), planKeywords(SYMPTOMS));
    const cover = matches.map((m) => m.coreConcepts);
    expect(cover[0]).toBe(2);
    for (let i = 1; i < cover.length; i += 1) expect(cover[i]).toBeLessThanOrEqual(cover[i - 1]);
  });

  it('gives one record per disease in full and leaves other chart versions in the list', async () => {
    const { names, compact } = await oneCall({ keywords: ['dengue'] });
    const plain = names.map((n) => normalizeText(n).trim());
    expect(new Set(plain).size).toBe(plain.length);
    expect(compact.length).toBeGreaterThan(0);
  });

  it('returns full records by ID', async () => {
    const { full, text } = await oneCall({ ids: ['D0052', 'd0051', 'D9999'] });
    expect(full).toEqual(expect.arrayContaining(['D0052', 'D0051']));
    expect(text).toContain('No record with ID: D9999');
    expect(text).toContain('Symptoms:');
  });

  it('tells the model what it may cite', async () => {
    const { text } = await oneCall({ keywords: ['dengue'] });
    expect(text).toMatch(
      /CITING: you may cite only what this turn's tool results actually contain/,
    );
    expect(text).toMatch(/Sources/);
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
