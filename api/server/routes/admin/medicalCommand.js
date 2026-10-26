const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');
const bcrypt = require('bcryptjs');
const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');

const importDynamicEsm = new Function('specifier', 'return import(specifier)');

const MCP_SERVER_NAME = 'medical';
const PARENT_AGENT_ID = 'agent_medical_research';
const DEFAULT_MODEL = 'super-power-doctor-pro';
const requireMedicalAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const TOOL_GROUPS = [
  {
    id: 'bd_formulary',
    label: 'Bangladesh Formulary & BDT Pricing',
    bnLabel: 'বাংলাদেশ ওষুধ ফর্মুলারি ও মূল্য',
    tools: [
      {
        name: 'bd_medicine_lookup',
        summary:
          '24,725 Bangladeshi brands, 1,553 generics, WHO 2025 EML, BD NEML & cheapest BDT equivalents',
        sampleArgs: { query: 'Bizoran 5/20', max_alternatives: 8 },
      },
    ],
  },
  {
    id: 'pharmacology',
    label: 'Pharmacology, Labels & Adverse Events',
    bnLabel: 'ফার্মাকোলজি, এফডিএ লেবেল ও পার্শ্বপ্রতিক্রিয়া',
    tools: [
      {
        name: 'drug_lookup',
        summary: 'RxNorm + OpenFDA + ChEMBL normalized drug monograph lookup',
        sampleArgs: { drug: 'empagliflozin', max_candidates: 5 },
      },
      {
        name: 'drug_label',
        summary:
          'Structured FDA DailyMed prescribing sections (boxed warnings, renal dosing, pregnancy)',
        sampleArgs: { drug: 'metformin' },
      },
      {
        name: 'drug_interaction_check',
        summary: 'Multi-drug DDI severity, mechanism & clinical management',
        sampleArgs: { drug_a: 'warfarin', drug_b: 'amiodarone' },
      },
      {
        name: 'drug_safety_actions',
        summary: 'OpenFDA drug enforcement recalls & safety alerts',
        sampleArgs: { drug: 'valsartan', max_results: 5 },
      },
      {
        name: 'drug_adverse_event_summary',
        summary: 'FAERS post-marketing adverse reaction frequency rankings',
        sampleArgs: { drug: 'atorvastatin', top_n: 8 },
      },
      {
        name: 'drug_class_atc',
        summary: 'WHO Anatomical Therapeutic Chemical (ATC) hierarchy & peer agents',
        sampleArgs: { drug: 'rosuvastatin' },
      },
      {
        name: 'drug_bioactivity',
        summary: 'ChEMBL receptor binding affinities (IC50 / Ki / EC50)',
        sampleArgs: { drug: 'imatinib', max_activities: 6 },
      },
      {
        name: 'compound_properties',
        summary: 'PubChem molecular weight, LogP, SMILES & chemical structure properties',
        sampleArgs: { compound: 'paracetamol', max_synonyms: 6 },
      },
      {
        name: 'drug_lactation',
        summary: 'NIH NLM LactMed maternal milk levels, infant safety & safe alternatives',
        sampleArgs: { drug: 'sertraline' },
      },
    ],
  },
  {
    id: 'pharmacogenomics',
    label: 'Precision Pharmacogenomics (CPIC)',
    bnLabel: 'জিনগত ওষুধ নিরাপত্তা (CPIC PGx)',
    tools: [
      {
        name: 'pharmacogenomics_guideline',
        summary:
          'Live CPIC API v1 gene-drug dosing guidelines + South Asian HLA-B*15:02 / CYP2C19 alerts',
        sampleArgs: { drug: 'clopidogrel', gene: 'CYP2C19' },
      },
    ],
  },
  {
    id: 'calculators',
    label: 'Deterministic Calculators & Lab Panic Interpreter',
    bnLabel: 'ক্লিনিক্যাল ক্যালকুলেটর ও ল্যাব প্যানিক চেকার',
    tools: [
      {
        name: 'clinical_calculator',
        summary:
          '14 verified formulas: 2021 CKD-EPI eGFR, CrCl, MELD-Na, CHA2DS2-VASc, CURB-65, QTc, Pediatric Dose',
        sampleArgs: {
          calculator: 'ckd_epi_2021',
          inputs: { creatinine_mg_dl: 1.9, age: 62, sex: 'male' },
        },
      },
      {
        name: 'lab_result_interpreter',
        summary:
          '26-analyte critical panic thresholds & Dengue hematocrit/platelet plasma-leakage detector',
        sampleArgs: {
          values: {
            platelets: 38,
            hematocrit: 49,
            alt: 185,
            ast: 240,
            potassium: 5.8,
            creatinine: 1.7,
          },
          clinical_context: 'Day 5 fever in Dhaka',
        },
      },
    ],
  },
  {
    id: 'literature',
    label: 'Biomedical Literature & Full-Text Synthesis',
    bnLabel: 'মেডিকেল রিসার্চ, পাবমেড ও ফুল-টেক্সট',
    tools: [
      {
        name: 'pubmed_search',
        summary: 'NIH NCBI PubMed peer-reviewed clinical trial & guideline search',
        sampleArgs: { query: 'dengue fluid management warning signs guideline', max_results: 5 },
      },
      {
        name: 'pubmed_article',
        summary: 'Full structured abstract, MeSH headings, DOI & authors by PMID',
        sampleArgs: { pmids: ['34449189'] },
      },
      {
        name: 'read_full_text',
        summary: 'Full-text PMC open-access article body reader',
        sampleArgs: { id: 'PMC8929171' },
      },
      {
        name: 'europe_pmc_search',
        summary: 'Europe PMC biomedical articles, preprints & citation counts',
        sampleArgs: { query: 'finerenone chronic kidney disease type 2 diabetes', max_results: 5 },
      },
      {
        name: 'literature_citations',
        summary: 'OpenAlex & Europe PMC forward/backward citation network',
        sampleArgs: { pmids: ['34449189'], max_results: 5 },
      },
    ],
  },
  {
    id: 'conditions_genomics',
    label: 'Conditions, Genomics & Precision Oncology',
    bnLabel: 'রোগ নির্ণয়, জিনোমিক্স ও অনকোলজি',
    tools: [
      {
        name: 'condition_lookup',
        summary:
          'Monarch Initiative + EBI OLS4 MONDO high-availability disease nosology & HPO phenotypes',
        sampleArgs: { condition: 'beta thalassemia', max_results: 5 },
      },
      {
        name: 'condition_targets_and_drugs',
        summary: 'Open Targets druggable gene associations & investigational/approved therapeutics',
        sampleArgs: { condition: 'non-small cell lung carcinoma', max_targets: 5, max_drugs: 5 },
      },
      {
        name: 'gene_lookup',
        summary: 'NCBI Gene + Ensembl locus, RefSeq transcripts & functional summary',
        sampleArgs: { gene: 'BRCA1', max_diseases: 5 },
      },
      {
        name: 'protein_lookup',
        summary: 'UniProt human reviewed protein structure, domains & disease involvement',
        sampleArgs: { protein: 'EGFR', max_results: 5 },
      },
      {
        name: 'variant_clinical_significance',
        summary: 'NCBI ClinVar pathogenicity classification & expert review stars',
        sampleArgs: { gene_or_variant: 'BRCA1 c.68_69delAG', max_results: 5 },
      },
    ],
  },
  {
    id: 'coding_trials_public_health',
    label: 'ICD-10 Coding, Clinical Trials & WHO Public Health',
    bnLabel: 'ICD-10 কোডিং, ক্লিনিক্যাল ট্রায়াল ও বিশ্ব স্বাস্থ্য',
    tools: [
      {
        name: 'ontology_search',
        summary: 'EBI OLS4 cross-ontology lookup (MONDO, HPO, EFO, ChEBI, GO)',
        sampleArgs: { term: 'nephrotic syndrome', max_results: 5 },
      },
      {
        name: 'icd10cm_code',
        summary: 'NLM Clinical Tables official ICD-10-CM diagnosis codes',
        sampleArgs: { code_prefix: 'E11', max_results: 8 },
      },
      {
        name: 'clinical_trials',
        summary: 'ClinicalTrials.gov v2 recruiting & completed interventional studies',
        sampleArgs: { query: 'dengue', max_results: 5 },
      },
      {
        name: 'health_statistics',
        summary: 'WHO Global Health Observatory (GHO) country indicators (default BGD)',
        sampleArgs: { search_indicators: 'maternal mortality', country: 'BGD', max_results: 5 },
      },
      {
        name: 'device_approval',
        summary: 'FDA 510(k) & PMA medical device clearance records',
        sampleArgs: { device: 'continuous glucose monitor', max_results: 5 },
      },
      {
        name: 'safety_recalls',
        summary: 'FDA medical device recalls & field safety notices',
        sampleArgs: { product: 'infusion pump', max_results: 5 },
      },
      {
        name: 'provider_lookup',
        summary: 'CMS NPPES National Provider Identifier (NPI) clinician directory',
        sampleArgs: { specialty: 'Cardiology', state: 'NY', max_results: 5 },
      },
      {
        name: 'plain_language_summary',
        summary: 'NIH MedlinePlus patient-friendly plain-language education',
        sampleArgs: { topic: 'high blood pressure' },
      },
      {
        name: 'specialist_subagent_blueprint',
        summary: 'Dynamic specialist sub-agent blueprint & MCP toolset synthesizer',
        sampleArgs: { specialty: 'dermatology', clinical_focus: 'Psoriasis biologic screening' },
      },
    ],
  },
];

