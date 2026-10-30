import { bulletList, composeResult, definitionList, excerpt, stringifyValue } from '../format.js';
import { allTools, describeToolGroups, selectTools } from '../tools/index.js';
import { createMedicalServer } from '../server.js';
import { loadEnv } from '../env.js';

const env = loadEnv({});

describe('formatting', () => {
  it('drops empty upstream values instead of rendering them as data', () => {
    expect(
      definitionList([
        ['Brand', undefined],
        ['Class', 'Ib'],
        ['Missing', ''],
        ['Nulled', null],
        ['Count', 0],
      ]),
    ).toBe('Class: Ib\nCount: 0');
  });

  it('renders a bullet list without empty rows', () => {
    expect(bulletList(['first', '', undefined, 'second'])).toBe('- first\n- second');
    expect(bulletList([])).toBe('');
  });

  it('flattens multi-line upstream text into one row', () => {
    expect(bulletList(['a\nb'])).toBe('- a b');
  });

  it('truncates an excerpt with an ellipsis and tolerates objects', () => {
    expect(excerpt('x'.repeat(10), 4)).toBe('xxx…');
    expect(excerpt({ a: 1 })).toBe('{"a":1}');
    expect(stringifyValue(null)).toBe('');
  });

  it('always marks a result that had to be cut, so it cannot read as complete', () => {
    const result = composeResult({
      headline: 'A long answer',
      sections: ['x'.repeat(50_000)],
      sources: [{ name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' }],
      env: { ...env, maxResultChars: 1_000 },
    });
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain('[truncated');
    expect(result.text).toContain('https://pubmed.ncbi.nlm.nih.gov/1/');
  });

  it('keeps caveats and citations in the composed result', () => {
    const result = composeResult({
      headline: 'Label for warfarin.',
      notices: ['Label text is regulatory text, not advice.'],
      sources: [{ name: 'openFDA', url: 'https://api.fda.gov/drug/label.json' }],
      env,
    });
    expect(result.text).toContain('Caveats:');
    expect(result.text).toContain('Sources:');
  });
});

describe('tool catalogue', () => {
  it('exposes every tool under a known group with a distinct name', () => {
    const names = allTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of allTools) {
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });

  it('covers the domains the agent promises in its instructions', () => {
    const groups = describeToolGroups();
    for (const group of [
      'literature',
      'drugs',
      'conditions',
      'trials',
      'epidemiology',
      'devices',
      'clinical',
    ]) {
      expect(groups).toContain(`${group}:`);
    }
  });

  it('narrows the catalogue to the groups an operator selected', () => {
    const narrowed = selectTools(loadEnv({ MEDICAL_TOOL_GROUPS: 'literature,drugs' }));
    expect(narrowed.length).toBeGreaterThan(0);
    // Every selected tool is in a requested group; no tool is forced in.
    expect(narrowed.every((tool) => ['literature', 'drugs'].includes(tool.group))).toBe(true);
  });

  it('excludes individual tools without disturbing the rest', () => {
    const pruned = selectTools(loadEnv({ MEDICAL_TOOL_EXCLUDE: 'plain_language_summary' }));
    expect(pruned.map((tool) => tool.name)).not.toContain('plain_language_summary');
    expect(pruned.length).toBe(allTools.length - 1);
  });
});

describe('createMedicalServer', () => {
  it('builds with every tool when nothing is configured', () => {
    const { tools } = createMedicalServer(loadEnv({}));
    expect(tools).toHaveLength(allTools.length);
  });

  it('builds with a narrowed catalogue without touching the rest of the config', () => {
    const { tools } = createMedicalServer(loadEnv({ MEDICAL_TOOL_GROUPS: 'trials' }));
    expect(tools.map((tool) => tool.name)).toEqual(['clinical_trials']);
  });
});
