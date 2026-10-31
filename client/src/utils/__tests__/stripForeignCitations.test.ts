import { unicodeCitation } from '~/components/Web/plugin';
import { stripForeignCitations } from '../citations';

type TestNode = {
  type: string;
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: TestNode[];
};

function render(text: string): TestNode[] {
  const tree: TestNode = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  };
  unicodeCitation()(tree as never);
  return tree.children?.[0].children ?? [];
}

function visibleText(nodes: TestNode[]): string {
  return nodes
    .filter((node) => node.type === 'text')
    .map((node) => node.value ?? '')
    .join('');
}

describe('stripForeignCitations', () => {
  it('removes an anchor that names another tool (actual character)', () => {
    expect(stripForeignCitations('ডেঙ্গুর লক্ষণ জ্বর \ue202turn0disease_knowledge_search0।')).toBe(
      'ডেঙ্গুর লক্ষণ জ্বর।',
    );
  });

  it('removes an anchor that names another tool (literal escape)', () => {
    expect(stripForeignCitations('High fever \\ue202turn0disease_knowledge_search0.')).toBe(
      'High fever.',
    );
  });

  it('removes a bare anchor without the marker character', () => {
    expect(stripForeignCitations('High fever turn0disease_knowledge_search0 and rash')).toBe(
      'High fever and rash',
    );
    expect(stripForeignCitations('Source: turn1search2.')).toBe('Source:.');
  });

  it('drops the brackets left around a removed anchor', () => {
    expect(stripForeignCitations('fever [turn0disease_knowledge_search0], rash')).toBe(
      'fever, rash',
    );
    expect(stripForeignCitations('fever (\ue202turn2drug_label1).')).toBe('fever.');
  });

  it('keeps valid web-search anchors for the citation renderer', () => {
    const text = 'WHO says so \ue202turn0search0 and \\ue202turn1news2.';
    expect(stripForeignCitations(text)).toBe(text);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Take a turn to the left; turnover was 20% in turn2020 records [D0051].';
    expect(stripForeignCitations(text)).toBe(text);
    expect(stripForeignCitations('return0x1 value')).toBe('return0x1 value');
  });
});

describe('unicodeCitation plugin', () => {
  it('never shows a foreign anchor as raw text', () => {
    const nodes = render('ডেঙ্গুতে উচ্চ জ্বর হয় \ue202turn0disease_knowledge_search0 [D1187]।');
    const text = visibleText(nodes);
    expect(text).not.toContain('turn0');
    expect(text).not.toContain('disease_knowledge_search');
    expect(text).toContain('[D1187]');
  });

  it('still renders a valid web-search citation', () => {
    const nodes = render('Dengue is spread by Aedes mosquitoes \ue202turn0search0.');
    const citation = nodes.find((node) => node.type === 'citation');
    expect(citation).toBeDefined();
    expect(citation?.data?.hProperties).toMatchObject({
      citation: { turn: 0, refType: 'search', index: 0 },
    });
    expect(visibleText(nodes)).not.toContain('turn0');
  });

  it('keeps the valid citation and drops the foreign one in the same sentence', () => {
    const nodes = render(
      'Fever and rash \ue202turn0search1 \ue202turn0disease_knowledge_search0 are common.',
    );
    expect(nodes.filter((node) => node.type === 'citation')).toHaveLength(1);
    expect(visibleText(nodes)).not.toContain('disease_knowledge_search');
  });
});