const PRESET_SPECIALTY_BLUEPRINTS = [
  {
    key: 'dermatology',
    id: 'agent_dyn_dermatology',
    name: 'Dermatology & Cutaneous Allergy Sub-Agent',
    specialty: 'Dermatology & Cutaneous Drug Reactions',
    description:
      'Evaluates rashes, eczema, psoriasis, fungal/scabies infections, acne, hair loss, and life-threatening SJS/TEN drug eruptions.',
    tools: [
      'bd_medicine_lookup',
      'drug_label',
      'pharmacogenomics_guideline',
      'pubmed_search',
      'condition_lookup',
    ],
    instructions:
      'You are the Dermatology & Cutaneous Allergy Specialist Sub-Agent. Screen immediately for mucosal blistering, skin sloughing, facial swelling, or fever after starting anticonvulsants/allopurinol/sulfonamides (SJS/TEN/DRESS emergency). Provide evidence-graded topical/systemic options and Bangladesh brand availability.',
  },
  {
    key: 'psychiatry_sleep',
    id: 'agent_dyn_psychiatry_sleep',
    name: 'Psychiatry, Sleep & Behavioral Health Sub-Agent',
    specialty: 'Psychiatry, Insomnia & Neuropsychopharmacology',
    description:
      'Assesses insomnia, anxiety, depression, SSRI/benzodiazepine safety, QTc prolongation, serotonin syndrome, and crisis triage.',
    tools: [
      'bd_medicine_lookup',
      'drug_interaction_check',
      'pharmacogenomics_guideline',
      'clinical_calculator',
      'pubmed_search',
    ],
    instructions:
      'You are the Psychiatry & Sleep Specialist Sub-Agent. Prioritize suicide/self-harm safety first (999 emergency & Kaan Pete Roi helpline in Bangladesh), audit CYP2C19/CYP2D6 psychotropic metabolism, check QTc & serotonergic interactions, and combine CBT-I sleep hygiene with safe pharmacotherapy.',
  },
  {
    key: 'gastro_hepatology',
    id: 'agent_dyn_gastro_hepatology',
    name: 'Gastroenterology & Hepatology Sub-Agent',
    specialty: 'Gastroenterology, Liver Cirrhosis & Viral Hepatitis',
    description:
      'Evaluates GI bleeding, GERD/PUD, fatty liver, HBV/HCV, cirrhosis MELD-Na / Child-Pugh staging, and hepatotoxic drug safety.',
    tools: [
      'clinical_calculator',
      'lab_result_interpreter',
      'bd_medicine_lookup',
      'drug_label',
      'pubmed_search',
    ],
    instructions:
      'You are the Gastroenterology & Hepatology Sub-Agent. Screen urgently for hematemesis, melena, jaundice with encephalopathy, or acute severe abdominal pain. Compute MELD-Na and Child-Pugh scores deterministically and adjust hepatically cleared medications.',
  },
  {
    key: 'pulmonology',
    id: 'agent_dyn_pulmonology',
    name: 'Pulmonology, Asthma-COPD & Critical Care Sub-Agent',
    specialty: 'Pulmonology, TB/Pneumonia & Airway Disease',
    description:
      'Evaluates dyspnea, asthma/COPD inhalers, pneumonia CURB-65 severity, SpO2 hypoxia, tuberculosis screening, and pulmonary embolism risk.',
    tools: [
      'clinical_calculator',
      'lab_result_interpreter',
      'bd_medicine_lookup',
      'pubmed_search',
      'icd10cm_code',
    ],
    instructions:
      'You are the Pulmonology & Airway Specialist Sub-Agent. Triage resting dyspnea, SpO2 < 92%, cyanosis, hemoptysis, and chest pain immediately. Stratify community-acquired pneumonia using CURB-65 and verify inhaler technique and beta-blocker compatibility.',
  },
  {
    key: 'ophthalmology',
    id: 'agent_dyn_ophthalmology',
    name: 'Ophthalmology & Neuro-Vision Sub-Agent',
    specialty: 'Ophthalmology, Acute Red Eye & Diabetic Retinopathy',
    description:
      'Evaluates sudden vision loss, painful red eye, angle-closure glaucoma risk, chemical injury, and topical ophthalmic drops.',
    tools: ['bd_medicine_lookup', 'drug_label', 'condition_lookup', 'pubmed_search'],
    instructions:
      'You are the Ophthalmology Sub-Agent. Immediately flag sudden monocular vision loss, curtain-like visual field defect, halos with nausea/headache, contact-lens corneal ulcer pain, or steroid eye drop misuse.',
  },
  {
    key: 'ent_vertigo',
    id: 'agent_dyn_ent_vertigo',
    name: 'ENT, Vertigo & Head-Neck Sub-Agent',
    specialty: 'Otolaryngology, HINTS Vertigo & Airway Infections',
    description:
      'Differentiates peripheral BPPV/vestibular neuritis vs posterior circulation stroke, sinusitis, otitis, and stridor/epiglottitis.',
    tools: ['bd_medicine_lookup', 'drug_interaction_check', 'pubmed_search', 'icd10cm_code'],
    instructions:
      'You are the ENT & Neuro-Otology Sub-Agent. Always screen vertigo for central stroke red flags (diplopia, dysarthria, dysphagia, limb ataxia, inability to walk unassisted) and airway red flags (stridor, drooling, trismus).',
  },
  {
    key: 'orthopedics_pain',
    id: 'agent_dyn_orthopedics_pain',
    name: 'Orthopedics, Rheumatology & Safe Pain Sub-Agent',
    specialty: 'Musculoskeletal, Cauda Equina Screening & Renal-Safe Analgesia',
    description:
      'Evaluates back/joint pain, gout/rheumatoid arthritis, cauda equina red flags, and NSAID alternatives in CKD/GI ulcer/dengue patients.',
    tools: [
      'bd_medicine_lookup',
      'drug_interaction_check',
      'lab_result_interpreter',
      'clinical_calculator',
      'pubmed_search',
    ],
    instructions:
      'You are the Orthopedics, Rheumatology & Pain Sub-Agent. Screen for cauda equina syndrome (saddle anesthesia, urinary retention), septic arthritis, and osteoporotic fracture. Never recommend systemic NSAIDs when CKD, active peptic ulcer, heart failure, anticoagulation, or dengue fever is present.',
  },
  {
    key: 'urology_stone',
    id: 'agent_dyn_urology_stone',
    name: 'Urology, Nephrolithiasis & UTI Stewardship Sub-Agent',
    specialty: 'Urology, Obstructed Infected Stone & Antimicrobial Stewardship',
    description:
      'Evaluates dysuria, pyelonephritis, renal colic, BPH alpha-blockers, hematuria workup, and renal-adjusted urinary antibiotics.',
    tools: [
      'clinical_calculator',
      'lab_result_interpreter',
      'bd_medicine_lookup',
      'drug_interaction_check',
      'pubmed_search',
    ],
    instructions:
      'You are the Urology & Renal Stone Sub-Agent. Immediately flag fever + flank pain with suspected ureteric obstruction (urosepsis decompression emergency) and acute urinary retention. Adjust all antimicrobials to Cockcroft-Gault CrCl.',
  },
  {
    key: 'hematology_nutrition',
    id: 'agent_dyn_hematology_nutrition',
    name: 'Hematology, Thalassemia & Clinical Nutrition Sub-Agent',
    specialty: 'Anemia, Thalassemia Trait vs Iron Deficiency & Coagulopathy',
    description:
      'Interprets microcytic/macrocytic anemia, Mentzer index & Hb electrophoresis for Bangladesh thalassemia carrier screening, and thrombocytopenia.',
    tools: [
      'lab_result_interpreter',
      'condition_lookup',
      'variant_clinical_significance',
      'bd_medicine_lookup',
      'pubmed_search',
    ],
    instructions:
      'You are the Hematology & Nutrition Sub-Agent. In Bangladesh, always distinguish iron deficiency anemia from beta-thalassemia/HbE trait ( ferritin + Hb electrophoresis ) before prolonged empiric iron therapy, and triage severe anemia (Hb < 7 g/dL) or neutropenic fever urgently.',
  },
  {
    key: 'neurology_stroke',
    id: 'agent_dyn_neurology_stroke',
    name: 'Neurology, Stroke & Epilepsy Sub-Agent',
    specialty: 'Acute Neuro-Emergencies, Migraine & Antiepileptic Safety',
    description:
      'Evaluates headache red flags (SNOOP10), seizure management, HLA-B*15:02 screening before carbamazepine/phenytoin, and stroke prevention.',
    tools: [
      'pharmacogenomics_guideline',
      'drug_interaction_check',
      'bd_medicine_lookup',
      'pubmed_search',
      'condition_lookup',
    ],
    instructions:
      'You are the Neurology, Stroke & Epilepsy Sub-Agent. Screen every acute neurological symptom for thunderclap headache, meningeal signs, focal deficit, or status epilepticus, and enforce CPIC HLA-B*15:02 safety screening prior to aromatic anticonvulsants in South Asian patients.',
  },
];

let cachedFormularySummary = null;
let cachedFormularyCorpus = null;

