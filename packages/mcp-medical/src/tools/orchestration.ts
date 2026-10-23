import { z } from 'zod';
import {
  bulletList,
  composeResult,
  definitionList,
  heading,
} from '../format.js';
import { defineTool } from '../types.js';

interface SpecialtyProfile {
  slug: string;
  title: string;
  keywords: RegExp;
  recommendedTools: string[];
  redFlags: string[];
  contextQuestions: string[];
}

const SPECIALTY_PROFILES: SpecialtyProfile[] = [
  {
    slug: 'tropical_infectious_dengue',
    title: 'Tropical & Infectious Diseases Specialist Sub-Agent (Dengue / Typhoid / Sepsis)',
    keywords: /\b(dengue|typhoid|malaria|chikungunya|fever|platelet|ns1|antibiotic|infection|sepsis|pneumonia|tb|tuberculosis)\b/i,
    recommendedTools: [
      'lab_result_interpreter',
      'bd_medicine_lookup',
      'drug_interaction_check',
      'clinical_calculator',
      'pubmed_search',
      'health_statistics',
    ],
    redFlags: [
      'Dengue warning signs on defervescence (day 3–7): severe abdominal pain, persistent vomiting, mucosal bleeding, lethargy/restlessness, rising hematocrit with falling platelets (<50,000–100,000/µL)',
      'Sepsis / qSOFA criteria: altered mentation, respiratory rate >=22/min, systolic BP <=100 mmHg, or persistent SpO2 <92%',
      'Strict contraindication to NSAIDs (ibuprofen, diclofenac, ketorolac, naproxen) and aspirin until dengue hemorrhagic fever is excluded',
    ],
    contextQuestions: [
      'What day of fever is today, and what is the peak recorded temperature?',
      'Are there any warning signs: severe belly pain, repeated vomiting, gum/nose bleeding, black stools, dizziness, or reduced urine output?',
      'Have serial CBC (Hematocrit + Platelet count) or NS1/IgM tests been done, and what medicines were taken so far?',
    ],
  },
  {
    slug: 'cardio_nephro_metabolic',
    title: 'Cardio-Renal-Endocrine Specialist Sub-Agent',
    keywords: /\b(heart|bp|hypertension|cardiac|afib|cholesterol|statin|kidney|ckd|egfr|creatinine|diabetes|hba1c|insulin|thyroid|tsh)\b/i,
    recommendedTools: [
      'clinical_calculator',
      'lab_result_interpreter',
      'bd_medicine_lookup',
      'pharmacogenomics_guideline',
      'drug_label',
      'drug_interaction_check',
      'clinical_trials',
      'pubmed_search',
    ],
    redFlags: [
      'Chest pressure/pain radiating to arm/jaw/back, acute dyspnea, syncope, or focal stroke deficits (FAST) -> call 999 / 911 / 112 immediately',
      'Hypertensive emergency (BP >=180/120 mmHg WITH chest pain, dyspnea, visual loss, headache, or neurologic change)',
      'Severe hyperkalemia (K+ >=6.0 mEq/L), hypoglycemia (<54 mg/dL), DKA symptoms, or eGFR <15 mL/min/1.73m²',
    ],
    contextQuestions: [
      'What are the most recent home BP / fasting & post-meal blood glucose readings and latest serum creatinine + HbA1c?',
      'Please list every regular tablet (including exact strengths and fixed-dose combinations) and any OTC pain relievers.',
      'Is there any swelling of the feet, shortness of breath when lying flat, frothy urine, or chest tightness on exertion?',
    ],
  },
  {
    slug: 'maternal_fetal_lactation_peds',
    title: 'Maternal-Fetal, Lactation & Pediatric Safety Sub-Agent',
    keywords: /\b(pregnan|trimester|breastfeed|lactat|infant|baby|newborn|child|pediatric|syrup|drop|postpartum|ectopic)\b/i,
    recommendedTools: [
      'drug_lactation',
      'drug_label',
      'bd_medicine_lookup',
      'clinical_calculator',
      'drug_interaction_check',
      'pubmed_search',
    ],
    redFlags: [
      'Pregnancy red flags: vaginal bleeding, severe one-sided pelvic pain, severe headache/visual scotomata with BP >=140/90 (preeclampsia), decreased fetal movement, or fluid leakage',
      'Pediatric red flags: infant <3 months with fever >=38.0°C (100.4°F), chest indrawing/grunting, inability to drink/breastfeed, sunken fontanelle, lethargy, or non-blanching rash',
    ],
    contextQuestions: [
      'For pregnancy/lactation: exact gestational weeks OR infant chronological age (and whether pre-term) + exclusive vs partial breastfeeding?',
      'For children: exact recent body weight in kg and the exact mg/5 mL concentration printed on any liquid medicine bottle?',
      'Are there any danger signs in feeding, breathing rate, wet diapers, or alertness?',
    ],
  },
  {
    slug: 'neuro_psych_pain',
    title: 'Neurology, Headache & Neuropsychiatry Sub-Agent',
    keywords: /\b(migraine|headache|seizure|epilepsy|stroke|vertigo|neuropathy|sleep|insomnia|anxiety|depression|carbamazepine|sertraline)\b/i,
    recommendedTools: [
      'pharmacogenomics_guideline',
      'bd_medicine_lookup',
      'drug_interaction_check',
      'drug_label',
      'condition_lookup',
      'pubmed_search',
    ],
    redFlags: [
      'SNOOP10 headache red flags: thunderclap onset peaking within 60 seconds, fever + neck stiffness, papilledema/visual loss, focal weakness/speech change, pregnancy/postpartum onset, or age >50 new headache',
      'Any suicidal ideation or self-harm thoughts -> immediate crisis lifeline at top of message (988 US/Canada, 111 UK, Kaan Pete Roi +880-9612-119911 / Emergency 999 in Bangladesh)',
    ],
    contextQuestions: [
      'Did the symptom start suddenly like a thunderclap or build gradually, and how long does each episode last?',
      'Is there any vision change, weakness/numbness on one side, slurred speech, fever, or neck stiffness?',
      'Which acute pain medicines, preventives, or sedatives are currently being taken and how many days per week?',
    ],
  },
  {
    slug: 'gastro_hepatology_derma_general',
    title: 'Dynamic Subspecialty Clinical Research Sub-Agent',
    keywords: /.*/,
    recommendedTools: [
      'bd_medicine_lookup',
      'pharmacogenomics_guideline',
      'clinical_calculator',
      'lab_result_interpreter',
      'drug_lookup',
      'drug_label',
      'drug_interaction_check',
      'pubmed_search',
      'clinical_trials',
    ],
    redFlags: [
      'Hematemesis (vomiting blood), melena (black tarry stool), progressive dysphagia, unintentional weight loss, jaundice, or severe persistent pain',
      'Rapidly spreading mucocutaneous blistering/mucosal erosion after starting a medication (SJS/TEN emergency — stop suspect drug immediately & seek emergency hospital care)',
    ],
    contextQuestions: [
      'How long have the symptoms been present, and how have they changed over the past 48–72 hours?',
      'What chronic conditions, drug allergies, kidney/liver problems, or regular prescriptions/herbal supplements are present?',
      'Have any recent blood tests, imaging, or endoscopy reports been performed?',
    ],
  },
];

