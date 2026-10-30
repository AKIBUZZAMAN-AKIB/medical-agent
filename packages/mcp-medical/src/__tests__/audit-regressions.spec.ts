/**
 * Regression tests for the defects found in the 2026-10-26 deep audit.
 *
 * Each `describe` names the behaviour that was wrong, so a failure here says what
 * broke rather than only where. Fixtures are synthetic; no upstream is contacted.
 */
import { orchestrationTools } from '../tools/orchestration.js';
import { calculatorTools } from '../tools/calculators.js';
import { literatureTools } from '../tools/literature.js';
import { drugTools } from '../tools/drugs.js';
import { allTools } from '../tools/index.js';
import { resultHints } from '../language.js';
import { UpstreamError } from '../errors.js';
import { HttpClient } from '../http.js';
import { loadEnv } from '../env.js';

const env = loadEnv({});

/** An HttpClient whose upstream answers are scripted per URL substring. */
function scriptedHttp(
  routes: Array<{ match: string; body?: unknown; status?: number }>,
): HttpClient {
  return new HttpClient({
    env,
    sleep: async () => undefined,
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      const route = routes.find((candidate) => url.includes(candidate.match));
      if (route == null) {
        return new Response('{"results":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (route.status != null && route.status >= 400) {
        return new Response(JSON.stringify({ error: 'scripted' }), {
          status: route.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(route.body ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

/** Present in the catalogue; the assertion documents that, so a rename cannot pass silently. */
function requireTool<T extends { name: string }>(tools: readonly T[], name: string): T {
  const found = tools.find((tool) => tool.name === name);
  if (found == null) {
    throw new Error(`tool ${name} is missing from the catalogue`);
  }
  return found;
}

const interactionTool = requireTool(drugTools, 'drug_interaction_check');
const fullTextTool = requireTool(literatureTools, 'read_full_text');

const LABEL_ASPIRIN = {
  openfda: { rxcui: ['1191'] },
  drug_interactions:
    'Acetylsalicylic acid may increase the effect of anticoagulants. Sodium content per tablet is 30 mg.',
  contraindications: 'Do not use with a history of asthma.',
};

const LABEL_VALPROATE = {
  openfda: { rxcui: ['11118'] },
  drug_interactions: 'Valproate increases the serum concentration of lamotrigine.',
  contraindications: 'Hepatic disease.',
};

const labelRoutes = [
  { match: '%22aspirin%22', body: { results: [LABEL_ASPIRIN] } },
  { match: '%22valproic+acid%22', body: { results: [LABEL_VALPROATE] } },
];

describe('drug_interaction_check names a drug only when the label names it', () => {
  it('does not call "acid" a mention of valproic acid', async () => {
    // The aspirin label says "Acetylsalicylic acid …". A word-split match treated
    // the shared token "acid" as the other drug being named and told the model to
    // "treat it as a labelled interaction".
    const out = await interactionTool.handler(
      { drug_a: 'aspirin', drug_b: 'valproic acid' },
      { env, http: scriptedHttp(labelRoutes) },
    );
    const text = String(out.text ?? out);
    expect(text).not.toMatch(/names valproic acid/i);
    expect(text).toMatch(/does not name valproic acid/i);
  });

  it('does not call "sodium" a mention of sodium valproate', async () => {
    const routes = [
      { match: '%22aspirin%22', body: { results: [LABEL_ASPIRIN] } },
      {
        match: '%22sodium+valproate%22',
        body: {
          results: [
            {
              openfda: { rxcui: ['40254'] },
              drug_interactions: 'Sodium valproate increases lamotrigine levels.',
              contraindications: 'Urea cycle disorders.',
            },
          ],
        },
      },
    ];
    const out = await interactionTool.handler(
      { drug_a: 'aspirin', drug_b: 'sodium valproate' },
      { env, http: scriptedHttp(routes) },
    );
    const text = String(out.text ?? out);
    // "Sodium content per tablet" in the aspirin label must not read as the drug.
    expect(text).not.toMatch(/aspirin's label text names sodium valproate/i);
  });

  it('still finds a drug the label does name in full', async () => {
    const routes = [
      {
        match: '%22aspirin%22',
        body: {
          results: [
            {
              openfda: { rxcui: ['1191'] },
              drug_interactions: 'Aspirin increases the effect of warfarin.',
              contraindications: 'Active bleeding.',
            },
          ],
        },
      },
      {
        match: '%22warfarin%22',
        body: {
          results: [
            {
              openfda: { rxcui: ['11289'] },
              drug_interactions: 'Aspirin increases bleeding risk.',
              contraindications: 'Pregnancy.',
            },
          ],
        },
      },
    ];
    const out = await interactionTool.handler(
      { drug_a: 'aspirin', drug_b: 'warfarin' },
      { env, http: scriptedHttp(routes) },
    );
    expect(String(out.text ?? out)).toMatch(/names warfarin/i);
  });

  it('treats hyphen and space inside one name as the same name', async () => {
    const routes = [
      {
        match: '%22amoxicillin+clavulanate%22',
        body: {
          results: [
            {
              openfda: { rxcui: ['19711'] },
              drug_interactions:
                'Amoxicillin-clavulanate may reduce the effect of oral contraceptives.',
              contraindications: 'Penicillin allergy.',
            },
          ],
        },
      },
      {
        match: '%22warfarin%22',
        body: {
          results: [
            {
              openfda: { rxcui: ['11289'] },
              drug_interactions: 'Amoxicillin-clavulanate may alter the INR.',
              contraindications: 'Pregnancy.',
            },
          ],
        },
      },
    ];
    const out = await interactionTool.handler(
      { drug_a: 'amoxicillin clavulanate', drug_b: 'warfarin' },
      { env, http: scriptedHttp(routes) },
    );
    // "amoxicillin clavulanate" (space) must find "Amoxicillin-clavulanate" (hyphen).
    expect(String(out.text ?? out)).toMatch(/warfarin's label text names amoxicillin clavulanate/i);
  });
});

describe('read_full_text separates "not in the archive" from "could not reach it"', () => {
  it('reports an upstream outage as an outage, not as a missing full text', async () => {
    // A 503 used to be swallowed by `.catch(() => …)` and reported as the factual
    // claim "Europe PMC has no full text for PMC…".
    let caught: unknown;
    try {
      await fullTextTool.handler(
        { id: 'PMC8379165', sections: ['results'] },
        { env, http: scriptedHttp([{ match: '/fullTextXML', status: 503 }]) },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as Error).message).not.toMatch(/has no full text/i);
  });

  it('still reports a real 404 as "no open-access full text"', async () => {
    await expect(
      fullTextTool.handler(
        { id: 'PMC8379165', sections: ['results'] },
        { env, http: scriptedHttp([{ match: '/fullTextXML', status: 404 }]) },
      ),
    ).rejects.toThrow(/has no full text/i);
  });
});

describe('lab_result_interpreter refuses to read a value in the wrong unit', () => {
  const labTool = requireTool(calculatorTools, 'lab_result_interpreter');

  it('does not turn a normal SI panel into panic values', async () => {
    /**
     * The regression this guards: glucose 5.5 mmol/L and creatinine 88 µmol/L read
     * as mg/dL produced "CRITICAL LOW … 5.5 mg/dL" and "CRITICAL HIGH … 88 mg/dL"
     * — two fabricated emergencies out of a healthy report.
     */
    const out = await labTool.handler(
      {
        values: { fasting_glucose: 5.5, creatinine: 88 },
        units: { fasting_glucose: 'mmol/L', creatinine: 'umol/L' },
      } as never,
      { env, http: scriptedHttp([]) },
    );
    const text = String(out.text ?? out);
    expect(text).not.toMatch(/CRITICAL (LOW|HIGH)/i);
    expect(text).toMatch(/Not Interpreted/i);
    expect(text).toMatch(/mmol\/L/);
  });

  it('still flags a genuine panic value given in the conventional unit', async () => {
    const out = await labTool.handler(
      { values: { fasting_glucose: 40 }, units: { fasting_glucose: 'mg/dL' } } as never,
      { env, http: scriptedHttp([]) },
    );
    expect(String(out.text ?? out)).toMatch(/CRITICAL LOW/i);
  });

  it('accepts a unit written with a micro sign or the greek mu', async () => {
    for (const unit of ['\u00b5mol/L', '\u03bcmol/L', 'umol/L']) {
      const out = await labTool.handler(
        { values: { creatinine: 88 }, units: { creatinine: unit } } as never,
        { env, http: scriptedHttp([]) },
      );
      const text = String(out.text ?? out);
      expect(text).toMatch(/Not Interpreted/i);
      expect(text).not.toMatch(/CRITICAL (LOW|HIGH)/i);
    }
  });

  it('keeps interpreting when the declared unit matches the tool', async () => {
    const out = await labTool.handler(
      { values: { fasting_glucose: 95 }, units: { fasting_glucose: 'mg/dL' } } as never,
      { env, http: scriptedHttp([]) },
    );
    expect(String(out.text ?? out)).toMatch(/Within Reference Interval/i);
  });
});

/**
 * §F-40, §F-41, §F-42, §F-43 — no author-written clinical lexicon may decide
 * behaviour in this package.
 *
 * F-41 removed `SPECIALTY_PROFILES` (five profiles of hand-written clinical
 * keywords that chose the "dynamic" specialist by first regex match); F-42
 * removed the keyword-matched population-alert paragraphs from the CPIC tool;
 * F-43 removed a named diagnosis and a management instruction from the lab
 * interpreter. This block fails if any of that comes back.
 */
describe('no predefined clinical keyword list drives behaviour', () => {
  const blueprintTool = orchestrationTools[0];

  it('renders the blueprint from caller-supplied content only', async () => {
    const out = await blueprintTool.handler(
      {
        specialty: 'নিউরোলজি',
        clinical_focus: 'Synthetic case: recurrent headache',
        danger_signs: ['Caller-supplied escalation: any new focal deficit'],
        context_questions: ['Caller-supplied: how did the headache start?'],
        tools: ['lab_result_interpreter', 'not_a_real_tool'],
      },
      { env, http: scriptedHttp([]) },
    );
    const text = String(out.text ?? out);
    expect(text).toContain('নিউরোলজি');
    expect(text).toContain('Caller-supplied escalation: any new focal deficit');
    expect(text).toContain('Caller-supplied: how did the headache start?');
    /** Requested-but-unpublished tools are reported, never silently dropped. */
    expect(text).toMatch(/not published by this server/i);
    expect(text).toContain('not_a_real_tool');
    /** No profile was matched, and the tool says so. */
    expect(text).toMatch(/no profile matched, no keyword list consulted/i);
  });

  it('invents no danger signs when the caller supplies none', async () => {
    const out = await blueprintTool.handler(
      { specialty: 'Cardiology', clinical_focus: 'Synthetic case' },
      { env, http: scriptedHttp([]) },
    );
    const text = String(out.text ?? out);
    expect(text).toContain('No danger signs were supplied');
    expect(text).not.toContain('Danger Signs Needing Urgent Care');
    expect(text).not.toMatch(/red.?flag/i);
    /** A blueprint with no tool choice lists the live catalogue, not a preset. */
    expect(text).toContain('Live MCP Tool Catalogue');
    expect(text).toMatch(/mcpTools": \[\]/);
  });

  it('has no keyword-based emergency tool or label anywhere in the catalogue', () => {
    const names = allTools.map((tool) => tool.name);
    expect(names).not.toContain('emergency_triage_check');
    expect(names.some((name) => /triage|red_?flag/i.test(name))).toBe(false);
    for (const tool of allTools) {
      expect(tool.description).not.toMatch(/emergency_triage_check/);
    }
  });

  it('never adds an emergency label or an emergency-number instruction to a tool result because of a word', () => {
    for (const message of [
      'what is a seizure',
      'heart attack ki',
      'amar baba buke tibro betha, ghame vije jacche',
      'আমার ভাইকে সাপে কামড় দিয়েছে',
      'I want to kill myself',
    ]) {
      const hints = resultHints({ query: message }).join('\n');
      expect(hints).not.toMatch(/EMERGENCY|red.?flag|\b999\b|৯৯৯|🚨/i);
    }
  });

  it('names no diagnosis and no treatment in the lab panel', async () => {
    const labTool = requireTool(calculatorTools, 'lab_result_interpreter');
    const out = await labTool.handler(
      { values: { platelets: 62, hematocrit: 52, wbc: 3.1 } } as never,
      { env, http: scriptedHttp([]) },
    );
    const text = String(out.text ?? out);
    expect(text).toContain('Reported as measurements only');
    expect(text).not.toMatch(/plasma-leakage|warning pattern|avoid NSAIDs/i);
  });
});
