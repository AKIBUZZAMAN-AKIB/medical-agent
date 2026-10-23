import { z } from 'zod';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  excerpt,
  heading,
  type SourceRef,
} from '../format.js';
import type { Upstream } from '../http.js';
import { defineTool } from '../types.js';

const CPIC_API = 'https://api.cpicpgx.org/v1';

const CPIC_UPSTREAM: Upstream = {
  service: 'CPIC Pharmacogenomics API (api.cpicpgx.org)',
  minIntervalMs: 120,
  cacheTtlMs: 3_600_000,
};

interface CpicPairRow {
  pairid?: number;
  genesymbol?: string;
  drugname?: string;
  guidelineid?: number;
  cpiclevel?: string;
  clinpgxlevel?: string;
  pgxtesting?: string;
  guidelineurl?: string;
  usedforrecommendation?: boolean;
}

interface CpicDrugRow {
  drugid?: string;
  name?: string;
  rxnormid?: string;
  drugbankid?: string;
  flowchart?: string | null;
}

interface CpicRecommendationRow {
  id?: number;
  drugid?: string;
  lookupkey?: Record<string, string>;
  phenotypes?: Record<string, string>;
  implications?: Record<string, string>;
  drugrecommendation?: string;
  classification?: string;
  population?: string;
  comments?: string;
}

const POPULATION_PGX_NOTES: Array<{ match: RegExp; note: string }> = [
  {
    match: /\b(carbamazepine|oxcarbazepine|phenytoin|fosphenytoin|lamotrigine)\b/i,
    note: 'South & Southeast Asian Population Alert: HLA-B*15:02 allele prevalence is markedly elevated across South/Southeast Asian populations (including Bangladesh, India, Malaysia, Thailand, and Southern China) and confers a high risk of life-threatening Stevens-Johnson syndrome / toxic epidermal necrolysis (SJS/TEN) with carbamazepine and related aromatic antiepileptics.',
  },
  {
    match: /\b(clopidogrel|CYP2C19)\b/i,
    note: 'South Asian Population Alert: CYP2C19 loss-of-function alleles (*2, *3) occur in roughly 50%–60% of South Asian individuals, impairing bioactivation of the prodrug clopidogrel and increasing major adverse cardiovascular/cerebrovascular events after PCI or acute coronary syndrome.',
  },
  {
    match: /\b(allopurinol)\b/i,
    note: 'Severe Cutaneous Adverse Reaction Alert: HLA-B*58:01 carriage substantially increases the risk of allopurinol-induced SCAR/DRESS/SJS-TEN, compounded further in chronic kidney disease.',
  },
  {
    match: /\b(azathioprine|mercaptopurine|thioguanine|NUDT15|TPMT)\b/i,
    note: 'South & East Asian Population Alert: Inherited NUDT15 loss-of-function variants are substantially more frequent than TPMT deficiency across South and East Asian patients and cause severe thiopurine-induced myelosuppression at standard doses.',
  },
  {
    match: /\b(codeine|tramadol|CYP2D6)\b/i,
    note: 'Opioid Metabolism Alert: CYP2D6 ultrarapid metabolizers convert codeine/tramadol into excessive active morphine/M1 opioid metabolites (life-threatening respiratory depression, especially in children and breastfed infants), while poor metabolizers experience inadequate analgesia.',
  },
  {
    match: /\b(simvastatin|atorvastatin|rosuvastatin|SLCO1B1|ABCG2)\b/i,
    note: 'Statin Myopathy Alert: SLCO1B1 decreased/poor function variants (and ABCG2 for rosuvastatin) elevate systemic statin exposure and statin-associated musculoskeletal symptoms / myopathy risk.',
  },
  {
    match: /\b(fluorouracil|capecitabine|DPYD)\b/i,
    note: 'Oncology Fluoropyrimidine Toxicity Alert: DPYD decreased/no-function variants cause severe or fatal fluoropyrimidine mucositis, neutropenia, neurotoxicity, and diarrhea without upfront dose reduction or alternative therapy.',
  },
];

