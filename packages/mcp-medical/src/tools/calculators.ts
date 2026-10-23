import { z } from 'zod';
import {
  bulletList,
  composeResult,
  definitionList,
  heading,
  type SourceRef,
} from '../format.js';
import { defineTool } from '../types.js';

const CALCULATOR_IDS = [
  'ckd_epi_2021',
  'cockcroft_gault',
  'cha2ds2_vasc',
  'has_bled',
  'curb_65',
  'meld_na',
  'child_pugh',
  'wells_pe',
  'heart_score',
  'bmi_asian_who',
  'corrected_calcium',
  'anion_gap',
  'qtc_interval',
  'pediatric_dose_check',
] as const;

type CalculatorId = (typeof CALCULATOR_IDS)[number];

function num(inputs: Record<string, unknown>, key: string): number | undefined {
  const raw = inputs[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bool(inputs: Record<string, unknown>, key: string): boolean {
  const raw = inputs[key];
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'number') {
    return raw !== 0;
  }
  if (typeof raw === 'string') {
    return ['true', '1', 'yes', 'y', 'present', 'positive'].includes(raw.trim().toLowerCase());
  }
  return false;
}

function str(inputs: Record<string, unknown>, key: string): string {
  const raw = inputs[key];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function round(val: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

interface CalcResult {
  title: string;
  primaryValue: string;
  riskCategory: string;
  steps: string[];
  interpretation: string[];
  source: SourceRef;
}

function runCalculator(calculator: CalculatorId, inputs: Record<string, unknown>): CalcResult {
  switch (calculator) {
    case 'ckd_epi_2021': {
      const age = num(inputs, 'age');
      const scr = num(inputs, 'creatinine_mg_dl') ?? num(inputs, 'creatinine');
      const sex = str(inputs, 'sex') || str(inputs, 'gender');
      if (age == null || age < 18 || age > 120 || scr == null || scr <= 0 || !['male', 'female', 'm', 'f'].includes(sex)) {
        throw new Error(
          'ckd_epi_2021 requires adult `age` (18–120), positive `creatinine_mg_dl`, and `sex` ("male" or "female").',
        );
      }
      const isFemale = sex.startsWith('f');
      const kappa = isFemale ? 0.7 : 0.9;
      const alpha = isFemale ? -0.241 : -0.302;
      const sexFactor = isFemale ? 1.012 : 1.0;
      const ratio = scr / kappa;
      const egfr =
        142 *
        Math.min(ratio, 1) ** alpha *
        Math.max(ratio, 1) ** -1.2 *
        0.9938 ** age *
        sexFactor;
      const egfrRounded = round(egfr, 1);
      const stage =
        egfr >= 90
          ? 'G1 (Normal or high, >=90 mL/min/1.73m²)'
          : egfr >= 60
            ? 'G2 (Mildly decreased, 60–89 mL/min/1.73m²)'
            : egfr >= 45
              ? 'G3a (Mildly to moderately decreased, 45–59 mL/min/1.73m²)'
              : egfr >= 30
                ? 'G3b (Moderately to severely decreased, 30–44 mL/min/1.73m²)'
                : egfr >= 15
                  ? 'G4 (Severely decreased, 15–29 mL/min/1.73m² — nephrology co-management)'
                  : 'G5 (Kidney failure, <15 mL/min/1.73m² — urgent nephrology assessment)';
      return {
        title: '2021 CKD-EPI Creatinine Race-Free eGFR',
        primaryValue: `${egfrRounded} mL/min/1.73m²`,
        riskCategory: `KDIGO GFR Category ${stage}`,
        steps: [
          `Sex=${isFemale ? 'female' : 'male'} -> κ=${kappa}, α=${alpha}, sex_multiplier=${sexFactor}`,
          `SCr/κ = ${round(scr, 3)} / ${kappa} = ${round(ratio, 4)}`,
          `eGFR = 142 × min(${round(ratio, 4)}, 1)^(${alpha}) × max(${round(ratio, 4)}, 1)^(-1.200) × 0.9938^(${age}) × ${sexFactor} = ${egfrRounded} mL/min/1.73m²`,
        ],
        interpretation: [
          `KDIGO staging requires persistence >=3 months plus urine albumin-to-creatinine ratio (uACR) category (A1 <30, A2 30–300, A3 >300 mg/g).`,
          `For renally cleared medications whose FDA labels specify creatinine clearance in mL/min (e.g. DOACs, aminoglycosides, gabapentinoids), also compute cockcroft_gault.`,
        ],
        source: {
          name: 'Inker LA et al., NEJM 2021 (PMID 34554658)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/34554658/',
        },
      };
    }

    case 'cockcroft_gault': {
      const age = num(inputs, 'age');
      const weightKg = num(inputs, 'weight_kg') ?? num(inputs, 'weight');
      const scr = num(inputs, 'creatinine_mg_dl') ?? num(inputs, 'creatinine');
      const heightCm = num(inputs, 'height_cm');
      const sex = str(inputs, 'sex') || str(inputs, 'gender');
      if (age == null || age < 18 || weightKg == null || weightKg <= 0 || scr == null || scr <= 0 || !['male', 'female', 'm', 'f'].includes(sex)) {
        throw new Error(
          'cockcroft_gault requires `age` (>=18), `weight_kg` (>0), `creatinine_mg_dl` (>0), and `sex` ("male" or "female").',
        );
      }
      const isFemale = sex.startsWith('f');
      const mult = isFemale ? 0.85 : 1.0;
      const crclActual = ((140 - age) * weightKg * mult) / (72 * scr);
      const steps = [
        `Actual body weight CrCl = ((140 - ${age}) × ${weightKg} × ${mult}) / (72 × ${scr}) = ${round(crclActual, 1)} mL/min`,
      ];
      let dosingCrcl = crclActual;
      if (heightCm != null && heightCm > 100) {
        const inchesOver5Ft = Math.max(0, heightCm / 2.54 - 60);
        const ibw = (isFemale ? 45.5 : 50.0) + 2.3 * inchesOver5Ft;
        const adjBw = ibw + 0.4 * (weightKg - ibw);
        const usedWeight = weightKg < ibw ? weightKg : weightKg / ibw >= 1.2 ? adjBw : ibw;
        dosingCrcl = ((140 - age) * usedWeight * mult) / (72 * scr);
        steps.push(
          `Devine IBW = ${round(ibw, 1)} kg; Adjusted BW (0.4 factor) = ${round(adjBw, 1)} kg -> Weight-adjusted CrCl = ${round(dosingCrcl, 1)} mL/min`,
        );
      }
      return {
        title: 'Cockcroft-Gault Creatinine Clearance (CrCl)',
        primaryValue: `${round(dosingCrcl, 1)} mL/min (actual BW: ${round(crclActual, 1)} mL/min)`,
        riskCategory:
          dosingCrcl < 15
            ? 'Severe renal impairment (<15 mL/min)'
            : dosingCrcl < 30
              ? 'CrCl 15–29 mL/min (major renal dose-adjustment zone)'
              : dosingCrcl < 60
                ? 'CrCl 30–59 mL/min (moderate renal dose-adjustment zone)'
                : 'CrCl >=60 mL/min',
        steps,
        interpretation: [
          'Check the specific FDA label (via drug_label) to verify whether the manufacturer studied actual, ideal, or adjusted body weight.',
        ],
        source: {
          name: 'Cockcroft DW & Gault MH, Nephron 1976 (PMID 1244564)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/1244564/',
        },
      };
    }

    case 'cha2ds2_vasc': {
      const age = num(inputs, 'age') ?? 0;
      const isFemale = ['female', 'f'].includes(str(inputs, 'sex') || str(inputs, 'gender'));
      let score = 0;
      const components: string[] = [];
      if (bool(inputs, 'chf')) { score += 1; components.push('Congestive heart failure / LV dysfunction (+1)'); }
      if (bool(inputs, 'hypertension')) { score += 1; components.push('Hypertension (+1)'); }
      if (age >= 75) { score += 2; components.push(`Age ${age} >=75 (+2)`); }
      else if (age >= 65) { score += 1; components.push(`Age ${age} (65–74) (+1)`); }
      if (bool(inputs, 'diabetes')) { score += 1; components.push('Diabetes mellitus (+1)'); }
      if (bool(inputs, 'stroke_tia_te')) { score += 2; components.push('Prior stroke / TIA / thromboembolism (+2)'); }
      if (bool(inputs, 'vascular_disease')) { score += 1; components.push('Vascular disease (prior MI, PAD, aortic plaque) (+1)'); }
      if (isFemale) { score += 1; components.push('Female sex category modifier (+1)'); }
      const nonSexScore = isFemale ? score - 1 : score;
      const category =
        nonSexScore >= 2
          ? 'Elevated stroke risk (oral anticoagulation class I recommendation in guidelines if no contraindication)'
          : nonSexScore === 1
            ? 'Intermediate stroke risk (consider individualized oral anticoagulation discussion)'
            : 'Low risk (0 non-sex risk factors)';
      return {
        title: 'CHA2DS2-VASc Atrial Fibrillation Stroke Risk Score',
        primaryValue: `${score} / 9 points (${nonSexScore} non-sex points)`,
        riskCategory: category,
        steps: components.length > 0 ? components : ['No risk factors flagged (0 points)'],
        interpretation: [
          'Pair CHA2DS2-VASc with has_bled to identify modifiable bleeding risk factors rather than withholding indicated anticoagulation solely on bleeding score.',
        ],
        source: {
          name: 'Lip GYH et al., Chest 2010 (PMID 19762550)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/19762550/',
        },
      };
    }

    case 'has_bled': {
      const items: Array<[string, string]> = [
        ['hypertension_uncontrolled', 'Uncontrolled systolic BP >160 mmHg (+1)'],
        ['renal_disease', 'Abnormal renal function (dialysis, transplant, Cr >2.26 mg/dL) (+1)'],
        ['liver_disease', 'Abnormal liver function (cirrhosis or bilirubin >2x + AST/ALT/ALP >3x ULN) (+1)'],
        ['stroke_history', 'Prior stroke history (+1)'],
        ['prior_bleeding', 'Prior major bleeding or anemia/predisposition (+1)'],
        ['labile_inr', 'Labile INR (<60% TTR on warfarin) (+1)'],
        ['elderly_gt_65', 'Age >65 years (+1)'],
        ['drugs_antiplatelet_nsaid', 'Concomitant antiplatelet or NSAID therapy (+1)'],
        ['alcohol_excess', 'Excess alcohol >=8 drinks/week (+1)'],
      ];
      let score = 0;
      const matched: string[] = [];
      for (const [key, label] of items) {
        if (bool(inputs, key) || (key === 'elderly_gt_65' && (num(inputs, 'age') ?? 0) > 65)) {
          score += 1;
          matched.push(label);
        }
      }
      return {
        title: 'HAS-BLED Major Bleeding Risk Score',
        primaryValue: `${score} / 9 points`,
        riskCategory: score >= 3 ? 'High bleeding risk (>=3) — address modifiable risks & closer follow-up' : 'Low-to-moderate bleeding risk (<3)',
        steps: matched.length > 0 ? matched : ['0 HAS-BLED factors marked'],
        interpretation: [
          'A HAS-BLED score >=3 flags closer monitoring and correction of modifiable factors (uncontrolled BP, unnecessary NSAIDs/antiplatelets, labile INR, alcohol).',
        ],
        source: {
          name: 'Pisters R et al., Chest 2010 (PMID 20299623)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/20299623/',
        },
      };
    }

    case 'curb_65': {
      let score = 0;
      const steps: string[] = [];
      const bun = num(inputs, 'bun_mg_dl');
      const ureaMmol = num(inputs, 'urea_mmol_l');
      const rr = num(inputs, 'respiratory_rate');
      const sbp = num(inputs, 'systolic_bp');
      const dbp = num(inputs, 'diastolic_bp');
      const age = num(inputs, 'age') ?? 0;

      if (bool(inputs, 'confusion')) { score += 1; steps.push('New mental confusion (+1)'); }
      if ((bun != null && bun > 19) || (ureaMmol != null && ureaMmol > 7) || bool(inputs, 'urea_elevated')) {
        score += 1;
        steps.push('Blood urea elevated (BUN >19 mg/dL or Urea >7 mmol/L) (+1)');
      }
      if ((rr != null && rr >= 30) || bool(inputs, 'rr_ge_30')) { score += 1; steps.push(`Respiratory rate >=30/min (+1)`); }
      if ((sbp != null && sbp < 90) || (dbp != null && dbp <= 60) || bool(inputs, 'low_bp')) {
        score += 1;
        steps.push('Hypotension (SBP <90 or DBP <=60 mmHg) (+1)');
      }
      if (age >= 65 || bool(inputs, 'age_ge_65')) { score += 1; steps.push('Age >=65 years (+1)'); }

      const disposition =
        score <= 1
          ? 'Low 30-day mortality (~0.6–2.7%) — outpatient care often considered if SpO2 >=92% & able to take oral therapy'
          : score === 2
            ? 'Moderate 30-day mortality (~6.8–9.2%) — hospital admission / supervised inpatient assessment recommended'
            : 'Severe CAP (30-day mortality ~14–27%+) — urgent inpatient admission and ICU evaluation (especially score 4–5)';
      return {
        title: 'CURB-65 Community-Acquired Pneumonia Severity Score',
        primaryValue: `${score} / 5 points`,
        riskCategory: disposition,
        steps: steps.length > 0 ? steps : ['0 CURB-65 criteria present'],
        interpretation: [
          'Always override low CURB-65 scores if hypoxemia (SpO2 <90–92%), sepsis, multilobar infiltrates, pleural effusion, or inability to tolerate oral intake is present.',
        ],
        source: {
          name: 'Lim WS et al., Thorax 2003 (PMID 12728155)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/12728155/',
        },
      };
    }

    case 'meld_na': {
      const biliRaw = num(inputs, 'bilirubin_mg_dl');
      const inrRaw = num(inputs, 'inr');
      const crRaw = num(inputs, 'creatinine_mg_dl');
      const naRaw = num(inputs, 'sodium_meq_l');
      const dialysis = bool(inputs, 'dialysis_twice_past_week');
      if (biliRaw == null || inrRaw == null || crRaw == null || naRaw == null) {
        throw new Error('meld_na requires `bilirubin_mg_dl`, `inr`, `creatinine_mg_dl`, and `sodium_meq_l`.');
      }
      const bili = Math.max(1.0, biliRaw);
      const inr = Math.max(1.0, inrRaw);
      const cr = dialysis ? 4.0 : Math.min(4.0, Math.max(1.0, crRaw));
      const na = Math.min(137, Math.max(125, naRaw));
      const meld = 3.78 * Math.log(bili) + 11.2 * Math.log(inr) + 9.57 * Math.log(cr) + 6.43;
      const meldRounded = Math.round(meld);
      const meldNa =
        meldRounded > 11
          ? Math.round(meld + 1.32 * (137 - na) - 0.033 * meld * (137 - na))
          : meldRounded;
      return {
        title: 'MELD & MELD-Na Liver Disease Severity Score',
        primaryValue: `MELD-Na: ${meldNa} (MELD(i): ${meldRounded})`,
        riskCategory:
          meldNa >= 30
            ? 'Very high 90-day mortality (>50%)'
            : meldNa >= 20
              ? 'High 90-day mortality (~20%) — transplant hepatology evaluation'
              : meldNa >= 10
                ? 'Moderate chronic liver disease risk (~6% 90-day mortality)'
                : 'Low 90-day mortality (~1.9%)',
        steps: [
          `Bounded inputs: Bilirubin=${bili} mg/dL, INR=${inr}, Creatinine=${cr} mg/dL${dialysis ? ' (capped at 4.0 for dialysis)' : ''}, Sodium=${na} mEq/L`,
          `MELD(i) = 3.78×ln(${bili}) + 11.2×ln(${inr}) + 9.57×ln(${cr}) + 6.43 = ${round(meld, 2)} -> ${meldRounded}`,
          `MELD-Na = ${meldNa}`,
        ],
        interpretation: ['Used for cirrhosis prognostic stratification and hepatology referral prioritization.'],
        source: {
          name: 'Kim WR et al., NEJM 2008 (PMID 18768945)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/18768945/',
        },
      };
    }

    case 'child_pugh': {
      const bili = num(inputs, 'bilirubin_mg_dl') ?? 1.0;
      const alb = num(inputs, 'albumin_g_dl') ?? 3.8;
      const inr = num(inputs, 'inr') ?? 1.0;
      const ascites = str(inputs, 'ascites') || 'none';
      const enceph = str(inputs, 'encephalopathy') || 'none';
      const pBili = bili > 3 ? 3 : bili >= 2 ? 2 : 1;
      const pAlb = alb < 2.8 ? 3 : alb <= 3.5 ? 2 : 1;
      const pInr = inr > 2.3 ? 3 : inr >= 1.7 ? 2 : 1;
      const pAsc = ['moderate', 'severe', 'refractory', 'grade 3'].includes(ascites) ? 3 : ['mild', 'slight', 'controlled'].includes(ascites) ? 2 : 1;
      const pEnc = ['grade 3', 'grade 4', 'severe'].includes(enceph) ? 3 : ['grade 1', 'grade 2', 'mild', 'moderate'].includes(enceph) ? 2 : 1;
      const total = pBili + pAlb + pInr + pAsc + pEnc;
      const cls = total >= 10 ? 'Class C (Decompensated, 10–15 pts)' : total >= 7 ? 'Class B (Significant functional compromise, 7–9 pts)' : 'Class A (Well-compensated, 5–6 pts)';
      return {
        title: 'Child-Pugh Cirrhosis Classification',
        primaryValue: `${total} / 15 points (${cls})`,
        riskCategory: cls,
        steps: [
          `Bilirubin (${bili} mg/dL -> +${pBili}), Albumin (${alb} g/dL -> +${pAlb}), INR (${inr} -> +${pInr}), Ascites (${ascites} -> +${pAsc}), Encephalopathy (${enceph} -> +${pEnc})`,
        ],
        interpretation: ['Many hepatic drug labels specify Child-Pugh Class A/B/C dose adjustments or contraindications.'],
        source: {
          name: 'Pugh RNH et al., Br J Surg 1973 (PMID 4541913)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/4541913/',
        },
      };
    }

    case 'wells_pe': {
      let score = 0;
      const steps: string[] = [];
      const criteria: Array<[string, number, string]> = [
        ['dvt_signs', 3.0, 'Clinical signs/symptoms of DVT (+3.0)'],
        ['pe_most_likely', 3.0, 'PE equally or more likely than alternative diagnosis (+3.0)'],
        ['hr_gt_100', 1.5, 'Heart rate >100 bpm (+1.5)'],
        ['immobilization_or_surgery', 1.5, 'Immobilization >=3 days or surgery within 4 weeks (+1.5)'],
        ['prior_dvt_pe', 1.5, 'Previous objective DVT or PE (+1.5)'],
        ['hemoptysis', 1.0, 'Hemoptysis (+1.0)'],
        ['malignancy', 1.0, 'Active or treated malignancy within 6 months (+1.0)'],
      ];
      for (const [k, pts, label] of criteria) {
        if (bool(inputs, k) || (k === 'hr_gt_100' && (num(inputs, 'heart_rate') ?? 0) > 100)) {
          score += pts;
          steps.push(label);
        }
      }
      const twoTier = score > 4 ? 'PE Likely (>4.0 points — diagnostic CTPA evaluation)' : 'PE Unlikely (<=4.0 points — high-sensitivity D-dimer / PERC pathway)';
      return {
        title: 'Wells Criteria for Pulmonary Embolism',
        primaryValue: `${score.toFixed(1)} points`,
        riskCategory: twoTier,
        steps: steps.length > 0 ? steps : ['0 Wells PE criteria present'],
        interpretation: ['Suspected acute pulmonary embolism is a medical emergency requiring immediate emergency department evaluation.'],
        source: {
          name: 'Wells PS et al., Ann Intern Med 2001 (PMID 11453709)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/11453709/',
        },
      };
    }

    case 'heart_score': {
      const h = Math.min(2, Math.max(0, num(inputs, 'history') ?? 0));
      const e = Math.min(2, Math.max(0, num(inputs, 'ecg') ?? 0));
      const age = num(inputs, 'age');
      const a = age != null ? (age >= 65 ? 2 : age >= 45 ? 1 : 0) : Math.min(2, Math.max(0, num(inputs, 'age_points') ?? 0));
      const r = Math.min(2, Math.max(0, num(inputs, 'risk_factors') ?? 0));
      const t = Math.min(2, Math.max(0, num(inputs, 'troponin') ?? 0));
      const total = h + e + a + r + t;
      return {
        title: 'HEART Score for Major Cardiac Events',
        primaryValue: `${total} / 10 points`,
        riskCategory:
          total >= 7
            ? 'High 6-week MACE risk (~50–65%) — emergent cardiology / invasive strategy evaluation'
            : total >= 4
              ? 'Moderate 6-week MACE risk (~12–16.6%) — hospital observation & serial troponin testing'
              : 'Low 6-week MACE risk (~0.9–1.7%) WITH serial negative high-sensitivity troponins',
        steps: [`History=${h}, ECG=${e}, Age=${a}, Risk factors=${r}, Troponin=${t}`],
        interpretation: ['Active chest pain always requires emergency ECG and high-sensitivity troponin evaluation before outpatient disposition.'],
        source: {
          name: 'Six AJ et al., Neth Heart J 2008 (PMID 18665203)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/18665203/',
        },
      };
    }

    case 'bmi_asian_who': {
      const weightKg = num(inputs, 'weight_kg') ?? num(inputs, 'weight');
      const heightCm = num(inputs, 'height_cm') ?? num(inputs, 'height');
      if (weightKg == null || weightKg <= 0 || heightCm == null || heightCm <= 0) {
        throw new Error('bmi_asian_who requires positive `weight_kg` and `height_cm`.');
      }
      const heightM = heightCm / 100;
      const bmi = weightKg / (heightM * heightM);
      const bsa = Math.sqrt((heightCm * weightKg) / 3600);
      const asianClass =
        bmi < 18.5
          ? 'Underweight (<18.5 kg/m²)'
          : bmi < 23.0
            ? 'Normal range — South Asian cutoff (18.5–22.9 kg/m²)'
            : bmi < 25.0
              ? 'Overweight / Increased cardiometabolic risk — South Asian cutoff (23.0–24.9 kg/m²)'
              : bmi < 30.0
                ? 'Obese Class I — South Asian cutoff (25.0–29.9 kg/m²)'
                : 'Obese Class II — South Asian cutoff (>=30.0 kg/m²)';
      const whoClass =
        bmi < 18.5
          ? 'WHO Underweight (<18.5)'
          : bmi < 25.0
            ? 'WHO Normal (18.5–24.9)'
            : bmi < 30.0
              ? 'WHO Overweight (25.0–29.9)'
              : 'WHO Obese (>=30.0)';
      return {
        title: 'BMI (South Asian + WHO Thresholds) & Mosteller BSA',
        primaryValue: `BMI ${round(bmi, 1)} kg/m² · BSA ${round(bsa, 2)} m²`,
        riskCategory: `${asianClass} | ${whoClass}`,
        steps: [
          `BMI = ${weightKg} / (${round(heightM, 3)})² = ${round(bmi, 2)} kg/m²`,
          `Mosteller BSA = sqrt((${heightCm} × ${weightKg}) / 3600) = ${round(bsa, 3)} m²`,
        ],
        interpretation: [
          'South Asian populations develop insulin resistance, fatty liver, and cardiovascular risk at lower BMI thresholds (>=23.0 kg/m² overweight; >=25.0 kg/m² obesity).',
        ],
        source: {
          name: 'WHO Expert Consultation on Appropriate BMI for Asian Populations, Lancet 2004 (PMID 14726171)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/14726171/',
        },
      };
    }

    case 'corrected_calcium': {
      const ca = num(inputs, 'calcium_mg_dl');
      const alb = num(inputs, 'albumin_g_dl');
      if (ca == null || alb == null) {
        throw new Error('corrected_calcium requires `calcium_mg_dl` and `albumin_g_dl`.');
      }
      const corrected = ca + 0.8 * (4.0 - alb);
      return {
        title: 'Payne Albumin-Corrected Serum Calcium',
        primaryValue: `${round(corrected, 2)} mg/dL`,
        riskCategory:
          corrected >= 14.0
            ? 'CRITICAL HYPERCALCEMIA (>=14.0 mg/dL — emergency IV hydration & evaluation)'
            : corrected > 10.5
              ? 'Hypercalcemia (>10.5 mg/dL)'
              : corrected < 7.0
                ? 'CRITICAL HYPOCALCEMIA (<7.0 mg/dL — urgent ECG/ionized Ca check)'
                : corrected < 8.5
                  ? 'Hypocalcemia (<8.5 mg/dL)'
                  : 'Reference range (8.5–10.5 mg/dL)',
        steps: [`Corrected Ca = ${ca} + 0.8 × (4.0 - ${alb}) = ${round(corrected, 2)} mg/dL`],
        interpretation: ['Confirm borderline or critical abnormalities directly with ionized calcium.'],
        source: {
          name: 'Payne RB et al., BMJ 1973 (PMID 4758544)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/4758544/',
        },
      };
    }

    case 'anion_gap': {
      const na = num(inputs, 'sodium_meq_l');
      const cl = num(inputs, 'chloride_meq_l');
      const hco3 = num(inputs, 'bicarbonate_meq_l');
      const alb = num(inputs, 'albumin_g_dl');
      if (na == null || cl == null || hco3 == null) {
        throw new Error('anion_gap requires `sodium_meq_l`, `chloride_meq_l`, and `bicarbonate_meq_l`.');
      }
      const ag = na - (cl + hco3);
      const correctedAg = alb != null ? ag + 2.5 * (4.0 - alb) : ag;
      return {
        title: 'Serum Anion Gap (with Figge Albumin Correction)',
        primaryValue: `${round(correctedAg, 1)} mEq/L (uncorrected: ${round(ag, 1)} mEq/L)`,
        riskCategory:
          correctedAg > 12
            ? 'Elevated Anion Gap Metabolic Acidosis (>12 mEq/L — evaluate GOLDMARK: ketoacidosis, lactic acidosis, renal failure, toxins/salicylates)'
            : 'Normal Anion Gap (<=12 mEq/L)',
        steps: [
          `Uncorrected AG = ${na} - (${cl} + ${hco3}) = ${round(ag, 1)} mEq/L`,
          ...(alb != null ? [`Figge Albumin-Corrected AG = ${round(ag, 1)} + 2.5 × (4.0 - ${alb}) = ${round(correctedAg, 1)} mEq/L`] : []),
        ],
        interpretation: ['An elevated anion gap requires immediate arterial/venous blood gas, serum ketones/beta-hydroxybutyrate, lactate, renal panel, and toxicology review.'],
        source: {
          name: 'Figge J et al., Crit Care Med 1998 (PMID 9824071)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/9824071/',
        },
      };
    }

    case 'qtc_interval': {
      const qtMs = num(inputs, 'qt_ms');
      const hr = num(inputs, 'heart_rate_bpm') ?? num(inputs, 'heart_rate');
      if (qtMs == null || qtMs <= 0 || hr == null || hr <= 0) {
        throw new Error('qtc_interval requires positive `qt_ms` and `heart_rate_bpm`.');
      }
      const rrSec = 60 / hr;
      const bazett = qtMs / Math.sqrt(rrSec);
      const fridericia = qtMs / Math.cbrt(rrSec);
      return {
        title: 'Corrected QT Interval (Fridericia & Bazett)',
        primaryValue: `Fridericia QTcF: ${Math.round(fridericia)} ms · Bazett QTcB: ${Math.round(bazett)} ms`,
        riskCategory:
          fridericia >= 500 || bazett >= 500
            ? 'MARKED QTc PROLONGATION (>=500 ms — high Torsades de Pointes risk; urgent clinician review & K+/Mg2+ check)'
            : fridericia >= 460
              ? 'Borderline/prolonged QTc (460–499 ms — review QT-prolonging medications)'
              : 'Normal QTc (<450–460 ms)',
        steps: [
          `RR = 60 / ${hr} = ${round(rrSec, 3)} s`,
          `Fridericia QTcF = ${qtMs} / (${round(rrSec, 3)})^(1/3) = ${round(fridericia, 1)} ms (preferred in tachycardia/bradycardia)`,
          `Bazett QTcB = ${qtMs} / sqrt(${round(rrSec, 3)}) = ${round(bazett, 1)} ms`,
        ],
        interpretation: ['Prefer Fridericia (QTcF) when heart rate is <60 or >100 bpm because Bazett over-corrects in tachycardia.'],
        source: {
          name: 'AHA/ACC/HRS QT Interval Standardization Scientific Statement, Circulation 2009 (PMID 19221222)',
          url: 'https://pubmed.ncbi.nlm.nih.gov/19221222/',
        },
      };
    }

    case 'pediatric_dose_check': {
      const weightKg = num(inputs, 'weight_kg') ?? num(inputs, 'weight');
      const mgPerKgPerDose = num(inputs, 'mg_per_kg_per_dose');
      const adultMaxSingleMg = num(inputs, 'adult_max_single_dose_mg');
      const suspensionMgPer5Ml = num(inputs, 'concentration_mg_per_5ml');
      if (weightKg == null || weightKg <= 0 || mgPerKgPerDose == null || mgPerKgPerDose <= 0) {
        throw new Error('pediatric_dose_check requires positive `weight_kg` and `mg_per_kg_per_dose` from the official label.');
      }
      const rawMg = weightKg * mgPerKgPerDose;
      const cappedMg = adultMaxSingleMg != null ? Math.min(rawMg, adultMaxSingleMg) : rawMg;
      const volumeMl = suspensionMgPer5Ml != null && suspensionMgPer5Ml > 0 ? (cappedMg * 5) / suspensionMgPer5Ml : null;
      return {
        title: 'Weight-Based Pediatric Reference Math Verification',
        primaryValue: `${round(cappedMg, 1)} mg${volumeMl != null ? ` (${round(volumeMl, 2)} mL at ${suspensionMgPer5Ml} mg/5 mL)` : ''}`,
        riskCategory:
          adultMaxSingleMg != null && rawMg > adultMaxSingleMg
            ? `Capped at adult single-dose ceiling (${adultMaxSingleMg} mg; uncapped weight math was ${round(rawMg, 1)} mg)`
            : 'Weight-multiplied label reference value',
        steps: [
          `Raw weight multiplication: ${weightKg} kg × ${mgPerKgPerDose} mg/kg = ${round(rawMg, 2)} mg`,
          ...(adultMaxSingleMg != null ? [`Adult ceiling check: min(${round(rawMg, 2)}, ${adultMaxSingleMg}) = ${round(cappedMg, 2)} mg`] : []),
          ...(volumeMl != null ? [`Oral liquid volume: (${round(cappedMg, 2)} mg × 5 mL) / ${suspensionMgPer5Ml} mg = ${round(volumeMl, 2)} mL`] : []),
        ],
        interpretation: [
          'Reference math check only — confirm exact indication, age minimum, renal/hepatic function, dosing interval, and concentration on the bottle with a pediatrician or pharmacist before administering any medicine.',
        ],
        source: {
          name: 'AAP Safe Pediatric Weight-Based Dosing Principles',
          url: 'https://dailymed.nlm.nih.gov/dailymed/',
        },
      };
    }
  }
}

interface LabRange {
  label: string;
  unit: string;
  low: number;
  high: number;
  panicLow?: number;
  panicHigh?: number;
  noteLow?: string;
  noteHigh?: string;
}

const LAB_RANGES: Record<string, LabRange> = {
  hemoglobin: { label: 'Hemoglobin (Hb)', unit: 'g/dL', low: 12.0, high: 17.5, panicLow: 7.0, panicHigh: 20.0, noteLow: 'Anemia — evaluate iron/ferritin, B12/folate, blood loss, thalassemia trait, or CKD', noteHigh: 'Erythrocytosis / hemoconcentration (critical clue in Dengue plasma leakage)' },
  hematocrit: { label: 'Hematocrit (Hct / PCV)', unit: '%', low: 36, high: 50, panicLow: 21, panicHigh: 60, noteLow: 'Decreased red cell mass / dilution / bleeding', noteHigh: 'Hemoconcentration (>=20% rise over baseline in fever strongly warns of Dengue capillary plasma leakage)' },
  wbc: { label: 'White Blood Cell Count (WBC)', unit: '×10³/µL', low: 4.0, high: 11.0, panicLow: 1.5, panicHigh: 30.0, noteLow: 'Leukopenia (common in viral syndromes incl. Dengue, typhoid, drug marrow suppression)', noteHigh: 'Leukocytosis (bacterial infection, inflammation, stress, or hematologic disorder)' },
  platelets: { label: 'Platelets', unit: '×10³/µL', low: 150, high: 450, panicLow: 20, panicHigh: 1000, noteLow: 'Thrombocytopenia — strictly avoid NSAIDs/aspirin; emergency hospital evaluation if <50,000, rapidly falling, or any bleeding', noteHigh: 'Thrombocytosis (reactive vs myeloproliferative)' },
  sodium: { label: 'Serum Sodium (Na+)', unit: 'mEq/L', low: 135, high: 145, panicLow: 120, panicHigh: 160, noteLow: 'Hyponatremia', noteHigh: 'Hypernatremia' },
  potassium: { label: 'Serum Potassium (K+)', unit: 'mEq/L', low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.0, noteLow: 'Hypokalemia — arrhythmia risk', noteHigh: 'Hyperkalemia — urgent ECG & arrhythmia risk' },
  creatinine: { label: 'Serum Creatinine', unit: 'mg/dL', low: 0.6, high: 1.2, panicHigh: 5.0, noteHigh: 'Elevated creatinine — compute race-free eGFR via clinical_calculator (ckd_epi_2021)' },
  bun: { label: 'Blood Urea Nitrogen (BUN)', unit: 'mg/dL', low: 7, high: 20, panicHigh: 80, noteHigh: 'Azotemia / dehydration / upper GI bleed / catabolism' },
  fasting_glucose: { label: 'Fasting Plasma Glucose', unit: 'mg/dL', low: 70, high: 99, panicLow: 54, panicHigh: 400, noteLow: 'Hypoglycemia', noteHigh: 'Hyperglycemia (100–125 impaired fasting glucose; >=126 diabetes threshold on repeat testing)' },
  hba1c: { label: 'HbA1c', unit: '%', low: 4.0, high: 5.6, panicHigh: 12.0, noteHigh: '5.7–6.4% prediabetes range; >=6.5% diabetes diagnostic range (verify hemoglobinopathies/thalassemia common in South Asia)' },
  alt: { label: 'ALT (SGPT)', unit: 'U/L', low: 7, high: 45, panicHigh: 1000, noteHigh: 'Hepatocellular injury marker (viral hepatitis A/B/E, fatty liver MASLD, dengue, drug-induced)' },
  ast: { label: 'AST (SGOT)', unit: 'U/L', low: 8, high: 40, panicHigh: 1000, noteHigh: 'Hepatic / muscle transaminase elevation' },
  alp: { label: 'Alkaline Phosphatase (ALP)', unit: 'U/L', low: 44, high: 147, noteHigh: 'Cholestatic / biliary or bone turnover elevation' },
  bilirubin_total: { label: 'Total Bilirubin', unit: 'mg/dL', low: 0.1, high: 1.2, panicHigh: 15.0, noteHigh: 'Hyperbilirubinemia / jaundice — fractionate direct vs indirect bilirubin' },
  albumin: { label: 'Serum Albumin', unit: 'g/dL', low: 3.5, high: 5.0, panicLow: 2.0, noteLow: 'Hypoalbuminemia (chronic liver disease, nephrotic loss, malnutrition, inflammation)' },
  tsh: { label: 'TSH', unit: 'mIU/L', low: 0.4, high: 4.0, panicLow: 0.01, panicHigh: 50.0, noteLow: 'Suppressed TSH — evaluate Free T4 & Free T3 for hyperthyroidism', noteHigh: 'Elevated TSH — evaluate Free T4 for hypothyroidism' },
  free_t4: { label: 'Free T4', unit: 'ng/dL', low: 0.8, high: 1.8, noteLow: 'Low Free T4', noteHigh: 'Elevated Free T4' },
  ldl: { label: 'LDL Cholesterol', unit: 'mg/dL', low: 0, high: 100, noteHigh: 'Elevated atherogenic LDL-C (interpret against overall ASCVD risk, diabetes, and CKD)' },
  hdl: { label: 'HDL Cholesterol', unit: 'mg/dL', low: 40, high: 100, noteLow: 'Low HDL-C cardiometabolic marker' },
  triglycerides: { label: 'Triglycerides', unit: 'mg/dL', low: 0, high: 149, panicHigh: 500, noteHigh: 'Hypertriglyceridemia (>=500 mg/dL carries acute pancreatitis risk)' },
  inr: { label: 'INR', unit: 'ratio', low: 0.8, high: 1.2, panicHigh: 4.5, noteHigh: 'Prolonged INR (supratherapeutic anticoagulation or coagulopathy — bleeding risk)' },
  crp: { label: 'C-Reactive Protein (CRP)', unit: 'mg/L', low: 0, high: 5.0, noteHigh: 'Systemic inflammation or infection marker' },
  uric_acid: { label: 'Serum Uric Acid', unit: 'mg/dL', low: 3.0, high: 7.0, noteHigh: 'Hyperuricemia' },
  vitamin_d: { label: '25-Hydroxy Vitamin D', unit: 'ng/mL', low: 30, high: 100, noteLow: 'Vitamin D insufficiency/deficiency (<20 ng/mL deficient; 20–29 ng/mL insufficient)' },
  ferritin: { label: 'Serum Ferritin', unit: 'ng/mL', low: 30, high: 300, noteLow: 'Depleted iron stores', noteHigh: 'Elevated ferritin (acute-phase reactant, dengue hyperferritinemia, or iron overload)' },
};

export const calculatorTools = [
  defineTool({
    name: 'clinical_calculator',
    group: 'calculators',
    title: 'Deterministic peer-reviewed clinical equation & risk score calculator',
    description:
      'Execute exact, step-audited peer-reviewed clinical equations and risk scores instead of mental LLM arithmetic: `ckd_epi_2021` (race-free eGFR), `cockcroft_gault` (CrCl for renal drug dosing), `cha2ds2_vasc`, `has_bled`, `curb_65`, `meld_na`, `child_pugh`, `wells_pe`, `heart_score`, `bmi_asian_who` (South Asian + WHO cutoffs & Mosteller BSA), `corrected_calcium`, `anion_gap`, `qtc_interval` (Fridericia & Bazett), and `pediatric_dose_check` (mg/kg math with adult ceiling cap). Always use this tool whenever clinical numbers are present.',
    readOnly: true,
    inputSchema: {
      calculator: z
        .enum(CALCULATOR_IDS)
        .describe('Identifier of the validated clinical equation or score to compute'),
      inputs: z
        .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
        .describe(
          'Named input measurements, e.g. {"age": 64, "sex": "male", "creatinine_mg_dl": 1.65, "weight_kg": 72, "height_cm": 168}',
        ),
    },
    async handler(args, { env }) {
      try {
        const computed = runCalculator(args.calculator, args.inputs);
        return composeResult({
          headline: `${computed.title}: ${computed.primaryValue} (${computed.riskCategory})`,
          sections: [
            [
              heading('Deterministic Step-by-Step Calculation'),
              definitionList([
                ['Calculator', computed.title],
                ['Result', computed.primaryValue],
                ['Clinical Stratification', computed.riskCategory],
              ]),
              bulletList(computed.steps),
            ].join('\n'),
            [heading('Clinical Context & Caveats'), bulletList(computed.interpretation)].join('\n'),
          ],
          sources: [computed.source],
          notices: [
            'Quantitative clinical scores support clinician judgment and never replace physical examination, serial trends, or emergency evaluation.',
          ],
          env,
        });
      } catch (err) {
        return {
          text: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  }),

  defineTool({
    name: 'lab_result_interpreter',
    group: 'calculators',
    title: 'Multi-panel clinical laboratory & critical panic-value interpreter',
    description:
      'Analyze structured blood/chemistry laboratory values across CBC (including Dengue hemoconcentration + thrombocytopenia warning pattern), Renal/Electrolytes, Liver Panel (AST/ALT/ALP/Bilirubin/Albumin), Glycemic (Fasting Glucose/HbA1c eAG), Thyroid (TSH/Free T4), Lipids, Coagulation (INR), and Inflammatory/Nutritional markers. Flags critical life-threatening panic values immediately.',
    readOnly: true,
    inputSchema: {
      values: z
        .record(z.string(), z.number())
        .describe(
          'Map of analyte keys to numeric values in standard units, e.g. {"hemoglobin": 15.8, "hematocrit": 49, "platelets": 68, "wbc": 3.1, "alt": 112, "ast": 148, "creatinine": 1.4, "potassium": 5.4, "hba1c": 7.8}',
        ),
      clinical_context: z
        .string()
        .optional()
        .describe('Optional clinical context such as fever day 4, anticoagulation, pregnancy, or chronic kidney disease'),
    },
    async handler(args, { env }) {
      const entries = Object.entries(args.values);
      if (entries.length === 0) {
        return { text: 'Provide at least one numeric laboratory analyte in `values`.', isError: true };
      }

      const panicAlerts: string[] = [];
      const abnormalRows: string[] = [];
      const normalRows: string[] = [];
      const unrecognized: string[] = [];

      for (const [rawKey, val] of entries) {
        const key = rawKey.trim().toLowerCase();
        const spec = LAB_RANGES[key];
        if (spec == null) {
          unrecognized.push(`${rawKey}: ${val}`);
          continue;
        }
        if (spec.panicLow != null && val <= spec.panicLow) {
          panicAlerts.push(
            `CRITICAL LOW ${spec.label}: ${val} ${spec.unit} (critical threshold <=${spec.panicLow} ${spec.unit}) — immediate emergency clinical assessment required.`,
          );
        } else if (spec.panicHigh != null && val >= spec.panicHigh) {
          panicAlerts.push(
            `CRITICAL HIGH ${spec.label}: ${val} ${spec.unit} (critical threshold >=${spec.panicHigh} ${spec.unit}) — immediate emergency clinical assessment required.`,
          );
        }

        if (val < spec.low) {
          abnormalRows.push(
            `LOW ${spec.label}: ${val} ${spec.unit} (Adult reference ${spec.low}–${spec.high} ${spec.unit})${spec.noteLow ? ` — ${spec.noteLow}` : ''}`,
          );
        } else if (val > spec.high) {
          abnormalRows.push(
            `HIGH ${spec.label}: ${val} ${spec.unit} (Adult reference ${spec.low}–${spec.high} ${spec.unit})${spec.noteHigh ? ` — ${spec.noteHigh}` : ''}`,
          );
        } else {
          normalRows.push(`${spec.label}: ${val} ${spec.unit} (within ${spec.low}–${spec.high} ${spec.unit})`);
        }
      }

      const patterns: string[] = [];
      const plt = args.values.platelets;
      const hct = args.values.hematocrit;
      const wbc = args.values.wbc;
      if (plt != null && plt < 100 && ((hct != null && hct >= 45) || (wbc != null && wbc < 4.0))) {
        patterns.push(
          'Dengue Plasma-Leakage / Viral Hemorrhagic Warning Pattern: Thrombocytopenia (<100 ×10³/µL) alongside elevated hematocrit or leukopenia demands urgent serial CBC monitoring, oral/IV hydration assessment, strict avoidance of all NSAIDs/aspirin (use paracetamol only within hepatic limits), and immediate hospital care for warning signs (abdominal pain, persistent vomiting, mucosal bleeding, lethargy).',
        );
      }
      const hba1c = args.values.hba1c;
      if (hba1c != null && hba1c >= 4) {
        const eag = round(28.7 * hba1c - 46.7, 0);
        patterns.push(`Estimated Average Glucose (Nathan ADAG formula) for HbA1c ${hba1c}%: ~${eag} mg/dL.`);
      }
      const ast = args.values.ast;
      const alt = args.values.alt;
      if (ast != null && alt != null && alt > 0 && (ast > 45 || alt > 45)) {
        patterns.push(`AST/ALT (De Ritis) Ratio = ${round(ast / alt, 2)} (AST ${ast} U/L, ALT ${alt} U/L).`);
      }

      const sections: string[] = [];
      if (panicAlerts.length > 0) {
        sections.push([heading('CRITICAL PANIC VALUE ALERTS'), bulletList(panicAlerts)].join('\n'));
      }
      if (patterns.length > 0) {
        sections.push([heading('Multi-Analyte Clinical Pattern Synthesis'), bulletList(patterns)].join('\n'));
      }
      if (abnormalRows.length > 0) {
        sections.push([heading('Out-of-Range Findings'), bulletList(abnormalRows)].join('\n'));
      }
      if (normalRows.length > 0) {
        sections.push([heading('Within Reference Interval'), bulletList(normalRows)].join('\n'));
      }
      if (unrecognized.length > 0) {
        sections.push(
          [
            heading('Unmapped Analyte Keys (Verify Against Printed Lab Reference Range)'),
            bulletList(unrecognized),
          ].join('\n'),
        );
      }

      return composeResult({
        headline: `Lab panel analyzed: ${panicAlerts.length} critical alert(s), ${abnormalRows.length} out-of-range finding(s), ${normalRows.length} in-range result(s).`,
        sections,
        sources: [
          {
            name: 'MedlinePlus Laboratory Tests Reference',
            url: 'https://medlineplus.gov/lab-tests/',
          },
          {
            name: 'WHO Dengue Guidelines for Diagnosis, Treatment, Prevention and Control',
            url: 'https://www.who.int/publications/i/item/9789241547871',
          },
        ],
        notices: [
          'Always compare against the testing laboratory’s own age-, sex-, assay-, and pregnancy-specific reference intervals.',
          'Normal laboratory numbers NEVER rule out an acute clinical emergency (such as acute coronary syndrome, stroke, sepsis, or suicidal crisis).',
        ],
        env,
      });
    },
  }),
] as const;
