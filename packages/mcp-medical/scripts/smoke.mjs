#!/usr/bin/env node
/**
 * Live smoke test: starts the built server over stdio and calls every tool once
 * against the real upstreams. Run it after a build, after a network change, or
 * when an upstream moves an endpoint.
 *
 *   node packages/mcp-medical/scripts/smoke.mjs            # all tools
 *   node packages/mcp-medical/scripts/smoke.mjs drugs      # one group
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'dist', 'index.js');

/** One representative call per tool: the cheapest query that proves the wiring. */
const CALLS = {
  pubmed_search: {
    group: 'literature',
    args: { query: 'semaglutide type 2 diabetes', max_results: 3 },
  },
  pubmed_article: { group: 'literature', args: { pmids: '31212753' } },
  europe_pmc_search: {
    group: 'literature',
    args: { query: 'semaglutide AND SRC:MED', max_results: 3 },
  },
  read_full_text: { group: 'literature', args: { id: 'PMC11682608', max_section_chars: 800 } },
  literature_citations: {
    group: 'literature',
    args: { pmids: '11832527', dois: '10.1016/S0140-6736(20)30183-5', max_results: 3 },
  },
  drug_lookup: { group: 'drugs', args: { drug: 'warfarin' } },
  drug_label: {
    group: 'drugs',
    args: { drug: 'warfarin', sections: ['indications', 'boxed_warning', 'interactions'] },
  },
  drug_interaction_check: { group: 'drugs', args: { drug_a: 'warfarin', drug_b: 'ibuprofen' } },
  drug_safety_actions: {
    group: 'drugs',
    args: { drug: 'amoxicillin', action: 'recalls', max_results: 2 },
  },
  drug_adverse_event_summary: { group: 'drugs', args: { drug: 'aspirin', top_n: 5 } },
  drug_class_atc: { group: 'drugs', args: { drug: 'metformin' } },
  drug_bioactivity: { group: 'drugs', args: { drug: 'metformin', max_activities: 3 } },
  compound_properties: { group: 'drugs', args: { compound: 'aspirin' } },
  drug_lactation: { group: 'drugs', args: { drug: 'sertraline' } },
  condition_lookup: { group: 'conditions', args: { condition: 'type 2 diabetes mellitus' } },
  condition_targets_and_drugs: {
    group: 'conditions',
    args: { condition: 'atopic asthma', max_targets: 3, max_drugs: 3 },
  },
  gene_lookup: { group: 'conditions', args: { gene: 'BRCA1', max_diseases: 3 } },
  protein_lookup: { group: 'conditions', args: { protein: 'CFTR' } },
  ontology_search: {
    group: 'conditions',
    args: { term: 'seizure', ontology: 'hp', max_results: 3 },
  },
  icd10cm_code: { group: 'conditions', args: { code_prefix: 'E11' } },
  variant_clinical_significance: {
    group: 'conditions',
    args: { gene_or_variant: 'BRCA1', max_results: 2 },
  },
  clinical_trials: { group: 'trials', args: { query: 'semaglutide obesity', max_results: 2 } },
  health_statistics: {
    group: 'epidemiology',
    args: { indicator: 'maternal mortality', search_indicators: true, max_results: 3 },
  },
  device_approval: { group: 'devices', args: { device: 'pacemaker', max_results: 2 } },
  safety_recalls: {
    group: 'devices',
    args: { product: 'infant formula', domain: 'food', max_results: 2 },
  },
  provider_lookup: {
    group: 'clinical',
    args: { specialty: 'Cardiology', state: 'CA', max_results: 2 },
  },
  plain_language_summary: { group: 'clinical', args: { topic: 'Atrial fibrillation' } },
  bd_medicine_lookup: {
    group: 'formulary',
    args: { query: 'Sergel 20', max_alternatives: 5 },
  },
  pharmacogenomics_guideline: {
    group: 'pharmacogenomics',
    args: { drug: 'clopidogrel', gene: 'CYP2C19', max_recommendations: 4 },
  },
  clinical_calculator: {
    group: 'calculators',
    args: {
      calculator: 'ckd_epi_2021',
      inputs: { age: 62, sex: 'male', creatinine_mg_dl: 1.5 },
    },
  },
  lab_result_interpreter: {
    group: 'calculators',
    args: {
      values: { hemoglobin: 15.6, hematocrit: 48, platelets: 72, wbc: 3.2, alt: 96 },
      clinical_context: 'Fever day 4',
    },
  },
  specialist_subagent_blueprint: {
    group: 'orchestration',
    args: {
      specialty: 'Tropical Infectious Diseases & Dengue',
      clinical_focus: 'Day 4 high fever with platelets 72,000 and hematocrit 48%',
    },
  },
};

const only = process.argv[2];

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`server published ${tools.length} tool(s)\n`);

  const published = new Set(tools.map((tool) => tool.name));
  const missing = Object.keys(CALLS).filter((name) => !published.has(name));
  if (missing.length > 0) {
    console.log(`NOT PUBLISHED: ${missing.join(', ')}\n`);
  }

  let failures = 0;
  for (const [name, call] of Object.entries(CALLS)) {
    if (only != null && call.group !== only) {
      continue;
    }
    if (!published.has(name)) {
      continue;
    }
    const started = Date.now();
    try {
      const result = await client.callTool({ name, arguments: call.args });
      const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
      let status = result.isError === true ? 'FAIL' : 'ok';
      if (text.startsWith('No result.')) {
        status = 'EMPTY';
      }
      if (status === 'FAIL') {
        failures += 1;
      }
      const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
      console.log(
        `${status.padEnd(5)} ${name.padEnd(32)} ${String(Date.now() - started).padStart(6)}ms  ${firstLine.slice(0, 110)}`,
      );
      if (status === 'FAIL') {
        console.log(`      ${text.split('\n').slice(0, 4).join('\n      ')}`);
      }
    } catch (error) {
      failures += 1;
      console.log(
        `THROW ${name.padEnd(32)} ${String(Date.now() - started).padStart(6)}ms  ${error.message}`,
      );
    }
  }

  await client.close();
  console.log(failures === 0 ? '\nall tools responded' : `\n${failures} tool(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