export const orchestrationTools = [
  defineTool({
    name: 'specialist_subagent_blueprint',
    group: 'orchestration',
    title: 'Dynamic specialist medical sub-agent blueprint generator',
    description:
      'Generate a structured, safety-hardened specialist sub-agent configuration on demand for any medical specialty, organ system, or complex multi-morbidity case. Maps the clinical query to an optimal subset of `@librechat/mcp-medical` tools, specialty red-flag triage rules, HealthBench context-seeking questions, and a persistable LibreChat `agent_dyn_*` schema.',
    readOnly: true,
    inputSchema: {
      specialty: z
        .string()
        .min(2)
        .describe('Requested medical specialty or domain, e.g. "Tropical Infectious Diseases & Dengue", "Nephrology", "Neurology", "Dermatology"'),
      clinical_focus: z
        .string()
        .min(3)
        .describe('Specific patient question or clinical problem this sub-agent must investigate'),
    },
    async handler(args, { env }) {
      const combined = `${args.specialty} ${args.clinical_focus}`;
      const matched =
        SPECIALTY_PROFILES.find((p) => p.keywords.test(combined)) ??
        SPECIALTY_PROFILES[SPECIALTY_PROFILES.length - 1];
      const cleanSlug = args.specialty
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 36);
      const agentId = `agent_dyn_${cleanSlug || matched.slug}`;

      const blueprintJson = JSON.stringify(
        {
          id: agentId,
          name: `${args.specialty.trim()} Specialist Sub-Agent`,
          category: 'medical-specialist',
          mcpTools: matched.recommendedTools,
          safetyInvariants: [
            'Never diagnose or prescribe/adjust doses',
            'Escalate red flags immediately with concrete time window',
            'Never cite unverified sources or retired FDA pregnancy letter categories',
          ],
        },
        null,
        2,
      );

      return composeResult({
        headline: `Generated dynamic sub-agent blueprint \`${agentId}\` (${matched.title}).`,
        sections: [
          [
            heading('Dynamic Specialist Sub-Agent Specification'),
            definitionList([
              ['Agent ID', agentId],
              ['Matched Clinical Profile', matched.title],
              ['Assigned Clinical Focus', args.clinical_focus],
              ['Recommended MCP Tools', matched.recommendedTools.join(', ')],
            ]),
          ].join('\n'),
          [heading('Mandatory Red-Flag Escalation Triggers'), bulletList(matched.redFlags)].join('\n'),
          [
            heading('HealthBench Context-Seeking Questions to Gather'),
            bulletList(matched.contextQuestions),
          ].join('\n'),
          [heading('LibreChat Agent Registration Payload'), blueprintJson].join('\n'),
        ],
        sources: [
          {
            name: 'HealthBench Clinical Evaluation Rubric (Arora et al., OpenAI 2025)',
            url: 'https://arxiv.org/abs/2505.08775',
          },
        ],
        env,
      });
    },
  }),
];