function resolveCorpusFilePath() {
  const candidates = [
    path.resolve(__dirname, '../../../../packages/mcp-medical/data/bddrugbank-compact.json.gz'),
    path.resolve(process.cwd(), 'packages/mcp-medical/data/bddrugbank-compact.json.gz'),
    '/home/user/medical-agent/packages/mcp-medical/data/bddrugbank-compact.json.gz',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadFormularyCorpus() {
  if (cachedFormularyCorpus) {
    return cachedFormularyCorpus;
  }
  const filePath = resolveCorpusFilePath();
  if (!filePath) {
    return null;
  }
  const compressed = fs.readFileSync(filePath);
  const raw = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  const mfrs = raw.mfrs || raw.manufacturers || [];
  const classes = raw.classes || [];
  const forms = raw.forms || [];
  const generics = raw.generics || [];
  const brands = raw.brands || [];
  cachedFormularyCorpus = { mfrs, classes, forms, generics, brands, meta: raw.meta || {} };
  return cachedFormularyCorpus;
}

function getFormularyAnalytics() {
  if (cachedFormularySummary) {
    return cachedFormularySummary;
  }
  const corpus = loadFormularyCorpus();
  if (!corpus) {
    return {
      available: false,
      totalBrands: 0,
      totalGenerics: 0,
      totalManufacturers: 0,
      totalClasses: 0,
      whoEmlGenerics: 0,
      bdNemlGenerics: 0,
      pricedBrands: 0,
      topManufacturers: [],
      topForms: [],
      priceTiers: [],
    };
  }

  const mfrCounts = new Map();
  const formCounts = new Map();
  const tiers = [
    { range: '≤ ৳5', min: 0, max: 5, count: 0 },
    { range: '৳5 – ৳20', min: 5, max: 20, count: 0 },
    { range: '৳20 – ৳100', min: 20, max: 100, count: 0 },
    { range: '৳100 – ৳500', min: 100, max: 500, count: 0 },
    { range: '> ৳500', min: 500, max: Infinity, count: 0 },
  ];

  let pricedBrands = 0;
  for (const b of corpus.brands) {
    // [name, genericIdx, formIdx, strength, mfrIdx, unitPrice, stripPrice]
    const formIdx = b[2];
    const mfrIdx = b[4];
    const unitPrice = Number(b[5] || 0);
    if (mfrIdx != null && corpus.mfrs[mfrIdx]) {
      mfrCounts.set(corpus.mfrs[mfrIdx], (mfrCounts.get(corpus.mfrs[mfrIdx]) || 0) + 1);
    }
    if (formIdx != null && corpus.forms[formIdx]) {
      formCounts.set(corpus.forms[formIdx], (formCounts.get(corpus.forms[formIdx]) || 0) + 1);
    }
    if (unitPrice > 0) {
      pricedBrands += 1;
      for (const tier of tiers) {
        if (unitPrice > tier.min && unitPrice <= tier.max) {
          tier.count += 1;
          break;
        }
      }
    }
  }

  let whoEmlGenerics = 0;
  let bdNemlGenerics = 0;
  let ddiMappedGenerics = 0;
  for (const g of corpus.generics) {
    // GenericEntry: { n, c, ind, ci, pl, who, neml, ddi }
    if (g && g.who) whoEmlGenerics += 1;
    if (g && g.neml) bdNemlGenerics += 1;
    if (g && Array.isArray(g.ddi) && g.ddi.length > 0) ddiMappedGenerics += 1;
  }

  cachedFormularySummary = {
    available: true,
    totalBrands: corpus.brands.length,
    totalGenerics: corpus.generics.length,
    totalManufacturers: corpus.mfrs.length,
    totalClasses: corpus.classes.length,
    totalDosageForms: corpus.forms.length,
    whoEmlGenerics,
    bdNemlGenerics,
    ddiMappedGenerics,
    pricedBrands,
    topManufacturers: [...mfrCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({
        name,
        count,
        sharePct: Number(((count / Math.max(1, corpus.brands.length)) * 100).toFixed(1)),
      })),
    topForms: [...formCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    priceTiers: tiers.map(({ range, count }) => ({
      range,
      count,
      pct: Number(((count / Math.max(1, pricedBrands)) * 100).toFixed(1)),
    })),
  };

  return cachedFormularySummary;
}

function searchFormularyCorpus({ query = '', manufacturer = '', emlOnly = false, limit = 30 }) {
  const corpus = loadFormularyCorpus();
  if (!corpus) {
    return { items: [], cheapestAlternatives: [], totalMatches: 0 };
  }
  const q = String(query || '')
    .trim()
    .replace(
      /^(?:tab|tablet|cap|capsule|syp|syrup|inj|injection|susp|suspension|drop|drops|cream|oint|gel|inh)\.?\s+/i,
      '',
    )
    .toLowerCase();
  const mfrFilter = String(manufacturer || '')
    .trim()
    .toLowerCase();
  const cap = Math.min(80, Math.max(5, Number(limit) || 30));

  const matchedGenericIndices = new Set();
  for (let gi = 0; gi < corpus.generics.length; gi++) {
    const g = corpus.generics[gi] || {};
    const gName = String(g.n || '').toLowerCase();
    const isEssential = Boolean(g.who || g.neml);
    if (emlOnly && !isEssential) continue;
    if (!q || gName.includes(q)) {
      matchedGenericIndices.add(gi);
    }
  }

  const results = [];
  for (let bi = 0; bi < corpus.brands.length; bi++) {
    const b = corpus.brands[bi];
    const brandName = String(b[0] || '');
    const gi = b[1];
    const g = corpus.generics[gi] || {};
    const genericName = String(g.n || 'Unknown');
    const isEssential = Boolean(g.who || g.neml);
    if (emlOnly && !isEssential) continue;

    const mfrName = String(corpus.mfrs[b[4]] || 'Unknown');
    if (mfrFilter && !mfrName.toLowerCase().includes(mfrFilter)) continue;

    const brandLower = brandName.toLowerCase();
    const strength = String(b[3] || '');
    const isMatch =
      !q ||
      brandLower.includes(q) ||
      `${brandLower} ${strength.toLowerCase()}`.includes(q) ||
      matchedGenericIndices.has(gi);

    if (!isMatch) continue;

    let rank = 50;
    if (q) {
      if (brandLower === q) rank = 1;
      else if (brandLower.startsWith(q)) rank = 2;
      else if (genericName.toLowerCase() === q) rank = 3;
      else if (genericName.toLowerCase().startsWith(q)) rank = 4;
      else if (brandLower.includes(q)) rank = 5;
      else rank = 6;
    }

    results.push({
      brand: brandName,
      strength,
      dosageForm: String(corpus.forms[b[2]] || ''),
      generic: genericName,
      therapeuticClass: String(corpus.classes[g.c] || ''),
      manufacturer: mfrName,
      unitPriceBdt: b[5] != null ? Number(b[5]) : null,
      stripPriceBdt: b[6] != null ? Number(b[6]) : null,
      whoEml: Boolean(g.who),
      bdNeml: Boolean(g.neml),
      pregnancyCategory: g.pl || null,
      indication: g.ind || null,
      doseSummary: g.ci || null,
      rank,
    });
  }

  results.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const pa = a.unitPriceBdt ?? Number.POSITIVE_INFINITY;
    const pb = b.unitPriceBdt ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  const topItems = results.slice(0, cap).map(({ rank: _r, ...rest }) => rest);

  // Also compute cheapest alternatives for the primary matched generic
  let cheapestAlternatives = [];
  if (topItems.length > 0) {
    const primaryGeneric = topItems[0].generic;
    cheapestAlternatives = results
      .filter(
        (item) =>
          item.generic === primaryGeneric && item.unitPriceBdt != null && item.unitPriceBdt > 0,
      )
      .sort((a, b) => (a.unitPriceBdt || 0) - (b.unitPriceBdt || 0))
      .slice(0, 8)
      .map(({ rank: _r, ...rest }) => rest);
  }

  return {
    totalMatches: results.length,
    items: topItems,
    cheapestAlternatives,
  };
}

/**
 * Keyword screen behind the admin console's triage panel.
 *
 * It is a keyword matcher, and this is the one place where that is stated
 * plainly rather than implied. Two rules follow from it:
 *
 * 1. A message it does not recognise is `unknown`, not `routine`. A default of
 *    `routine` is a clearance the matcher has not earned — the same false
 *    clearance that the medical package's triage tool refuses to give, and the
 *    reason that tool reports `unknown` when no classifier is available. An
 *    operator reading "routine" concludes somebody checked; an operator reading
 *    "unknown" concludes nobody did.
 * 2. Every row carries `basis`, so a severity can never be mistaken for a
 *    clinical assessment. `keyword-match` means a regex matched; `none` means
 *    the matcher found nothing and the row was not assessed at all.
 *
 * This is a triage *queue for humans*, not a triage decision — see F-23 in
 * `docs/REPOSITORY_DEEP_AUDIT.md`.
 */
/** Ordered worst-last, so a matched rule can only ever raise a severity. */
const SEVERITY_RANK = { unknown: 0, routine: 1, moderate: 2, high: 3, emergency: 4 };

function raiseSeverity(current, next) {
  return (SEVERITY_RANK[next] ?? 0) > (SEVERITY_RANK[current] ?? 0) ? next : current;
}

function classifyClinicalMessageRisk(text = '') {
  const s = String(text || '').toLowerCase();
  const flags = [];
  let severity = 'unknown';
  let specialty = 'General & Internal Medicine';

  if (/suicide|self[- ]?harm|kill myself|end my life|আত্মহত্যা|বাঁচতে চাই না|নিজেকে শেষ/.test(s)) {
    flags.push('Self-Harm / Crisis Protocol (999 + Kaan Pete Roi)');
    severity = 'emergency';
    specialty = 'Psychiatry & Crisis Triage';
  }
  if (
    /chest pain|crushing|radiating to left arm|stemi|heart attack|বুকে ব্যথা|বুকে চাপ|শ্বাসকষ্ট/.test(
      s,
    )
  ) {
    flags.push('Acute Coronary / Cardiopulmonary Red-Flag');
    severity = 'emergency';
    specialty = 'Cardiology & Emergency Triage';
  }
  if (/stroke|slurred speech|facial droop|weakness on one side|প্যারালাইসিস|মুখ বেঁকে/.test(s)) {
    flags.push('Acute Stroke FAST Red-Flag');
    severity = 'emergency';
    specialty = 'Neurology & Acute Stroke';
  }
  if (/dengue|platelet|hematocrit|ডেঙ্গু|প্লাটিলেট/.test(s)) {
    flags.push('Dengue Hemorrhagic & NSAID Contraindication Guard');
    severity = raiseSeverity(severity, 'high');
    specialty = 'Tropical Medicine & Dengue';
  }
  if (/cyp2c19|hla-b|clopidogrel|carbamazepine|pharmacogenom|warfarin/.test(s)) {
    flags.push('CPIC Pharmacogenomics / High-Alert DDI Check');
    severity = raiseSeverity(severity, 'moderate');
    if (specialty === 'General & Internal Medicine') specialty = 'Clinical Pharmacology & PGx';
  }
  if (/egfr|creatinine|ckd|dialysis|কিডনি/.test(s)) {
    flags.push('Renal eGFR / CrCl Drug Dosing Guard');
    severity = raiseSeverity(severity, 'moderate');
    if (specialty === 'General & Internal Medicine') specialty = 'Nephrology & Metabolic';
  }
  if (/pregnant|pregnancy|breastfeed|lactation|গর্ভবতী|স্তন্যদান|শিশু|baby|child/.test(s)) {
    flags.push('Maternal-Fetal / LactMed / Pediatric Weight Guard');
    severity = raiseSeverity(severity, 'moderate');
    if (specialty === 'General & Internal Medicine') specialty = 'Maternal & Pediatric Safety';
  }
  if (/rash|itching|eczema|psoriasis|dandruff|চুলকানি|খুশকি|চর্ম/.test(s)) {
    if (specialty === 'General & Internal Medicine') specialty = 'Dermatology & Cutaneous';
  }
  if (/eye|vision|blurry|চোখ|ঝাপসা/.test(s)) {
    if (specialty === 'General & Internal Medicine') specialty = 'Ophthalmology';
  }
  if (/insomnia|sleep|anxiety|ঘুম|দুশ্চিন্তা/.test(s)) {
    if (specialty === 'General & Internal Medicine') specialty = 'Psychiatry & Sleep';
  }
  if (/bizoran|sergel|napa|maxpro|seclo|monas|দাম|বিকল্প|brand|medicine/.test(s)) {
    flags.push('Bangladesh Formulary Price & Generic Verification');
    if (specialty === 'General & Internal Medicine') specialty = 'Bangladesh Formulary';
  }

  return { severity, specialty, flags, basis: flags.length > 0 ? 'keyword-match' : 'none' };
}

function probeLocalHttp(host, port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host, port, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({
        online: res.statusCode >= 200 && res.statusCode < 500,
        statusCode: res.statusCode,
        latencyMs: Date.now() - started,
      });
    });
    req.on('error', () =>
      resolve({ online: false, statusCode: 0, latencyMs: Date.now() - started }),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ online: false, statusCode: 0, latencyMs: timeoutMs });
    });
  });
}

