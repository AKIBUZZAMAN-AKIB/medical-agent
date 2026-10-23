import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  heading,
  type SourceRef,
} from '../format.js';
import { defineTool } from '../types.js';

interface GenericEntry {
  n: string;
  c: number;
  ind: string;
  ci: string;
  pl: string;
  who: string | null;
  neml: number;
  ddi: Array<[string, string]>;
}

type BrandTuple = [
  name: string,
  genericIdx: number,
  formIdx: number,
  strength: string,
  manufacturerIdx: number,
  unitPriceBdt: number | null,
  stripPriceBdt: number | null,
  medexSlug: string,
];

interface BdDrugBankCorpus {
  meta: {
    dataset: string;
    citation: string;
    sourceUrl: string;
    brandCount: number;
    genericCount: number;
    manufacturerCount: number;
    formCount: number;
    classCount: number;
  };
  manufacturers: string[];
  forms: string[];
  classes: string[];
  generics: GenericEntry[];
  brands: BrandTuple[];
}

interface IndexedCorpus {
  raw: BdDrugBankCorpus;
  brandsByGeneric: Map<number, number[]>;
  normBrands: string[];
  normGenerics: string[];
}

let cachedIndex: IndexedCorpus | null = null;

function normalizeDrugQuery(input: string): string {
  return input
    .toLowerCase()
    .replace(
      /^\s*(?:tab|tablet|cap|capsule|syp|syrup|inj|injection|susp|suspension|drops?|cream|ointment|gel|inhaler)\.?\s+/i,
      '',
    )
    .replace(/[^a-z0-9+./]+/g, ' ')
    .trim();
}

function cleanBrandCore(input: string): { core: string; strengthHint: string } {
  const normalized = normalizeDrugQuery(input);
  const strengthMatch = normalized.match(/\b(\d+(?:\.\d+)?(?:\s*[+/]\s*\d+(?:\.\d+)?)*(?:\s*(?:mg|mcg|g|ml|iu|%))?)\s*$/i);
  if (strengthMatch != null && strengthMatch.index != null && strengthMatch.index > 1) {
    return {
      core: normalized.slice(0, strengthMatch.index).trim(),
      strengthHint: strengthMatch[1].replace(/\s+/g, ''),
    };
  }
  return { core: normalized, strengthHint: '' };
}

function resolveCorpusPath(): string {
  const candidates = [
    typeof __dirname === 'string' ? resolve(__dirname, '../../data/bddrugbank-compact.json.gz') : '',
    process.argv[1] ? resolve(dirname(process.argv[1]), '../data/bddrugbank-compact.json.gz') : '',
    resolve(process.cwd(), 'data/bddrugbank-compact.json.gz'),
    resolve(process.cwd(), 'packages/mcp-medical/data/bddrugbank-compact.json.gz'),
  ].filter((entry) => entry.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'BDDrugBank corpus archive (data/bddrugbank-compact.json.gz) was not found in the workspace.',
  );
}

export function loadBdDrugBankIndex(): IndexedCorpus {
  if (cachedIndex != null) {
    return cachedIndex;
  }
  const gzBuffer = readFileSync(resolveCorpusPath());
  const raw = JSON.parse(gunzipSync(gzBuffer).toString('utf8')) as BdDrugBankCorpus;
  const brandsByGeneric = new Map<number, number[]>();
  const normBrands = raw.brands.map((b, idx) => {
    const list = brandsByGeneric.get(b[1]) ?? [];
    list.push(idx);
    brandsByGeneric.set(b[1], list);
    return b[0].toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
  });
  const normGenerics = raw.generics.map((g) =>
    g.n.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim(),
  );

  cachedIndex = { raw, brandsByGeneric, normBrands, normGenerics };
  return cachedIndex;
}