export const pharmacogenomicsTools = [
  defineTool({
    name: 'pharmacogenomics_guideline',
    group: 'pharmacogenomics',
    title: 'CPIC pharmacogenomics gene-drug guideline & phenotype lookup',
    description:
      'Query live Clinical Pharmacogenetics Implementation Consortium (CPIC v1.55, api.cpicpgx.org) gene-drug pairs, CPIC/ClinPGx evidence levels, FDA PGx testing status, and phenotype-specific clinical prescribing recommendations (e.g. CYP2C19 + clopidogrel, HLA-B*15:02 + carbamazepine, CYP2D6 + codeine, SLCO1B1 + statins, NUDT15/TPMT + azathioprine, DPYD + fluoropyrimidines). Includes South Asian population allele prevalence alerts.',
    readOnly: true,
    inputSchema: {
      drug: z
        .string()
        .optional()
        .describe('Generic drug name, e.g. "clopidogrel", "carbamazepine", "allopurinol", "simvastatin"'),
      gene: z
        .string()
        .optional()
        .describe('HGNC pharmacogene symbol, e.g. "CYP2C19", "HLA-B", "CYP2D6", "SLCO1B1", "NUDT15", "DPYD"'),
      phenotype: z
        .string()
        .optional()
        .describe(
          'Optional patient metabolizer/HLA status filter, e.g. "Poor Metabolizer", "Intermediate", "Ultrarapid", "positive"',
        ),
      max_recommendations: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum CPIC phenotype recommendation rows to include (default 8)'),
    },
    async handler(args, { env, http }) {
      const drugQuery = args.drug?.trim() ?? '';
      const geneQuery = args.gene?.trim() ?? '';
      if (!drugQuery && !geneQuery) {
        return {
          text: 'Provide at least `drug` (e.g. "clopidogrel"), `gene` (e.g. "CYP2C19"), or both.',
          isError: true,
        };
      }

      const maxRecs = clampInt(args.max_recommendations, 1, 20, 8);
      const pairFilter: Record<string, string> = { order: 'cpiclevel.asc' };
      if (drugQuery) {
        pairFilter.drugname = `ilike.*${drugQuery.replace(/[*%]/g, '')}*`;
      }
      if (geneQuery) {
        pairFilter.genesymbol = `ilike.*${geneQuery.replace(/[*%]/g, '')}*`;
      }

      const pairs = await http.getJson<CpicPairRow[]>(`${CPIC_API}/pair_view`, CPIC_UPSTREAM, {
        query: pairFilter,
      });

      const sources: SourceRef[] = [
        { name: 'CPIC Database & API', url: 'https://cpicpgx.org/guidelines/' },
      ];

      if (!Array.isArray(pairs) || pairs.length === 0) {
        return composeResult({
          headline: `No published CPIC gene-drug pair matched ${[drugQuery, geneQuery].filter(Boolean).join(' / ')}.`,
          sections: [
            'Absence of a CPIC pair means no formal CPIC gene-drug pair matched that INN spelling — resolve brand names first with bd_medicine_lookup or drug_lookup, and check FDA Pharmacogenomic Biomarkers in drug_label.',
          ],
          sources,
          env,
        });
      }

      for (const p of pairs) {
        if (p.guidelineurl && sources.length < 6) {
          sources.push({
            name: `CPIC Guideline (${p.genesymbol ?? 'PGx'} / ${p.drugname ?? 'drug'})`,
            url: p.guidelineurl,
          });
        }
      }

      const sections: string[] = [];
      const pairLines = pairs.slice(0, 15).map((p) => {
        const pieces = [
          `${p.genesymbol ?? '?'} × ${p.drugname ?? '?'}`,
          `CPIC Level: ${p.cpiclevel ?? 'n/a'}`,
          p.clinpgxlevel ? `ClinPGx: ${p.clinpgxlevel}` : '',
          p.pgxtesting ? `Testing: ${p.pgxtesting}` : '',
          p.guidelineurl ? `Guideline: ${p.guidelineurl}` : '',
        ].filter(Boolean);
        return pieces.join(' | ');
      });
      sections.push([heading('CPIC Gene-Drug Evidence Pairs'), bulletList(pairLines)].join('\n'));

      const targetDrugName = drugQuery || pairs[0]?.drugname || '';
      if (targetDrugName) {
        const drugRows = await http.getJson<CpicDrugRow[]>(`${CPIC_API}/drug`, CPIC_UPSTREAM, {
          query: { name: `ilike.*${targetDrugName.replace(/[*%]/g, '')}*`, limit: 3 },
        });
        const matchedDrug = Array.isArray(drugRows) ? drugRows[0] : undefined;
        if (matchedDrug?.drugid) {
          if (matchedDrug.flowchart) {
            sources.push({
              name: `CPIC Clinical Flowchart (${matchedDrug.name ?? targetDrugName})`,
              url: matchedDrug.flowchart,
            });
          }
          const recs = await http.getJson<CpicRecommendationRow[]>(
            `${CPIC_API}/recommendation`,
            CPIC_UPSTREAM,
            { query: { drugid: `eq.${matchedDrug.drugid}`, limit: 40 } },
          );
          if (Array.isArray(recs) && recs.length > 0) {
            const phenoNeedle = args.phenotype?.trim().toLowerCase() ?? '';
            const geneNeedle = geneQuery.toLowerCase();
            const filtered = recs.filter((rec) => {
              const hay = JSON.stringify({
                phenotypes: rec.phenotypes,
                lookupkey: rec.lookupkey,
                implications: rec.implications,
                population: rec.population,
              }).toLowerCase();
              const geneOk = !geneNeedle || hay.includes(geneNeedle);
              const phenoOk = !phenoNeedle || hay.includes(phenoNeedle);
              return geneOk && phenoOk;
            });
            const chosen = (filtered.length > 0 ? filtered : recs).slice(0, maxRecs);
            const recBlocks = chosen.map((rec) => {
              const phenoStr = rec.phenotypes
                ? Object.entries(rec.phenotypes)
                    .map(([g, val]) => `${g}: ${val}`)
                    .join('; ')
                : JSON.stringify(rec.lookupkey ?? {});
              const implStr = rec.implications
                ? Object.entries(rec.implications)
                    .map(([g, val]) => `${g}: ${val}`)
                    .join('; ')
                : '';
              return definitionList([
                ['Phenotype / Genotype', phenoStr],
                ['Population', rec.population],
                ['Clinical Implication', excerpt(implStr, 260)],
                ['CPIC Recommendation', excerpt(rec.drugrecommendation, 340)],
                ['Strength of Recommendation', rec.classification],
                ['Notes', excerpt(rec.comments, 220)],
              ]);
            });
            sections.push(
              [
                heading(`CPIC Phenotype-Specific Recommendations (${matchedDrug.name ?? targetDrugName})`),
                recBlocks.join('\n\n'),
              ].join('\n'),
            );
          }
        }
      }

      const combinedSubject = `${drugQuery} ${geneQuery} ${pairs.map((p) => `${p.genesymbol} ${p.drugname}`).join(' ')}`;
      const popAlerts = POPULATION_PGX_NOTES.filter((item) => item.match.test(combinedSubject)).map(
        (item) => item.note,
      );
      if (popAlerts.length > 0) {
        sections.push([heading('Population Pharmacogenomics Alerts'), bulletList(popAlerts)].join('\n'));
      }

      return composeResult({
        headline: `CPIC returned ${pairs.length} pharmacogenomic gene-drug pair(s) for ${[drugQuery, geneQuery].filter(Boolean).join(' / ')}.`,
        sections,
        sources,
        notices: [
          'CPIC guidelines specify how genetic test results should inform prescribing rather than whether testing must be ordered clinically; never alter an active prescription without a clinician.',
        ],
        env,
      });
    },
  }),
];