let cachedMedicalServerInstance = null;

async function executeMedicalMcpTool(toolName, args = {}) {
  const distDirCandidates = [
    path.resolve(__dirname, '../../../../packages/mcp-medical/dist'),
    path.resolve(process.cwd(), 'packages/mcp-medical/dist'),
    '/home/user/medical-agent/packages/mcp-medical/dist',
  ];
  const distDir = distDirCandidates.find((p) => fs.existsSync(path.join(p, 'server.js')));
  if (!distDir) {
    if (toolName === 'bd_medicine_lookup') {
      return searchFormularyCorpus({
        query: args.query || '',
        manufacturer: args.manufacturer || '',
        limit: args.max_alternatives || 10,
      });
    }
    throw new Error('MCP medical bundle is not built yet; run npm run build:mcp-medical');
  }
  if (!cachedMedicalServerInstance) {
    const [{ createMedicalServer }, { HttpClient }] = await Promise.all([
      importDynamicEsm(pathToFileURL(path.join(distDir, 'server.js')).href),
      importDynamicEsm(pathToFileURL(path.join(distDir, 'http.js')).href),
    ]);
    const created = createMedicalServer();
    cachedMedicalServerInstance = {
      tools: created.tools,
      ctx: { env: created.env, http: new HttpClient({ env: created.env }) },
    };
  }
  const found = cachedMedicalServerInstance.tools.find((t) => t.name === toolName);
  if (!found) {
    throw new Error(`Unknown medical MCP tool: ${toolName}`);
  }
  const output = await found.handler(args || {}, cachedMedicalServerInstance.ctx);
  return output;
}

async function writeAuditEntry(dbConn, req, eventType, details = {}) {
  try {
    await dbConn.collection('auditlogs').insertOne({
      eventId: crypto.randomUUID(),
      timestamp: new Date(),
      actorId: String(req.user?._id || req.user?.id || 'system'),
      actorEmail: req.user?.email || 'admin@medical.ai',
      actorRole: req.user?.role || 'ADMIN',
      action: eventType,
      outcome: 'success',
      ip: req.ip || '127.0.0.1',
      details,
    });
  } catch {
    // Non-blocking audit persistence
  }
}

