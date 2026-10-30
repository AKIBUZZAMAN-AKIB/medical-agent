import { describeToolGroups, allTools, selectTools } from '../tools/index.js';
import { loadBdDrugBankIndex, formularyTools } from '../tools/formulary.js';
import { pharmacogenomicsTools } from '../tools/pharmacogenomics.js';
import { orchestrationTools } from '../tools/orchestration.js';
import { calculatorTools } from '../tools/calculators.js';
import { HttpClient } from '../http.js';
import { loadEnv } from '../env.js';

const env = loadEnv({});

function mockHttp(routes: Record<string, unknown>): HttpClient {
  return new HttpClient({
    env,
    sleep: async () => undefined,
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

describe('BDDrugBank v1.0.0 Bangladeshi formulary corpus & bd_medicine_lookup', () => {
  const bdTool = formularyTools[0];
  const ctx = { env, http: mockHttp({}) };

  it('indexes all 24,725 Bangladeshi marketed brand formulations across 1,553 generics with zero legacy FDA pregnancy category strings', () => {
    const index = loadBdDrugBankIndex();
    expect(index.raw.brands.length).toBe(24_725);
    expect(index.raw.generics.length).toBe(1_553);
    expect(index.raw.manufacturers.length).toBeGreaterThanOrEqual(380);
    for (const g of index.raw.generics) {
      expect(g.pl).not.toMatch(/\bPregnancy\s+Category\s*[:-]?\s*[ABCDX]\b/i);
    }
  });

  it('resolves common single-ingredient and combination Bangladeshi trade names with BDT pricing and WHO EML links', async () => {
    const sergel = await bdTool.handler({ query: 'Tab. Sergel 20mg', max_alternatives: 5 }, ctx);
    expect(sergel.isError).toBeUndefined();
    expect(sergel.text).toMatch(/Esomeprazole/i);
    expect(sergel.text).toContain('৳');
    expect(sergel.text).toContain('Lowest-Unit-Price Bioequivalent Brands in Bangladesh');

    const bizoran = await bdTool.handler({ query: 'Bizoran 5/20', max_alternatives: 5 }, ctx);
    expect(bizoran.text).toMatch(/Amlodipine/i);
    expect(bizoran.text).toMatch(/Olmesartan/i);
    expect(bizoran.text).toContain(
      'Individual Ingredients for FDA/RxNorm/LactMed Lookup: Amlodipine, Olmesartan',
    );
  });

  it('handles unknown trade names gracefully without fabricating ingredients', async () => {
    const unknown = await bdTool.handler({ query: 'NonexistentZzzQuantumPill999' }, ctx);
    expect(unknown.text).toContain('No exact Bangladeshi formulation match found');
  });
});

describe('CPIC pharmacogenomics_guideline tool', () => {
  const pgxTool = pharmacogenomicsTools[0];

  it('formats CPIC Level A gene-drug pairs and recommendations from the API rows alone', async () => {
    const http = mockHttp({
      '/pair_view': [
        {
          genesymbol: 'CYP2C19',
          drugname: 'clopidogrel',
          cpiclevel: 'A',
          clinpgxlevel: '1A',
          pgxtesting: 'Actionable PGx',
          guidelineurl: 'https://www.clinpgx.org/guideline/PA166251443',
        },
      ],
      '/drug': [
        {
          drugid: 'RxNorm:32968',
          name: 'clopidogrel',
          flowchart: 'https://files.cpicpgx.org/images/flowcharts/Clopidogrel_CDS_Flowchart.jpg',
        },
      ],
      '/recommendation': [
        {
          drugid: 'RxNorm:32968',
          phenotypes: { CYP2C19: 'Poor Metabolizer' },
          implications: {
            CYP2C19: 'Significantly reduced active metabolite formation; increased risk for MACE',
          },
          drugrecommendation:
            'Avoid standard-dose clopidogrel if no contraindication; consider prasugrel or ticagrelor.',
          classification: 'Strong',
          population: 'ACS and/or PCI',
        },
      ],
    });

    const res = await pgxTool.handler(
      { drug: 'clopidogrel', gene: 'CYP2C19', phenotype: 'Poor Metabolizer' },
      { env, http },
    );
    expect(res.isError).toBeUndefined();
    expect(res.text).toContain('CYP2C19 × clopidogrel | CPIC Level: A');
    expect(res.text).toContain('Poor Metabolizer');
    /**
     * The seven hand-written "South Asian Population Alert" paragraphs and the
     * keyword test that chose between them are gone (§F-42). What remains is what
     * CPIC returned; population/allele-frequency context is now the guideline
     * URL's job, not a paraphrase typed into this repository.
     */
    expect(res.text).not.toContain('South Asian Population Alert');
    expect(res.text).toContain('Pairs With CPIC Guidance In This Result');
    expect(res.text).toContain(
      'see the guideline URL above for population and allele-frequency tables',
    );
  });

  it('names the HLA-B × carbamazepine pair from the API data and validates empty input', async () => {
    const emptyRes = await pgxTool.handler({}, { env, http: mockHttp({}) });
    expect(emptyRes.isError).toBe(true);

    const cbzRes = await pgxTool.handler(
      { drug: 'carbamazepine', gene: 'HLA-B' },
      {
        env,
        http: mockHttp({
          '/pair_view': [
            {
              genesymbol: 'HLA-B',
              drugname: 'carbamazepine',
              cpiclevel: 'A',
              clinpgxlevel: '1A',
              pgxtesting: 'Testing required',
              guidelineurl: 'https://cpicpgx.org/guidelines/guideline-for-carbamazepine-and-hla-b/',
            },
          ],
        }),
      },
    );
    expect(cbzRes.text).toContain('HLA-B × carbamazepine');
    expect(cbzRes.text).toContain('Testing required');
    /** No allele text is generated locally: it must come from CPIC or nowhere. */
    expect(cbzRes.text).not.toContain('Stevens-Johnson');
  });
});

describe('MedCalc deterministic clinical_calculator & lab_result_interpreter', () => {
  const [calcTool, labTool] = calculatorTools;
  const ctx = { env, http: mockHttp({}) };

  it('computes all 14 validated clinical calculators accurately with step-by-step derivations', async () => {
    const ckd = await calcTool.handler(
      { calculator: 'ckd_epi_2021', inputs: { age: 65, sex: 'male', creatinine_mg_dl: 1.5 } },
      ctx,
    );
    expect(ckd.text).toContain('51.3 mL/min/1.73m²');
    expect(ckd.text).toContain('G3a');

    const cg = await calcTool.handler(
      {
        calculator: 'cockcroft_gault',
        inputs: { age: 70, sex: 'female', weight_kg: 82, height_cm: 160, creatinine_mg_dl: 1.4 },
      },
      ctx,
    );
    expect(cg.text).toContain('mL/min');
    expect(cg.text).toContain('Adjusted BW');

    const cha = await calcTool.handler(
      {
        calculator: 'cha2ds2_vasc',
        inputs: { age: 76, sex: 'female', hypertension: true, diabetes: true },
      },
      ctx,
    );
    expect(cha.text).toContain('5 / 9 points (4 non-sex points)');

    const hasBled = await calcTool.handler(
      {
        calculator: 'has_bled',
        inputs: {
          age: 72,
          hypertension_uncontrolled: true,
          prior_bleeding: true,
          drugs_antiplatelet_nsaid: true,
        },
      },
      ctx,
    );
    expect(hasBled.text).toContain('4 / 9 points');

    const curb = await calcTool.handler(
      {
        calculator: 'curb_65',
        inputs: { confusion: true, bun_mg_dl: 28, respiratory_rate: 32, systolic_bp: 86, age: 68 },
      },
      ctx,
    );
    expect(curb.text).toContain('5 / 5 points');

    const meld = await calcTool.handler(
      {
        calculator: 'meld_na',
        inputs: { bilirubin_mg_dl: 3.4, inr: 1.9, creatinine_mg_dl: 1.8, sodium_meq_l: 128 },
      },
      ctx,
    );
    expect(meld.text).toContain('MELD-Na: 29');

    const cp = await calcTool.handler(
      {
        calculator: 'child_pugh',
        inputs: {
          bilirubin_mg_dl: 2.5,
          albumin_g_dl: 3.1,
          inr: 1.9,
          ascites: 'mild',
          encephalopathy: 'none',
        },
      },
      ctx,
    );
    expect(cp.text).toContain('9 / 15 points (Class B');

    const wells = await calcTool.handler(
      { calculator: 'wells_pe', inputs: { dvt_signs: true, heart_rate: 112, hemoptysis: true } },
      ctx,
    );
    expect(wells.text).toContain('5.5 points');
    expect(wells.text).toContain('PE Likely');

    const heart = await calcTool.handler(
      {
        calculator: 'heart_score',
        inputs: { history: 2, ecg: 1, age: 58, risk_factors: 2, troponin: 2 },
      },
      ctx,
    );
    expect(heart.text).toContain('8 / 10 points');

    const bmi = await calcTool.handler(
      { calculator: 'bmi_asian_who', inputs: { weight_kg: 68, height_cm: 168 } },
      ctx,
    );
    expect(bmi.text).toContain('BMI 24.1 kg/m²');
    expect(bmi.text).toContain('Overweight / Increased cardiometabolic risk — South Asian cutoff');
    expect(bmi.text).toContain('WHO Normal');

    const ca = await calcTool.handler(
      { calculator: 'corrected_calcium', inputs: { calcium_mg_dl: 7.8, albumin_g_dl: 2.5 } },
      ctx,
    );
    expect(ca.text).toContain('9 mg/dL');

    const ag = await calcTool.handler(
      {
        calculator: 'anion_gap',
        inputs: { sodium_meq_l: 138, chloride_meq_l: 98, bicarbonate_meq_l: 14, albumin_g_dl: 3.0 },
      },
      ctx,
    );
    expect(ag.text).toContain('28.5 mEq/L');

    const qtc = await calcTool.handler(
      { calculator: 'qtc_interval', inputs: { qt_ms: 460, heart_rate_bpm: 84 } },
      ctx,
    );
    expect(qtc.text).toContain('Fridericia QTcF: 515 ms');
    expect(qtc.text).toContain('MARKED QTc PROLONGATION');

    const peds = await calcTool.handler(
      {
        calculator: 'pediatric_dose_check',
        inputs: {
          weight_kg: 45,
          mg_per_kg_per_dose: 15,
          adult_max_single_dose_mg: 500,
          concentration_mg_per_5ml: 250,
        },
      },
      ctx,
    );
    expect(peds.text).toContain('500 mg (10 mL at 250 mg/5 mL)');
    expect(peds.text).toContain('Capped at adult single-dose ceiling');
  });

  it('reports concurrent CBC abnormalities as measurements and critical panic electrolytes', async () => {
    const denguePanel = await labTool.handler(
      {
        values: {
          hemoglobin: 16.2,
          hematocrit: 50,
          platelets: 18,
          wbc: 2.9,
          potassium: 6.3,
          hba1c: 8.0,
          ast: 180,
          alt: 95,
        },
        clinical_context: 'Day 5 febrile illness',
      },
      ctx,
    );
    expect(denguePanel.text).toContain('CRITICAL PANIC VALUE ALERTS');
    expect(denguePanel.text).toContain('CRITICAL LOW Platelets');
    expect(denguePanel.text).toContain('CRITICAL HIGH Serum Potassium');
    /**
     * The panel used to print a named condition here, chosen by a numeric test in
     * `calculators.ts` (§F-43). It now reports the concurrent measurements and
     * explicitly declines to diagnose.
     */
    expect(denguePanel.text).toContain('Reported as measurements only');
    expect(denguePanel.text).not.toContain('Plasma-Leakage');
    expect(denguePanel.text).not.toContain('Warning Pattern');
    expect(denguePanel.text).toContain('Estimated Average Glucose');
    expect(denguePanel.text).toContain('De Ritis');
  });
});

describe('Dynamic specialist_subagent_blueprint & 33-tool registry', () => {
  it('publishes all 33 tools across 11 groups and generates valid agent_dyn_* specs', async () => {
    // 33 lookup tools (incl. disease_knowledge_search); no keyword emergency screen.
    expect(allTools).toHaveLength(33);
    expect(allTools.map((t) => t.name)).toContain('disease_knowledge_search');
    const groups = describeToolGroups();
    for (const g of ['formulary', 'pharmacogenomics', 'calculators', 'orchestration']) {
      expect(groups).toContain(`${g}:`);
    }
    // 1 formulary + 2 calculators.
    expect(selectTools(loadEnv({ MEDICAL_TOOL_GROUPS: 'formulary,calculators' }))).toHaveLength(3);

    const blueprint = await orchestrationTools[0].handler(
      {
        specialty: 'Tropical Infectious Diseases & Dengue',
        clinical_focus: 'High fever day 4 with platelets 62,000 and abdominal pain',
      },
      { env, http: mockHttp({}) },
    );
    expect(blueprint.text).toContain('agent_dyn_tropical_infectious_diseases_dengue');
    /**
     * No profile matching: the label is the requester's, the catalogue is the live
     * registry, and nothing clinical is invented when the caller supplies nothing.
     */
    expect(blueprint.text).toContain('Tropical Infectious Diseases & Dengue');
    expect(blueprint.text).toContain('Live MCP Tool Catalogue');
    expect(blueprint.text).toContain('lab_result_interpreter');
    expect(blueprint.text).toContain('No red-flag triggers were supplied');
    expect(allTools.map((tool) => tool.name)).not.toContain('emergency_triage_check');
  });

  it('transparently fails over condition_lookup to EBI OLS4 MONDO when Monarch returns HTTP 502', async () => {
    const condTool = allTools.find((t) => t.name === 'condition_lookup')!;
    const failoverHttp = new HttpClient({
      env,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('monarchinitiative.org')) {
          return new Response('<html>502 Bad Gateway</html>', { status: 502 });
        }
        return new Response(
          JSON.stringify({
            response: {
              docs: [
                {
                  obo_id: 'MONDO:0005148',
                  label: 'type 2 diabetes mellitus',
                  description: ['Chronic metabolic disorder marked by insulin resistance.'],
                  synonym: ['T2DM'],
                  iri: 'http://purl.obolibrary.org/obo/MONDO_0005148',
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const out = await condTool.handler(
      { condition: 'type 2 diabetes mellitus' },
      { env, http: failoverHttp },
    );
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('MONDO:0005148');
    expect(out.text).toContain('EBI OLS4 failover');
  });
});