function formatBdt(unit: number | null, strip: number | null): string {
  const parts: string[] = [];
  if (unit != null) {
    parts.push(`৳${unit.toFixed(2)}/unit`);
  }
  if (strip != null) {
    parts.push(`৳${strip.toFixed(2)}/strip`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Price not listed';
}

export const formularyTools = [
  defineTool({
    name: 'bd_medicine_lookup',
    group: 'formulary',
    title: 'Bangladesh medicine & BDT price lookup (BDDrugBank)',
    description:
      'Resolve any Bangladeshi prescription brand name (across 24,725 marketed DGDA/MedEx formulations) or INN generic name (1,553 generics across 387 manufacturers) to its active generic ingredient(s), dosage form, strength, manufacturer, Bangladesh Taka (৳ BDT) unit/strip price, lowest-cost bioequivalent alternatives, WHO 2025 Essential Medicines List status, and monograph interaction signals. Always follow up with drug_lookup, drug_label, drug_interaction_check, or drug_lactation on the resolved INN generic ingredients.',
    readOnly: true,
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe(
          'Bangladeshi brand name (e.g. "Sergel 20", "Napa Extend", "Bizoran 5/20", "Monas 10", "Cef-3") or INN generic name (e.g. "Esomeprazole", "Amlodipine + Olmesartan")',
        ),
      dosage_form: z
        .string()
        .optional()
        .describe('Optional dosage form filter such as "Tablet", "Capsule", "Syrup", "Injection", or "Drop"'),
      max_alternatives: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum number of bioequivalent brand options to list (default 8)'),
    },
    async handler(args, { env }) {
      const index = loadBdDrugBankIndex();
      const { raw, brandsByGeneric, normBrands, normGenerics } = index;
      const limit = clampInt(args.max_alternatives, 1, 20, 8);
      const formFilter = args.dosage_form?.trim().toLowerCase() ?? '';
      const fullNorm = normalizeDrugQuery(args.query);
      const { core, strengthHint } = cleanBrandCore(args.query);

      const brandMatches: Array<{ idx: number; score: number }> = [];
      for (let i = 0; i < normBrands.length; i += 1) {
        const bn = normBrands[i];
        const tuple = raw.brands[i];
        const formName = raw.forms[tuple[2]]?.toLowerCase() ?? '';
        if (formFilter && !formName.includes(formFilter)) {
          continue;
        }
        let score = 0;
        if (bn === fullNorm || bn === core) {
          score = 100;
        } else if (core.length >= 3 && bn.startsWith(`${core} `)) {
          score = 88;
        } else if (core.length >= 3 && bn.startsWith(core)) {
          score = 80;
        } else if (core.length >= 4 && bn.includes(core)) {
          score = 62;
        }
        if (score > 0 && strengthHint) {
          const compactStrength = tuple[3].toLowerCase().replace(/\s+/g, '');
          if (compactStrength.includes(strengthHint)) {
            score += 15;
          }
        }
        if (score > 0) {
          brandMatches.push({ idx: i, score });
        }
      }
      brandMatches.sort((a, b) => b.score - a.score);

      const genericMatches: Array<{ gi: number; score: number }> = [];
      for (let gi = 0; gi < normGenerics.length; gi += 1) {
        const gn = normGenerics[gi];
        let score = 0;
        if (gn === fullNorm || gn === core) {
          score = 98;
        } else if (core.length >= 4 && gn.startsWith(core)) {
          score = 82;
        } else if (core.length >= 4 && gn.includes(core)) {
          score = 66;
        }
        if (score > 0) {
          genericMatches.push({ gi, score });
        }
      }
      genericMatches.sort((a, b) => b.score - a.score);

      const topBrandScore = brandMatches[0]?.score ?? 0;
      const topGenericScore = genericMatches[0]?.score ?? 0;

      if (topBrandScore === 0 && topGenericScore === 0) {
        return composeResult({
          headline: `No exact Bangladeshi formulation match found in BDDrugBank (${raw.meta.brandCount.toLocaleString()} brands) for "${args.query}".`,
          sections: [
            'Check spelling of the Bangladeshi trade name or query the active INN generic directly with drug_lookup / RxNorm.',
          ],
          sources: [{ name: 'BDDrugBank v1.0.0', url: raw.meta.sourceUrl }],
          env,
        });
      }

      const primaryGenericIdx =
        topBrandScore >= topGenericScore
          ? raw.brands[brandMatches[0].idx][1]
          : genericMatches[0].gi;
      const generic = raw.generics[primaryGenericIdx];
      const siblingIndices = (brandsByGeneric.get(primaryGenericIdx) ?? []).filter((idx) => {
        if (!formFilter) {
          return true;
        }
        return (raw.forms[raw.brands[idx][2]]?.toLowerCase() ?? '').includes(formFilter);
      });

      const pricedSiblings = siblingIndices
        .map((idx) => raw.brands[idx])
        .filter((b): b is BrandTuple & { 5: number } => b[5] != null && b[5] > 0)
        .sort((a, b) => a[5] - b[5]);

      const minPrice = pricedSiblings[0]?.[5] ?? null;
      const maxPrice = pricedSiblings[pricedSiblings.length - 1]?.[5] ?? null;

      const sources: SourceRef[] = [
        {
          name: 'BDDrugBank v1.0.0 (DGDA/MedEx Bangladesh Corpus)',
          url: raw.meta.sourceUrl,
          note: `${raw.meta.brandCount.toLocaleString()} brands / ${raw.meta.genericCount.toLocaleString()} generics`,
        },
      ];
      if (generic.who != null) {
        sources.push({ name: 'WHO Model List of Essential Medicines (2025)', url: generic.who });
      }

      const sections: string[] = [];
      const SALT_SUFFIX_RE =
        /\b(besilate|besylate|medoxomil|hydrochloride|hcl|sodium|potassium|calcium|magnesium|trihydrate|monohydrate|dihydrate|maleate|tartrate|succinate|fumarate|mesylate|citrate|phosphate|sulfate|sulphate|acetate|bromide|nitrate|valerate|propionate|dipropionate|hemihydrate|anhydrous)\b/gi;
      const ingredientList = generic.n
        .split('+')
        .map((item) => item.replace(SALT_SUFFIX_RE, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      sections.push(
        [
          heading('Resolved Active Generic & Essential Status'),
          definitionList([
            ['Active Generic (INN)', generic.n],
            [
              'Individual Ingredients for FDA/RxNorm/LactMed Lookup',
              ingredientList.join(', '),
            ],
            ['Therapeutic Class', raw.classes[generic.c]],
            [
              'WHO 2025 Essential Medicines List',
              generic.who != null ? `Listed (${generic.who})` : 'Not listed under exact INN stem',
            ],
            [
              'Bangladesh National Essential Medicines List (NEML)',
              generic.neml === 1 ? 'Included in BD NEML' : 'Non-NEML / specialized formulation',
            ],
            ['Total Marketed Brands in Bangladesh', siblingIndices.length],
            [
              'Bangladesh Unit Price Range (BDT)',
              minPrice != null && maxPrice != null
                ? `৳${minPrice.toFixed(2)} – ৳${maxPrice.toFixed(2)} per unit`
                : 'Unit price not reported',
            ],
          ]),
        ].join('\n'),
      );

      if (brandMatches.length > 0 && topBrandScore >= 62) {
        const matchedRows = brandMatches.slice(0, Math.min(limit, 6)).map(({ idx }) => {
          const b = raw.brands[idx];
          const g = raw.generics[b[1]];
          const medexUrl = b[7] ? `https://medex.com.bd/brands/${b[7]}` : undefined;
          if (medexUrl && sources.length < 5) {
            sources.push({ name: `MedEx BD — ${b[0]}`, url: medexUrl });
          }
          return `${b[0]} (${raw.forms[b[2]]}, ${b[3] || 'standard'}) — Generic: ${g.n} | Mfg: ${raw.manufacturers[b[4]]} | ${formatBdt(b[5], b[6])}`;
        });
        sections.push([heading('Matched Bangladeshi Brand Formulations'), bulletList(matchedRows)].join('\n'));
      }

      if (pricedSiblings.length > 0) {
        const affordableRows = pricedSiblings.slice(0, limit).map((b) => {
          return `${b[0]} (${raw.forms[b[2]]}, ${b[3] || 'standard'}) — ${raw.manufacturers[b[4]]} — ${formatBdt(b[5], b[6])}`;
        });
        sections.push(
          [
            heading(`Lowest-Unit-Price Bioequivalent Brands in Bangladesh (${generic.n})`),
            bulletList(affordableRows),
          ].join('\n'),
        );
      }

      const monographDetails = definitionList([
        ['Indications Summary', generic.ind],
        ['Contraindications Summary', generic.ci],
        ['Pregnancy & Lactation Note (Verify PLLR / LactMed)', generic.pl],
      ]);
      if (monographDetails.length > 0) {
        sections.push([heading('Bangladesh Monograph Summary'), monographDetails].join('\n'));
      }

      if (generic.ddi.length > 0) {
        sections.push(
          [
            heading('BDDrugBank Monograph Interaction Signals'),
            bulletList(generic.ddi.map(([target, snippet]) => `${target}: ${snippet}`)),
          ].join('\n'),
        );
      }

      return composeResult({
        headline: `BDDrugBank resolved "${args.query}" -> ${generic.n} (${siblingIndices.length} marketed formulations in Bangladesh).`,
        sections,
        sources,
        notices: [
          'For combination products, run drug_lookup, drug_label, drug_interaction_check, and drug_lactation on EACH individual active ingredient separately.',
          'Retail pharmacy prices in Bangladesh (৳ BDT) reflect BDDrugBank / MedEx reference MRP and should be confirmed with a licensed pharmacist before switching brands.',
        ],
        env,
      });
    },
  }),
];