function createMedicalCommandRouter(options = {}) {
  const router = express.Router();
  const getDb = options.getDb || (() => mongoose.connection.db);
  const authMiddleware = options.authMiddleware || requireJwtAuth;
  const adminAccessMiddleware = options.adminAccessMiddleware || requireMedicalAdminAccess;
  const runTool = options.executeTool || executeMedicalMcpTool;

  router.use(authMiddleware, adminAccessMiddleware);

  /**
   * 1. EXECUTIVE OVERVIEW & HOSPITAL AI TELEMETRY
   */
  router.get('/overview', async (req, res) => {
    try {
      const db = getDb();
      const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
      const since = new Date(Date.now() - days * 86_400_000);

      const [
        users,
        agents,
        conversationsCount,
        messages,
        transactions,
        memoriesCount,
        bannersCount,
        auditCount,
        recentConvos,
        engineProbe,
        apiProbe,
      ] = await Promise.all([
        db
          .collection('users')
          .find({}, { projection: { password: 0, totpSecret: 0 } })
          .toArray(),
        db.collection('agents').find({}).toArray(),
        db.collection('conversations').countDocuments(),
        db
          .collection('messages')
          .find(
            { createdAt: { $gte: since } },
            {
              projection: {
                conversationId: 1,
                isCreatedByUser: 1,
                sender: 1,
                text: 1,
                content: 1,
                tokenCount: 1,
                createdAt: 1,
                model: 1,
              },
            },
          )
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray(),
        db
          .collection('transactions')
          .find({ createdAt: { $gte: since } })
          .sort({ createdAt: -1 })
          .limit(1000)
          .toArray(),
        db.collection('memoryentries').countDocuments(),
        db.collection('banners').countDocuments(),
        db.collection('auditlogs').countDocuments(),
        db.collection('conversations').find({}).sort({ updatedAt: -1 }).limit(12).toArray(),
        probeLocalHttp('127.0.0.1', Number(process.env.DOCTOR_ENGINE_PORT || 4120), '/health', 800),
        probeLocalHttp('127.0.0.1', Number(process.env.PORT || 3080), '/health', 800),
      ]);

      const formulary = getFormularyAnalytics();
      const userMap = new Map(users.map((u) => [String(u._id), u]));
      const agentMap = new Map(agents.map((a) => [a.id, a]));

      let promptTokens = 0;
      let completionTokens = 0;
      for (const tx of transactions) {
        const raw = Math.abs(Number(tx.rawAmount || 0));
        if (tx.tokenType === 'prompt') promptTokens += raw;
        else completionTokens += raw;
      }

      // Build day-by-day series for charts
      const dayBuckets = new Map();
      for (let i = days - 1; i >= 0; i--) {
        const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        dayBuckets.set(key, {
          date: key,
          messages: 0,
          userQueries: 0,
          toolInvocations: 0,
          tokens: 0,
          safetyAlerts: 0,
        });
      }

      const specialtyCounts = new Map();
      let emergencyAlerts = 0;
      let dengueAlerts = 0;
      let pgxAlerts = 0;
      let totalToolCalls = 0;
      let subagentDelegations = 0;
      const convoMessageStats = new Map();

      for (const msg of messages) {
        const dateKey = msg.createdAt ? new Date(msg.createdAt).toISOString().slice(0, 10) : null;
        const bucket = dateKey ? dayBuckets.get(dateKey) : null;
        const cStat = convoMessageStats.get(msg.conversationId) || {
          count: 0,
          tokens: 0,
          firstUserText: '',
          toolCalls: 0,
          subagents: 0,
        };
        cStat.count += 1;
        cStat.tokens += Number(msg.tokenCount || 0);

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === 'tool_call') {
              totalToolCalls += 1;
              cStat.toolCalls += 1;
              if (bucket) bucket.toolInvocations += 1;
              const tName = String(part.tool_call?.name || '');
              if (tName === 'subagent' || tName.startsWith('subagent')) {
                subagentDelegations += 1;
                cStat.subagents += 1;
              }
            }
          }
        }

        if (msg.isCreatedByUser && msg.text) {
          cStat.firstUserText = msg.text;
          const risk = classifyClinicalMessageRisk(msg.text);
          specialtyCounts.set(risk.specialty, (specialtyCounts.get(risk.specialty) || 0) + 1);
          if (risk.severity === 'emergency') emergencyAlerts += 1;
          if (/dengue|ডেঙ্গু/i.test(msg.text)) dengueAlerts += 1;
          if (/cyp2c19|hla-b|clopidogrel|carbamazepine|warfarin/i.test(msg.text)) pgxAlerts += 1;
          if (bucket) {
            bucket.userQueries += 1;
            /** Only substantiated severities are alerts; an unassessed message
             *  is not evidence of safety, but it is also not an alert. */
            if (
              risk.severity === 'emergency' ||
              risk.severity === 'high' ||
              risk.severity === 'moderate'
            ) {
              bucket.safetyAlerts += 1;
            }
          }
        }
        if (bucket) {
          bucket.messages += 1;
        }
        convoMessageStats.set(msg.conversationId, cStat);
      }

      for (const tx of transactions) {
        const dateKey = tx.createdAt ? new Date(tx.createdAt).toISOString().slice(0, 10) : null;
        const bucket = dateKey ? dayBuckets.get(dateKey) : null;
        if (bucket) {
          bucket.tokens += Math.abs(Number(tx.rawAmount || 0));
        }
      }

      const coreSubagents = agents.filter((a) => String(a.id || '').startsWith('agent_sub_'));
      const dynamicSubagents = agents.filter((a) => String(a.id || '').startsWith('agent_dyn_'));

      res.json({
        generatedAt: new Date().toISOString(),
        kpis: {
          totalUsers: users.length,
          adminUsers: users.filter((u) => String(u.role).toUpperCase() === 'ADMIN').length,
          patientUsers: users.filter((u) => String(u.role).toUpperCase() !== 'ADMIN').length,
          totalAgents: agents.length,
          coreSubagents: coreSubagents.length,
          dynamicSubagents: dynamicSubagents.length,
          totalConversations: conversationsCount,
          sampledMessages: messages.length,
          totalToolCalls,
          subagentDelegations,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          patientMemories: memoriesCount,
          activeBanners: bannersCount,
          auditEntries: auditCount,
          emergencyAlerts,
          dengueAlerts,
          pgxAlerts,
          mcpToolsTotal: 32,
          mcpToolGroups: TOOL_GROUPS.length,
          bdBrandsTotal: formulary.totalBrands,
          bdGenericsTotal: formulary.totalGenerics,
        },
        dailySeries: [...dayBuckets.values()],
        specialtyBreakdown: [...specialtyCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([specialty, count]) => ({ specialty, count })),
        recentConsultations: recentConvos.map((c) => {
          const u = userMap.get(String(c.user)) || {};
          const a = agentMap.get(c.agent_id) || {};
          const st = convoMessageStats.get(c.conversationId) || {
            count: 0,
            tokens: 0,
            firstUserText: c.title || '',
            toolCalls: 0,
            subagents: 0,
          };
          const risk = classifyClinicalMessageRisk(`${c.title || ''} ${st.firstUserText || ''}`);
          return {
            conversationId: c.conversationId,
            title: c.title || 'Clinical Consultation',
            firstMessage: st.firstUserText || c.title || '',
            userName: u.name || u.username || 'Patient',
            userEmail: u.email || '',
            agentId: c.agent_id || PARENT_AGENT_ID,
            agentName: a.name || 'Super-Power Doctor AI',
            messages: st.count,
            toolCalls: st.toolCalls,
            subagentHandoffs: st.subagents,
            severity: risk.severity,
            specialty: risk.specialty,
            flags: risk.flags,
            updatedAt: c.updatedAt || c.createdAt,
          };
        }),
        services: [
          {
            name: 'MongoDB Clinical Store (:27017)',
            status: mongoose.connection.readyState === 1 ? 'healthy' : 'offline',
            latencyMs: 1,
            detail: `${agents.length} agents · ${conversationsCount} consultations · ${memoriesCount} patient memories`,
          },
          {
            name: 'LibreChat Core API & SSE Engine (:3080)',
            status: apiProbe.online ? 'healthy' : 'degraded',
            latencyMs: apiProbe.latencyMs || 2,
            detail: `Node ${process.version} · RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
          },
          {
            name: 'Super-Power Doctor Multi-Turn Engine (:4120)',
            status: engineProbe.online ? 'healthy' : 'degraded',
            latencyMs: engineProbe.latencyMs,
            detail: `${formulary.totalBrands.toLocaleString()} BD brands · Auto Sub-Agent Spawner active`,
          },
          {
            name: 'Medical MCP Stdio Suite (@librechat/mcp-medical)',
            status: formulary.available ? 'healthy' : 'degraded',
            latencyMs: 3,
            detail: `32 tools across ${TOOL_GROUPS.length} clinical groups · Zero API keys required`,
          },
        ],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 2. MULTI-AGENT TOPOLOGY & DYNAMIC SUB-AGENT STUDIO
   */
  router.get('/agents', async (_req, res) => {
    try {
      const db = getDb();
      const [agents, convos, acls] = await Promise.all([
        db.collection('agents').find({}).sort({ createdAt: 1 }).toArray(),
        db
          .collection('conversations')
          .aggregate([{ $group: { _id: '$agent_id', count: { $sum: 1 } } }])
          .toArray(),
        db.collection('aclentries').find({ resourceType: 'agent' }).toArray(),
      ]);

      const convoMap = new Map(convos.map((c) => [c._id, c.count]));
      const publicSet = new Set(
        acls.filter((x) => x.principalType === 'public').map((x) => String(x.resourceId)),
      );
      const existingIds = new Set(agents.map((a) => a.id));

      const formatted = agents.map((a) => {
        const id = String(a.id || '');
        let tier = 'custom_agent';
        if (id === PARENT_AGENT_ID) {
          tier = 'orchestrator';
        } else if (id.startsWith('agent_sub_')) {
          tier = 'core_subagent';
        } else if (id.startsWith('agent_dyn_')) {
          tier = 'dynamic_subagent';
        }
        return {
          _id: String(a._id),
          id,
          name: a.name || id,
          description: a.description || '',
          instructions: a.instructions || '',
          provider: a.provider || 'DoctorEngine',
          model: a.model || DEFAULT_MODEL,
          tier,
          tools: Array.isArray(a.tools) ? a.tools : [],
          edges: Array.isArray(a.edges) ? a.edges : [],
          publicAccess: publicSet.has(String(a._id)),
          conversationsCount: convoMap.get(id) || 0,
          createdAt: a.createdAt || null,
          updatedAt: a.updatedAt || null,
        };
      });

      res.json({
        parentAgentId: PARENT_AGENT_ID,
        agents: formatted,
        presetBlueprints: PRESET_SPECIALTY_BLUEPRINTS.map((bp) => ({
          ...bp,
          spawned: existingIds.has(bp.id),
        })),
        mcpToolCatalog: TOOL_GROUPS.flatMap((g) =>
          g.tools.map((t) => ({
            toolId: `${t.name}_mcp_${MCP_SERVER_NAME}`,
            shortName: t.name,
            group: g.label,
            summary: t.summary,
          })),
        ),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/agents/spawn', async (req, res) => {
    try {
      const db = getDb();
      const { presetKey, name, specialty, description, instructions, tools, model } =
        req.body || {};

      let spec;
      if (presetKey) {
        const preset = PRESET_SPECIALTY_BLUEPRINTS.find((p) => p.key === presetKey);
        if (!preset) {
          return res.status(400).json({ error: `Unknown preset blueprint: ${presetKey}` });
        }
        spec = {
          id: preset.id,
          name: preset.name,
          description: preset.description,
          instructions: preset.instructions,
          tools: ['sys__server__sys', ...preset.tools.map((t) => `${t}_mcp_${MCP_SERVER_NAME}`)],
          model: model || DEFAULT_MODEL,
        };
      } else {
        const cleanName = String(name || '').trim();
        if (!cleanName) {
          return res.status(400).json({ error: 'Agent name is required.' });
        }
        const slug = String(specialty || cleanName)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 32);
        const normalizedTools = Array.isArray(tools) && tools.length > 0 ? tools : [];
        const fullTools = [
          'sys__server__sys',
          ...normalizedTools.map((t) =>
            String(t).includes('_mcp_') ? String(t) : `${t}_mcp_${MCP_SERVER_NAME}`,
          ),
        ];
        spec = {
          id: `agent_dyn_${slug || crypto.randomBytes(3).toString('hex')}`,
          name: cleanName,
          description:
            String(description || '').trim() ||
            `Specialist dynamic sub-agent for ${specialty || cleanName}`,
          instructions:
            String(instructions || '').trim() ||
            `You are the ${cleanName}. Provide rigorous evidence-graded specialist assessment, screen urgent red flags first, check Bangladesh formulary availability, and return a concise structured report to the Chief Orchestrator.`,
          tools: [...new Set(fullTools)],
          model: String(model || DEFAULT_MODEL),
        };
      }

      const now = new Date();
      const authorId = new mongoose.Types.ObjectId(String(req.user._id || req.user.id));

      await db.collection('agents').updateOne(
        { id: spec.id },
        {
          $set: {
            name: spec.name,
            description: spec.description,
            instructions: spec.instructions,
            provider: 'DoctorEngine',
            model: spec.model,
            model_parameters: { temperature: 0.2 },
            tools: spec.tools,
            category: 'general',
            updatedAt: now,
          },
          $setOnInsert: {
            id: spec.id,
            author: authorId,
            edges: [],
            versions: [
              {
                name: spec.name,
                description: spec.description,
                instructions: spec.instructions,
                provider: 'DoctorEngine',
                model: spec.model,
                tools: spec.tools,
                createdAt: now,
                updatedAt: now,
              },
            ],
            createdAt: now,
          },
        },
        { upsert: true },
      );

      const savedAgent = await db.collection('agents').findOne({ id: spec.id });
      const viewerRole = await db
        .collection('accessroles')
        .findOne({ accessRoleId: 'agent_viewer' });
      const ownerRole = await db.collection('accessroles').findOne({ accessRoleId: 'agent_owner' });

      if (savedAgent) {
        await db.collection('aclentries').updateOne(
          { principalType: 'public', resourceType: 'agent', resourceId: savedAgent._id },
          {
            $set: {
              permBits: viewerRole?.permBits ?? 1,
              roleId: viewerRole?._id,
              updatedAt: now,
            },
            $setOnInsert: {
              principalType: 'public',
              resourceType: 'agent',
              resourceId: savedAgent._id,
              grantedBy: authorId,
              grantedAt: now,
              createdAt: now,
            },
          },
          { upsert: true },
        );

        await db.collection('aclentries').updateOne(
          {
            principalType: 'user',
            principalId: authorId,
            resourceType: 'agent',
            resourceId: savedAgent._id,
          },
          {
            $set: {
              permBits: ownerRole?.permBits ?? 15,
              roleId: ownerRole?._id,
              updatedAt: now,
            },
            $setOnInsert: {
              principalType: 'user',
              principalId: authorId,
              principalModel: 'User',
              resourceType: 'agent',
              resourceId: savedAgent._id,
              grantedBy: authorId,
              grantedAt: now,
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }

      // Connect handoff edge on parent orchestrator
      const parentDoc = await db.collection('agents').findOne({ id: PARENT_AGENT_ID });
      if (parentDoc) {
        const edges = Array.isArray(parentDoc.edges) ? [...parentDoc.edges] : [];
        const hasEdge = edges.some((e) => {
          const targets = Array.isArray(e.to) ? e.to : [e.to];
          return targets.includes(spec.id);
        });
        if (!hasEdge) {
          edges.push({
            from: PARENT_AGENT_ID,
            to: [spec.id],
            edgeType: 'handoff',
            prompt: `Delegate ${spec.name} clinical assessment when relevant.`,
          });
          await db
            .collection('agents')
            .updateOne({ id: PARENT_AGENT_ID }, { $set: { edges, updatedAt: now } });
        }
      }

      await writeAuditEntry(db, req, 'agent.subagent.spawned', {
        agentId: spec.id,
        name: spec.name,
        toolsCount: spec.tools.length,
      });

      return res.status(201).json({ agent: savedAgent, attachedTo: PARENT_AGENT_ID });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.patch('/agents/:agentId', async (req, res) => {
    try {
      const db = getDb();
      const { agentId } = req.params;
      const { name, description, instructions, model, tools } = req.body || {};
      const update = { updatedAt: new Date() };
      if (typeof name === 'string' && name.trim()) update.name = name.trim();
      if (typeof description === 'string') update.description = description.trim();
      if (typeof instructions === 'string') update.instructions = instructions;
      if (typeof model === 'string' && model.trim()) update.model = model.trim();
      if (Array.isArray(tools)) {
        update.tools = [
          'sys__server__sys',
          ...tools
            .filter((t) => t !== 'sys__server__sys')
            .map((t) => (String(t).includes('_mcp_') ? String(t) : `${t}_mcp_${MCP_SERVER_NAME}`)),
        ];
      }

      const result = await db
        .collection('agents')
        .findOneAndUpdate({ id: agentId }, { $set: update }, { returnDocument: 'after' });
      const doc = result?.value !== undefined ? result.value : result;
      if (!doc) {
        return res.status(404).json({ error: `Agent ${agentId} not found.` });
      }
      await writeAuditEntry(db, req, 'agent.updated', {
        agentId,
        updatedFields: Object.keys(update),
      });
      return res.json({ agent: doc });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/agents/:agentId', async (req, res) => {
    try {
      const db = getDb();
      const { agentId } = req.params;
      if (agentId === PARENT_AGENT_ID || agentId.startsWith('agent_sub_')) {
        return res.status(400).json({
          error: 'Core orchestrator and protected 7 core sub-agents cannot be deleted.',
        });
      }
      const existing = await db.collection('agents').findOne({ id: agentId });
      if (!existing) {
        return res.status(404).json({ error: 'Dynamic sub-agent not found.' });
      }
      await db.collection('agents').deleteOne({ id: agentId });
      await db.collection('aclentries').deleteMany({ resourceId: existing._id });
      const parentDoc = await db.collection('agents').findOne({ id: PARENT_AGENT_ID });
      if (parentDoc && Array.isArray(parentDoc.edges)) {
        const cleaned = parentDoc.edges.filter((e) => {
          const targets = Array.isArray(e.to) ? e.to : [e.to];
          return !targets.includes(agentId);
        });
        await db
          .collection('agents')
          .updateOne({ id: PARENT_AGENT_ID }, { $set: { edges: cleaned, updatedAt: new Date() } });
      }
      await writeAuditEntry(db, req, 'agent.deleted', { agentId, name: existing.name });
      return res.json({ deleted: true, agentId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * 3. 32-TOOL MCP MEDICAL LAB & UPSTREAM HEALTH PROBE
   */
  router.get('/mcp-tools', (_req, res) => {
    res.json({
      serverName: MCP_SERVER_NAME,
      totalGroups: TOOL_GROUPS.length,
      totalTools: TOOL_GROUPS.reduce((sum, g) => sum + g.tools.length, 0),
      groups: TOOL_GROUPS,
    });
  });

  router.post('/mcp-tools/execute', async (req, res) => {
    const started = Date.now();
    try {
      const db = getDb();
      const { toolName, args } = req.body || {};
      if (!toolName || typeof toolName !== 'string') {
        return res.status(400).json({ error: 'toolName is required.' });
      }
      const output = await runTool(toolName, args || {});
      const latencyMs = Date.now() - started;
      await writeAuditEntry(db, req, 'mcp.tool.executed', { toolName, latencyMs });
      return res.json({
        ok: true,
        toolName,
        latencyMs,
        executedAt: new Date().toISOString(),
        result: output,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        latencyMs: Date.now() - started,
        error: err.message,
      });
    }
  });

  router.post('/mcp-tools/health-check', async (req, res) => {
    const checks = [
      {
        name: 'BDDrugBank Local Gzip Corpus (24,725 Brands)',
        tool: 'bd_medicine_lookup',
        args: { query: 'Napa Extend', max_alternatives: 3 },
      },
      {
        name: 'MedCalc Deterministic Engine (2021 CKD-EPI eGFR)',
        tool: 'clinical_calculator',
        args: {
          calculator: 'ckd_epi_2021',
          inputs: { creatinine_mg_dl: 1.4, age: 58, sex: 'female' },
        },
      },
      {
        name: 'Critical Lab & Dengue Leakage Analyzer',
        tool: 'lab_result_interpreter',
        args: { values: { platelets: 42, hematocrit: 48 } },
      },
      {
        name: 'CPIC Pharmacogenomics Live API (v1.55)',
        tool: 'pharmacogenomics_guideline',
        args: { drug: 'clopidogrel', gene: 'CYP2C19' },
      },
      {
        name: 'NIH NCBI PubMed Live E-Utilities',
        tool: 'pubmed_search',
        args: { query: 'empagliflozin heart failure', max_results: 2 },
      },
      {
        name: 'Disease Nosology HA (Monarch -> EBI OLS4 MONDO)',
        tool: 'condition_lookup',
        args: { condition: 'dengue fever', max_results: 2 },
      },
    ];

    const results = await Promise.all(
      checks.map(async (item) => {
        const started = Date.now();
        try {
          const output = await runTool(item.tool, item.args);
          const isError = Boolean(output && typeof output === 'object' && output.isError === true);
          return {
            name: item.name,
            tool: item.tool,
            status: isError ? 'error' : 'healthy',
            latencyMs: Date.now() - started,
            ...(isError ? { error: output.text || 'MCP tool returned an error.' } : {}),
          };
        } catch (err) {
          return {
            name: item.name,
            tool: item.tool,
            status: 'error',
            latencyMs: Date.now() - started,
            error: err.message,
          };
        }
      }),
    );

    await writeAuditEntry(getDb(), req, 'mcp.health_check.ran', {
      healthyCount: results.filter((r) => r.status === 'healthy').length,
      totalChecks: results.length,
    });

    res.json({ checkedAt: new Date().toISOString(), results });
  });

  /**
   * 4. BANGLADESH FORMULARY ANALYTICS & SEARCH (24,725 BRANDS)
   */
  router.get('/formulary', (_req, res) => {
    res.json(getFormularyAnalytics());
  });

  router.get('/formulary/search', (req, res) => {
    const data = searchFormularyCorpus({
      query: req.query.q || '',
      manufacturer: req.query.manufacturer || '',
      emlOnly: req.query.emlOnly === 'true',
      limit: Number(req.query.limit || 30),
    });
    res.json(data);
  });

  /**
   * 5. CLINICAL TRIAGE, RED-FLAG & SAFETY SURVEILLANCE LEDGER
   */
  router.get('/triage-safety', async (_req, res) => {
    try {
      const db = getDb();
      /** The 200 messages come first so the user lookup can be narrowed to the
       *  people those messages mention. Reading the whole `users` collection to
       *  decorate 200 rows put every account the deployment has into memory on
       *  each request, which is an out-of-memory waiting to happen at scale. */
      const userMessages = await db
        .collection('messages')
        .find({ isCreatedByUser: true })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      const authorIds = [
        ...new Set(userMessages.map((msg) => msg.user).filter((id) => id != null)),
      ];
      const users =
        authorIds.length > 0
          ? await db
              .collection('users')
              .find({ _id: { $in: authorIds } }, { projection: { name: 1, email: 1 } })
              .toArray()
          : [];
      const userMap = new Map(users.map((u) => [String(u.user || u._id), u]));

      const events = userMessages.map((msg) => {
        const risk = classifyClinicalMessageRisk(msg.text || '');
        const u = userMap.get(String(msg.user)) || {};
        return {
          messageId: msg.messageId || String(msg._id),
          conversationId: msg.conversationId,
          userName: u.name || 'Patient',
          userEmail: u.email || '',
          text: msg.text || '',
          severity: risk.severity,
          severityBasis: risk.basis,
          specialty: risk.specialty,
          flags: risk.flags,
          createdAt: msg.createdAt,
        };
      });

      res.json({
        basis: 'keyword-match',
        notice:
          'Severities here come from a keyword matcher, not from the deterministic triage screen and not from a clinician. "unknown" means the message matched no rule and was not assessed — it is not a clearance.',
        counts: {
          totalScanned: events.length,
          emergency: events.filter((e) => e.severity === 'emergency').length,
          high: events.filter((e) => e.severity === 'high').length,
          moderate: events.filter((e) => e.severity === 'moderate').length,
          /** Retained at 0 for wire compatibility with existing clients. */
          routine: events.filter((e) => e.severity === 'routine').length,
          unknown: events.filter((e) => e.severity === 'unknown').length,
        },
        events,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 6. CONSULTATIONS & FULL STEP-BY-STEP TRACE INSPECTOR
   */
  router.get('/consultations', async (req, res) => {
    try {
      const db = getDb();
      const q = String(req.query.q || '')
        .trim()
        .toLowerCase();
      const severityFilter = String(req.query.severity || 'all');

      const [convos, users, agents, messages] = await Promise.all([
        db.collection('conversations').find({}).sort({ updatedAt: -1 }).limit(120).toArray(),
        db
          .collection('users')
          .find({}, { projection: { name: 1, email: 1, role: 1 } })
          .toArray(),
        db
          .collection('agents')
          .find({}, { projection: { id: 1, name: 1 } })
          .toArray(),
        /** Scoped to the conversations actually being displayed. The previous
         *  filter was `{}`, so every message in the database was streamed into
         *  memory to describe 120 conversations. */
        db
          .collection('messages')
          .find(
            {
              conversationId: {
                $in: convos.map((conversation) => conversation.conversationId).filter(Boolean),
              },
            },
            {
              projection: {
                conversationId: 1,
                isCreatedByUser: 1,
                text: 1,
                content: 1,
                tokenCount: 1,
                createdAt: 1,
              },
            },
          )
          .toArray(),
      ]);

      const userMap = new Map(users.map((u) => [String(u._id), u]));
      const agentMap = new Map(agents.map((a) => [a.id, a.name]));
      const grouped = new Map();

      for (const m of messages) {
        const entry = grouped.get(m.conversationId) || {
          messagesCount: 0,
          toolCalls: 0,
          subagentCalls: 0,
          firstUserPrompt: '',
        };
        entry.messagesCount += 1;
        if (m.isCreatedByUser && m.text && !entry.firstUserPrompt) {
          entry.firstUserPrompt = m.text;
        }
        if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p?.type === 'tool_call') {
              entry.toolCalls += 1;
              if (String(p.tool_call?.name || '').startsWith('subagent')) {
                entry.subagentCalls += 1;
              }
            }
          }
        }
        grouped.set(m.conversationId, entry);
      }

      const items = convos
        .map((c) => {
          const u = userMap.get(String(c.user)) || {};
          const g = grouped.get(c.conversationId) || {
            messagesCount: 0,
            toolCalls: 0,
            subagentCalls: 0,
            firstUserPrompt: '',
          };
          const risk = classifyClinicalMessageRisk(`${c.title || ''} ${g.firstUserPrompt || ''}`);
          return {
            conversationId: c.conversationId,
            title: c.title || 'Untitled Consultation',
            firstUserPrompt: g.firstUserPrompt,
            userName: u.name || 'Patient',
            userEmail: u.email || '',
            agentId: c.agent_id || PARENT_AGENT_ID,
            agentName: agentMap.get(c.agent_id) || 'Super-Power Doctor AI',
            messagesCount: g.messagesCount,
            toolCalls: g.toolCalls,
            subagentCalls: g.subagentCalls,
            severity: risk.severity,
            specialty: risk.specialty,
            flags: risk.flags,
            updatedAt: c.updatedAt || c.createdAt,
          };
        })
        .filter((item) => {
          if (severityFilter !== 'all' && item.severity !== severityFilter) return false;
          if (!q) return true;
          return (
            item.title.toLowerCase().includes(q) ||
            item.firstUserPrompt.toLowerCase().includes(q) ||
            item.userEmail.toLowerCase().includes(q) ||
            item.userName.toLowerCase().includes(q) ||
            item.specialty.toLowerCase().includes(q)
          );
        });

      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/consultations/:conversationId', async (req, res) => {
    try {
      const db = getDb();
      const { conversationId } = req.params;
      const [convo, messages, txs] = await Promise.all([
        db.collection('conversations').findOne({ conversationId }),
        db.collection('messages').find({ conversationId }).sort({ createdAt: 1 }).toArray(),
        db.collection('transactions').find({ conversationId }).toArray(),
      ]);
      if (!convo) {
        return res.status(404).json({ error: 'Consultation not found.' });
      }
      const user = convo.user
        ? await db
            .collection('users')
            .findOne({ _id: convo.user }, { projection: { password: 0, totpSecret: 0 } })
        : null;
      return res.json({
        conversation: convo,
        patient: user,
        messages,
        transactions: txs,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/consultations/:conversationId', async (req, res) => {
    try {
      const db = getDb();
      const { conversationId } = req.params;
      await Promise.all([
        db.collection('conversations').deleteOne({ conversationId }),
        db.collection('messages').deleteMany({ conversationId }),
        db.collection('transactions').deleteMany({ conversationId }),
      ]);
      await writeAuditEntry(db, req, 'consultation.deleted', { conversationId });
      res.json({ deleted: true, conversationId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 7. USERS, DOCTORS, TOKEN CREDITS & LONGITUDINAL PATIENT MEMORIES
   */
  router.get('/users', async (_req, res) => {
    try {
      const db = getDb();
      const [users, balances, convos, memories] = await Promise.all([
        db
          .collection('users')
          .find({}, { projection: { password: 0, totpSecret: 0 } })
          .sort({ createdAt: -1 })
          .toArray(),
        db.collection('balances').find({}).toArray(),
        db
          .collection('conversations')
          .aggregate([{ $group: { _id: { $toString: '$user' }, count: { $sum: 1 } } }])
          .toArray(),
        db.collection('memoryentries').find({}).sort({ updated_at: -1 }).toArray(),
      ]);

      const balanceMap = new Map(
        balances.map((b) => [String(b.user), Number(b.tokenCredits || 0)]),
      );
      const convoMap = new Map(convos.map((c) => [String(c._id), c.count]));
      const memMap = new Map();
      for (const m of memories) {
        const uid = String(m.userId);
        const arr = memMap.get(uid) || [];
        arr.push({
          key: m.key,
          value: m.value,
          tokenCount: m.tokenCount || 0,
          updatedAt: m.updated_at || null,
        });
        memMap.set(uid, arr);
      }

      res.json({
        users: users.map((u) => {
          const id = String(u._id);
          return {
            id,
            name: u.name || u.username || 'User',
            username: u.username || '',
            email: u.email || '',
            role: u.role || 'USER',
            provider: u.provider || 'local',
            emailVerified: Boolean(u.emailVerified),
            tokenCredits: balanceMap.get(id) ?? 0,
            conversationsCount: convoMap.get(id) ?? 0,
            memories: memMap.get(id) || [],
            createdAt: u.createdAt || null,
          };
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/users', async (req, res) => {
    try {
      const db = getDb();
      const { name, email, password, role = 'USER', tokenCredits = 250000 } = req.body || {};
      const cleanEmail = String(email || '')
        .trim()
        .toLowerCase();
      const cleanPassword = String(password || '');
      if (!cleanEmail || !cleanEmail.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required.' });
      }
      if (cleanPassword.length < 12) {
        return res
          .status(400)
          .json({ error: 'Set a unique initial password of at least 12 characters.' });
      }
      const exists = await db.collection('users').findOne({ email: cleanEmail });
      if (exists) {
        return res.status(409).json({ error: 'A user with this email already exists.' });
      }
      const hashedPassword = await bcrypt.hash(cleanPassword, 12);
      const now = new Date();
      const cleanRole = String(role).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER';
      const ins = await db.collection('users').insertOne({
        name: String(name || cleanEmail.split('@')[0]).trim(),
        username: cleanEmail.split('@')[0],
        email: cleanEmail,
        password: hashedPassword,
        provider: 'local',
        role: cleanRole,
        emailVerified: true,
        termsAccepted: true,
        createdAt: now,
        updatedAt: now,
      });

      await db
        .collection('balances')
        .updateOne(
          { user: ins.insertedId },
          { $set: { tokenCredits: Number(tokenCredits) || 0, updatedAt: now } },
          { upsert: true },
        );

      await writeAuditEntry(db, req, 'user.created', {
        userId: String(ins.insertedId),
        email: cleanEmail,
        role: cleanRole,
      });

      return res.status(201).json({
        userId: String(ins.insertedId),
        email: cleanEmail,
        role: cleanRole,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.patch('/users/:userId', async (req, res) => {
    try {
      const db = getDb();
      const { userId } = req.params;
      const oid = new mongoose.Types.ObjectId(userId);
      const { role, name, tokenCredits } = req.body || {};
      const update = { updatedAt: new Date() };
      if (role && ['ADMIN', 'USER'].includes(String(role).toUpperCase())) {
        update.role = String(role).toUpperCase();
      }
      if (typeof name === 'string' && name.trim()) {
        update.name = name.trim();
      }
      const userUpdate = await db.collection('users').updateOne({ _id: oid }, { $set: update });
      if (userUpdate.matchedCount === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }

      if (tokenCredits !== undefined) {
        await db.collection('balances').updateOne(
          { user: oid },
          {
            $set: { tokenCredits: Math.max(0, Number(tokenCredits) || 0), updatedAt: new Date() },
          },
          { upsert: true },
        );
      }

      await writeAuditEntry(db, req, 'user.updated', { userId, role: update.role, tokenCredits });
      return res.json({ updated: true, userId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/users/:userId/memories', async (req, res) => {
    try {
      const db = getDb();
      const oid = new mongoose.Types.ObjectId(req.params.userId);
      const key = String(req.body?.key || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_');
      const value = String(req.body?.value || '').trim();
      if (!key || !value) {
        return res.status(400).json({ error: 'Both memory key and value are required.' });
      }
      await db.collection('memoryentries').updateOne(
        { userId: oid, key },
        {
          $set: {
            value,
            tokenCount: Math.ceil(value.length / 4),
            updated_at: new Date(),
          },
          $setOnInsert: { userId: oid, key },
        },
        { upsert: true },
      );
      await writeAuditEntry(db, req, 'patient.memory.upserted', {
        userId: req.params.userId,
        key,
      });
      return res.status(201).json({ ok: true, key, value });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/users/:userId/memories/:key', async (req, res) => {
    try {
      const db = getDb();
      const oid = new mongoose.Types.ObjectId(req.params.userId);
      await db.collection('memoryentries').deleteOne({ userId: oid, key: req.params.key });
      await writeAuditEntry(db, req, 'patient.memory.deleted', {
        userId: req.params.userId,
        key: req.params.key,
      });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * 8. RBAC ROLES, BROADCAST BANNERS & AUDIT LEDGER
   */
  router.get('/governance', async (_req, res) => {
    try {
      const db = getDb();
      const [roles, systemGrants, banners, auditLogs] = await Promise.all([
        db.collection('roles').find({}).toArray(),
        db.collection('systemgrants').find({}).toArray(),
        db.collection('banners').find({}).sort({ createdAt: -1 }).toArray(),
        db.collection('auditlogs').find({}).sort({ timestamp: -1 }).limit(100).toArray(),
      ]);
      res.json({ roles, systemGrants, banners, auditLogs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/governance/roles/:roleName', async (req, res) => {
    try {
      const db = getDb();
      const { roleName } = req.params;
      const { permissionType, key, value } = req.body || {};
      const permissionGroup = String(permissionType || '');
      const permissionKey = String(key || '');
      if (
        !['USER', 'ADMIN'].includes(String(roleName).toUpperCase()) ||
        !/^[A-Z][A-Z0-9_]*$/.test(permissionGroup) ||
        !/^[A-Z][A-Z0-9_]*$/.test(permissionKey)
      ) {
        return res.status(400).json({ error: 'A valid role and permission path are required.' });
      }
      const role = await db.collection('roles').findOne({ name: roleName });
      if (!role) {
        return res.status(404).json({ error: `Role ${roleName} not found.` });
      }
      if (
        !Object.prototype.hasOwnProperty.call(
          role.permissions?.[permissionGroup] || {},
          permissionKey,
        )
      ) {
        return res.status(404).json({ error: 'Permission path not found on this role.' });
      }
      const fieldPath = `permissions.${permissionGroup}.${permissionKey}`;
      await db
        .collection('roles')
        .updateOne({ name: roleName }, { $set: { [fieldPath]: Boolean(value) } });
      await writeAuditEntry(db, req, 'rbac.permission.toggled', {
        roleName,
        permissionType,
        key,
        value: Boolean(value),
      });
      return res.json({ updated: true, roleName, permissionType, key, value: Boolean(value) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/governance/banners', async (req, res) => {
    try {
      const db = getDb();
      const text = String(req.body?.message || '').trim();
      if (!text) {
        return res.status(400).json({ error: 'Banner message is required.' });
      }
      const now = new Date();
      const bannerDoc = {
        bannerId: crypto.randomUUID(),
        message: text,
        displayFrom: now,
        displayTo: new Date(Date.now() + 30 * 86_400_000),
        type: req.body?.type === 'public' ? 'public' : 'banner',
        isPublic: true,
        persistable: Boolean(req.body?.persistable ?? true),
        createdAt: now,
        updatedAt: now,
      };
      await db.collection('banners').insertOne(bannerDoc);
      await writeAuditEntry(db, req, 'banner.published', {
        bannerId: bannerDoc.bannerId,
        message: text,
      });
      return res.status(201).json({ banner: bannerDoc });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/governance/banners/:bannerId', async (req, res) => {
    try {
      const db = getDb();
      await db.collection('banners').deleteOne({ bannerId: req.params.bannerId });
      await writeAuditEntry(db, req, 'banner.deleted', { bannerId: req.params.bannerId });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * 9. SYSTEM INFRASTRUCTURE, MONGODB COLLECTION INSPECTOR & CLINICAL DEMO SEEDER
   */
  router.get('/system', async (_req, res) => {
    try {
      const db = getDb();
      const cols = await db.listCollections().toArray();
      const collectionStats = await Promise.all(
        cols.map(async (c) => ({
          name: c.name,
          count: await db.collection(c.name).countDocuments(),
        })),
      );
      collectionStats.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      const mem = process.memoryUsage();
      res.json({
        runtime: {
          nodeVersion: process.version,
          platform: `${os.type()} ${os.release()} (${os.arch()})`,
          cpus: os.cpus().length,
          loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
          uptimeSeconds: Math.round(process.uptime()),
          rssMb: Math.round(mem.rss / 1048576),
          heapUsedMb: Math.round(mem.heapUsed / 1048576),
          heapTotalMb: Math.round(mem.heapTotal / 1048576),
          totalSystemMemGb: Number((os.totalmem() / 1073741824).toFixed(1)),
          freeSystemMemGb: Number((os.freemem() / 1073741824).toFixed(1)),
        },
        database: {
          readyState: mongoose.connection.readyState,
          dbName: db.databaseName,
          totalCollections: collectionStats.length,
          totalDocuments: collectionStats.reduce((s, c) => s + c.count, 0),
          collections: collectionStats,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/system/seed-demo', async (req, res) => {
    try {
      const db = getDb();
      const patient =
        (await db.collection('users').findOne({ role: 'USER' })) ||
        (await db.collection('users').findOne({}));
      if (!patient) {
        return res.status(400).json({ error: 'No user found to attach sample cases.' });
      }
      const now = Date.now();
      const cases = [
        {
          title: '🦟 ডেঙ্গু জ্বর দিন ৫ — প্লাটিলেট ৩৮,০০০ ও হেমাটোক্রিট ৪৯%',
          prompt:
            'আমার ভাইয়ের ৫ দিন ধরে ডেঙ্গু জ্বর, আজকে CBC রিপোর্টে Platelet 38,000 এবং Hematocrit 49% এসেছে, পেটে ব্যথা করছে। ব্যথার জন্য Voltalin সাপোজিটরি দেওয়া যাবে কি?',
          toolName: `lab_result_interpreter_mcp_${MCP_SERVER_NAME}`,
          subagentId: 'agent_sub_emergency_triage',
          reply:
            '🚨 **জরুরি ডেঙ্গু বিপদ সংকেত (Critical Plasma Leakage Alert):** প্লাটিলেট **৩৮,০০০/µL** ও হেমাটোক্রিট **৪৯%** সাথে পেটে ব্যথা ক্রিটিক্যাল ডেঙ্গু প্লাজমা লিকেজের লক্ষণ। **কোনো অবস্থাতেই Voltalin (Diclofenac), Ibuprofen, Ketorolac বা Aspirin দেবেন না**—এতে মারাত্মক অভ্যন্তরীণ রক্তক্ষরণ হতে পারে। আজই নিকটস্থ হাসপাতালের জরুরি বিভাগে ভর্তি করুন।',
        },
        {
          title: '🫀 Clopid 75mg + CYP2C19 জেনেটিক রিপোর্ট ও সাশ্রয়ী বিকল্প',
          prompt:
            'বাবার হার্টে রিং পরানো হয়েছে, Clopid 75mg ও Bizoran 5/20 চলছে। ওনার CYP2C19 Intermediate Metabolizer রিপোর্ট এসেছে—ওষুধ কি বদলাতে হবে এবং Bizoran-এর সাশ্রয়ী বিকল্প কী?',
          toolName: `pharmacogenomics_guideline_mcp_${MCP_SERVER_NAME}`,
          subagentId: 'agent_sub_pharmacology_ddi',
          reply:
            '🧬 **CPIC Level A Pharmacogenomic Alert:** `Clopidogrel`-এ `CYP2C19` Intermediate Metabolizer রোগীদের স্টেন্ট থ্রম্বোসিসের ঝুঁকি বেশি থাকে; হৃদরোগ বিশেষজ্ঞের পরামর্শে **Prasugrel** বা **Ticagrelor** বিবেচনা করুন। পাশাপাশি `Bizoran 5/20` (`Amlodipine 5 mg + Olmesartan 20 mg`)-এর সমমানের সাশ্রয়ী বাংলাদেশি ব্র্যান্ডের তালিকা নিচে যুক্ত করা হলো।',
        },
        {
          title: '🧴 চর্মরোগ ও ঘুমের সমস্যা — ডায়নামিক সাব-এজেন্ট কেস',
          prompt:
            'মাথায় প্রচণ্ড খুশকি (Seborrheic dermatitis) ও রাতে একদম ঘুম হচ্ছে না। Ketoconazole 2% শ্যাম্পুর সাথে Melatonin নেওয়া নিরাপদ কি?',
          toolName: `bd_medicine_lookup_mcp_${MCP_SERVER_NAME}`,
          subagentId: 'agent_dyn_dermatology',
          reply:
            '🩺 **Dermatology + Sleep Board Synthesis:** টপিক্যাল `Ketoconazole 2%` শ্যাম্পু ও ওরাল `Melatonin`-এর মধ্যে কোনো ক্ষতিকর ওষুধের বিক্রিয়া নেই। সপ্তাহে ২–৩ দিন শ্যাম্পু ৫ মিনিট স্ক্যাল্পে রেখে ধুয়ে ফেলুন এবং ঘুমের জন্য নির্দিষ্ট সময়ে আলো কমিয়ে CBT-I নিয়ম অনুসরণ করুন।',
        },
      ];

      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const cid = crypto.randomUUID();
        const t1 = new Date(now - (cases.length - i) * 3600_000);
        const t2 = new Date(t1.getTime() + 4000);
        const uMsgId = crypto.randomUUID();
        const aMsgId = crypto.randomUUID();

        await db.collection('conversations').insertOne({
          conversationId: cid,
          user: patient._id,
          endpoint: 'agents',
          agent_id: PARENT_AGENT_ID,
          title: c.title,
          createdAt: t1,
          updatedAt: t2,
        });

        await db.collection('messages').insertMany([
          {
            messageId: uMsgId,
            conversationId: cid,
            user: String(patient._id),
            sender: 'User',
            text: c.prompt,
            isCreatedByUser: true,
            tokenCount: 68,
            createdAt: t1,
            updatedAt: t1,
          },
          {
            messageId: aMsgId,
            parentMessageId: uMsgId,
            conversationId: cid,
            user: String(patient._id),
            sender: 'Super-Power Doctor AI',
            model: DEFAULT_MODEL,
            endpoint: 'agents',
            text: c.reply,
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: `call_sub_${i}`,
                  name: 'subagent',
                  args: JSON.stringify({ subagent_id: c.subagentId, prompt: c.prompt }),
                  output: 'Specialist assessment completed cleanly.',
                },
              },
              {
                type: 'tool_call',
                tool_call: {
                  id: `call_mcp_${i}`,
                  name: c.toolName,
                  args: JSON.stringify({ query: c.title }),
                  output: 'Verified clinical guideline & BD formulary output.',
                },
              },
              { type: 'text', text: c.reply },
            ],
            isCreatedByUser: false,
            tokenCount: 245,
            createdAt: t2,
            updatedAt: t2,
          },
        ]);

        await db.collection('transactions').insertMany([
          {
            user: patient._id,
            conversationId: cid,
            tokenType: 'prompt',
            model: DEFAULT_MODEL,
            rawAmount: -640,
            tokenValue: -640,
            rate: 1,
            createdAt: t2,
            updatedAt: t2,
          },
          {
            user: patient._id,
            conversationId: cid,
            tokenType: 'completion',
            model: DEFAULT_MODEL,
            rawAmount: -310,
            tokenValue: -310,
            rate: 1,
            createdAt: t2,
            updatedAt: t2,
          },
        ]);
      }

      await writeAuditEntry(db, req, 'system.demo_cases.seeded', { count: cases.length });
      return res.status(201).json({ seeded: cases.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

const router = createMedicalCommandRouter();
router.createMedicalCommandRouter = createMedicalCommandRouter;
router.getFormularyAnalytics = getFormularyAnalytics;
router.searchFormularyCorpus = searchFormularyCorpus;
router.classifyClinicalMessageRisk = classifyClinicalMessageRisk;

module.exports = router;
