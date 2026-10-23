import { parseFullTextMetadata, parseFullTextSections, parseFullTextTables } from '../jats-xml.js';
import { parsePubmedArticles, parsePubmedBookArticles, decodeEntities } from '../pubmed-xml.js';
import { extractSplSections, findSplSection, normalizeSectionName } from '../spl-xml.js';

const PUBMED_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE" Owner="NLM">
      <PMID Version="1">31212753</PMID>
      <Article PubModel="Print-Electronic">
        <Journal>
          <Title>Materials (Basel)</Title>
          <JournalIssue CitedMedium="Internet">
            <Volume>12</Volume>
            <PubDate><Year>2019</Year><Month>Jun</Month><Day>12</Day></PubDate>
          </JournalIssue>
        </Journal>
        <ArticleTitle>PSO-BP neural network-based strain prediction.</ArticleTitle>
        <Pagination><MedlinePgn>1889</MedlinePgn></Pagination>
        <ELocationID EIdType="doi" ValidYN="Y">10.3390/ma12121889</ELocationID>
        <Abstract>
          <AbstractText Label="BACKGROUND">Wind turbine blades fail in service.</AbstractText>
          <AbstractText Label="RESULTS">We predict strain with 92% &amp; accuracy.</AbstractText>
        </Abstract>
        <AuthorList CompleteYN="Y">
          <Author ValidYN="Y"><LastName>Liu</LastName><ForeName>X</ForeName><Initials>X</Initials></Author>
          <Author ValidYN="Y"><CollectiveName>Rite Aid Corporation</CollectiveName></Author>
        </AuthorList>
        <PublicationTypeList>
          <PublicationType UI="D016428">Journal Article</PublicationType>
        </PublicationTypeList>
      </Article>
      <MeshHeadingList>
        <MeshHeading><DescriptorName UI="D000818" MajorTopicYN="N">Animals</DescriptorName></MeshHeading>
        <MeshHeading><DescriptorName UI="D000001" MajorTopicYN="N">Animals</DescriptorName></MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">31212753</ArticleId>
        <ArticleId IdType="pmc">PMC6611961</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

describe('parsePubmedArticles', () => {
  const [article] = parsePubmedArticles(PUBMED_XML);

  it('extracts the citation identity fields', () => {
    expect(article?.pmid).toBe('31212753');
    expect(article?.title).toContain('strain prediction');
    expect(article?.journal).toBe('Materials (Basel)');
    expect(article?.year).toBe('2019');
    expect(article?.doi).toBe('10.3390/ma12121889');
    expect(article?.pmcid).toBe('PMC6611961');
    expect(article?.publicationTypes).toEqual(['Journal Article']);
  });

  it('keeps structured abstract sections with their labels', () => {
    expect(article?.abstractSections).toEqual([
      { label: 'BACKGROUND', text: 'Wind turbine blades fail in service.' },
      { label: 'RESULTS', text: 'We predict strain with 92% & accuracy.' },
    ]);
  });

  it('handles personal and collective authors', () => {
    expect(article?.authors).toEqual(['Liu X', 'Rite Aid Corporation']);
  });

  it('de-duplicates repeated MeSH descriptors', () => {
    expect(article?.meshTerms).toEqual(['Animals']);
  });

  it('returns nothing for a payload with no articles rather than throwing', () => {
    expect(parsePubmedArticles('<PubmedArticleSet></PubmedArticleSet>')).toEqual([]);
    expect(parsePubmedArticles('')).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &#160; c &#x2019;d &unknown;')).toBe(
      'a & b \u00a0 c ’d &unknown;',
    );
  });
});

const SPL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3">
  <setId root="d49f3e4f"/>
  <component>
    <section ID="LINK_1">
      <code code="34066-2" displayName="BOXED WARNING SECTION"/>
      <text><paragraph>Aspirin can cause severe allergic reactions.</paragraph></text>
      <component>
        <section>
          <code code="34067-9" displayName="INDICATIONS &amp; USAGE SECTION"/>
          <text><paragraph>Relieves mild pain.</paragraph></text>
        </section>
      </component>
    </section>
    <section ID="LINK_2">
      <code code="34068-7" displayName="ADVERSE REACTIONS SECTION"/>
      <text><paragraph>Nausea, dizziness.</paragraph></text>
    </section>
  </component>
</document>`;

describe('extractSplSections', () => {
  const sections = extractSplSections(SPL_XML);

  it('returns only top-level sections, in document order', () => {
    expect(sections.map((section) => section.code)).toEqual(['34066-2', '34068-7']);
  });

  it('reads the section name from the coded display name and decodes entities', () => {
    expect(sections[0]?.name).toBe('BOXED WARNING SECTION');
  });

  it('keeps the section body as plain text', () => {
    expect(sections[1]?.text).toBe('Nausea, dizziness.');
  });

  it('finds a section by a looser name than the label publishes', () => {
    expect(findSplSection(sections, 'ADVERSE REACTIONS')?.code).toBe('34068-7');
    expect(findSplSection(sections, 'CONTRAINDICATIONS')).toBeUndefined();
  });

  it('normalizes punctuation so &amp; and _ match the same term', () => {
    expect(normalizeSectionName('INDICATIONS & USAGE SECTION')).toBe(
      'INDICATIONS AND USAGE SECTION',
    );
  });
});

describe('parseFullTextSections', () => {
  const JATS = `<?xml version="1.0"?>
  <article>
    <front>
      <journal-meta><journal-title-group><journal-title>Lancet</journal-title></journal-title-group></journal-meta>
      <article-meta>
        <article-id pub-id-type="pmid">31212753</article-id>
        <article-id pub-id-type="pmc">PMC1234567</article-id>
        <article-id pub-id-type="doi">10.1016/S0140-6736(20)30183-5</article-id>
        <title-group><article-title>Efficacy of a single dose of a vaccine.</article-title></title-group>
        <contrib-group><contrib contrib-type="author"><name><surname>Novak</surname><given-names>J</given-names></name></contrib></contrib-group>
        <pub-date pub-type="epub"><year>2020</year></pub-date>
        <permissions><license-p>This is an open access article distributed under CC BY 4.0.</license-p></permissions>
      </article-meta>
    </front>
    <body>
      <sec><title>Methods</title>
        <p>We randomised 1320 adults aged 18-70 across 14 sites.</p>
        <sec><title>Outcomes</title><p>The primary outcome was symptomatic disease at 28 days.</p></sec>
      </sec>
      <sec><title>Results</title><p>Vaccine efficacy was 94.5% (95% CI 87.0-98.0).</p></sec>
      <sec><title>Discussion</title><p>Efficacy waned by month 6.</p></sec>
    </body>
  </article>`;

  it('reads each body section without repeating a nested subsection in its parent', () => {
    const sections = parseFullTextSections(JATS);
    const methods = sections.find((section) => section.title === 'Methods');
    expect(methods?.text).toContain('1320 adults');
    expect(methods?.text).not.toContain('primary outcome');
    expect(sections.map((section) => section.title)).toContain('Results');
  });

  it('keeps the confidence interval intact through entity decoding', () => {
    const results = parseFullTextSections(JATS).find((section) => section.title === 'Results');
    expect(results?.text).toBe('Vaccine efficacy was 94.5% (95% CI 87.0-98.0).');
  });

  it('reads the identifiers and licence a citation needs', () => {
    const metadata = parseFullTextMetadata(JATS);
    expect(metadata.pmid).toBe('31212753');
    expect(metadata.pmcid).toBe('PMC1234567');
    expect(metadata.doi).toBe('10.1016/S0140-6736(20)30183-5');
    expect(metadata.journal).toBe('Lancet');
    expect(metadata.year).toBe('2020');
    expect(metadata.licence).toContain('CC BY 4.0');
    expect(metadata.authors).toContain('Novak');
  });

  it('flattens a table into labelled text with the numbers in it', () => {
    const withTable = JATS.replace(
      '</body>',
      `<table-wrap><label>Table 2</label><caption>Adverse events</caption>
        <table><tr><th>Group</th><th>n</th><th>Events</th></tr>
        <tr><td>Placebo</td><td>660</td><td>19</td></tr></table></table-wrap></body>`,
    );
    const tables = parseFullTextTables(withTable);
    expect(tables[0]?.title).toBe('Table 2');
    expect(tables[0]?.text).toContain('Placebo');
    expect(tables[0]?.text).toContain('660');
  });

  it('returns nothing rather than throwing on a document with no body', () => {
    expect(parseFullTextSections('<article><front/></article>')).toEqual([]);
  });
});

describe('parsePubmedBookArticles', () => {
  const LACTMED_XML = `<?xml version="1.0"?>
  <PubmedArticleSet>
    <PubmedBookArticle>
      <BookDocument>
        <PMID Version="1">30000250</PMID>
        <ArticleIdList><ArticleId IdType="bookaccession">NBK501191</ArticleId></ArticleIdList>
        <Book><BookTitle book="lactmed">Drugs and Lactation Database (LactMed&#xae;)</BookTitle></Book>
        <ArticleTitle book="lactmed" part="LM328">Sertraline</ArticleTitle>
        <Abstract><AbstractText>Low levels of sertraline appear in breastmilk.</AbstractText></Abstract>
        <ContributionDate><Year>2026</Year><Month>8</Month><Day>15</Day></ContributionDate>
      </BookDocument>
    </PubmedBookArticle>
  </PubmedArticleSet>`;

  it('extracts the Bookshelf accession, title, year, and lactation summary', () => {
    const [book] = parsePubmedBookArticles(LACTMED_XML);
    expect(book?.pmid).toBe('30000250');
    expect(book?.bookId).toBe('NBK501191');
    expect(book?.title).toBe('Sertraline');
    expect(book?.year).toBe('2026');
    expect(book?.abstractText).toContain('Low levels of sertraline');
  });
});
