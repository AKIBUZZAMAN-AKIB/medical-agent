import { isValidProfileId, toProfileId } from '@librechat/data-schemas';
import { resolveProfileName } from './runtime';

/**
 * Properties of profile identity, asserted over generated labels rather than a
 * table of hand-picked names.
 *
 * A profile id is the partition key that separates one person's stored facts
 * from another's, so these are safety properties, not formatting preferences:
 * every label a person can be given must produce a usable key, the same label
 * must always produce the same key, and two different people must never share
 * one. The original implementation derived the key with an ASCII-only slug, so
 * any label written in a non-Latin script collapsed to the empty string, and
 * the empty string is the memory layer's "no partition" — the account holder's
 * own record. The whole class of bugs is covered here without naming a single
 * script or word: the corpus is generated from code point ranges.
 */

/** Deterministic so a failure can be reproduced from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Ranges chosen for coverage of scripts, not for meaning. */
const RANGES: Array<[number, number]> = [
  [0x0061, 0x007a], // Latin lowercase
  [0x0030, 0x0039], // digits
  [0x0985, 0x09b9], // Bengali
  [0x0905, 0x0939], // Devanagari
  [0x0627, 0x064a], // Arabic
  [0x4e00, 0x4e20], // Han
  [0xac00, 0xac20], // Hangul
  [0x0410, 0x044f], // Cyrillic
  [0x0391, 0x03c9], // Greek
  [0x0e01, 0x0e2e], // Thai
  [0x1f600, 0x1f620], // astral plane / emoji
];

function makeCorpus(count: number, seed = 20251026): string[] {
  const random = makeRandom(seed);
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    /** Space-separated words, one separator at a time, so that only the script
     *  folding is under test — not separator collapsing. */
    const wordCount = 1 + Math.floor(random() * 3);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w += 1) {
      const range = RANGES[Math.floor(random() * RANGES.length)];
      const length = 1 + Math.floor(random() * 6);
      let word = '';
      for (let c = 0; c < length; c += 1) {
        const [low, high] = range;
        word += String.fromCodePoint(low + Math.floor(random() * (high - low + 1)));
      }
      words.push(word);
    }
    labels.push(words.join(' '));
  }
  return labels;
}

const CORPUS = makeCorpus(2000);
/** A label is addressable only if it carries a letter or a digit somewhere. */
const nameable = (label: string) => /[\p{L}\p{N}]/u.test(label);

describe('profile id totality', () => {
  it('gives every nameable label a usable key, in any script', () => {
    const unusable: string[] = [];
    for (const label of CORPUS) {
      if (!nameable(label)) {
        continue;
      }
      const id = toProfileId(label);
      if (id === '' || !isValidProfileId(id)) {
        unusable.push(`${JSON.stringify(label)} -> ${JSON.stringify(id)}`);
      }
    }
    expect(unusable).toEqual([]);
  });

  it('never maps a nameable label onto the empty partition', () => {
    /**
     * The empty string is not "no id"; it is the value the memory layer drops,
     * filing the write under the account holder. A regression here silently
     * attributes one person's medical facts to another, so no label that names
     * somebody may reach it.
     */
    expect(CORPUS.filter(nameable).filter((label) => toProfileId(label) === '')).toEqual([]);
  });

  it('still refuses a label that names nobody', () => {
    expect(toProfileId('')).toBe('');
    expect(toProfileId('   ')).toBe('');
    expect(toProfileId('###')).toBe('');
    expect(toProfileId('!!! ??? ...')).toBe('');
    expect(toProfileId('\u{1F600}\u{1F601}')).toBe('');
  });
});

const words = (label: string) => label.split(' ');
const identityWords = (label: string) => words(label).filter(nameable);
/** A label all of whose words carry identity, so nothing may be folded away. */
const fullyNameable = (label: string) => words(label).every(nameable);

describe('profile id discrimination', () => {
  it('never gives two different labels the same key', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const label of CORPUS.filter(fullyNameable)) {
      const id = toProfileId(label);
      const previous = seen.get(id);
      if (previous != null && previous !== label) {
        collisions.push(`${id}: ${JSON.stringify(previous)} vs ${JSON.stringify(label)}`);
      }
      seen.set(id, label);
    }
    expect(collisions).toEqual([]);
  });

  it('folds away only characters that carry no letter or digit', () => {
    /**
     * An ornament is not an identity: two labels that differ only by characters
     * with no letter or digit in them are the same person, and must share a key
     * rather than silently becoming two records. Asserted in both directions so
     * the rule cannot drift into dropping something that does name somebody.
     */
    const ids = CORPUS.map((label) => [toProfileId(label), toProfileId(`${label} \u{1F600}`)]);
    expect(ids.filter(([plain, withEmoji]) => plain !== withEmoji)).toEqual([]);

    const letters = CORPUS.filter(fullyNameable).map((label) => [label, `${label} \u0985`]);
    expect(
      letters.filter(([label, extended]) => toProfileId(label) === toProfileId(extended)),
    ).toEqual([]);
  });

  it('separates labels that differ only by a letter in a non-Latin script', () => {
    const base = makeCorpus(200, 7).filter(nameable);
    const shifted = base.map((label) => `${label} \u0985`);
    const pairs = base.map((label, index) => [toProfileId(label), toProfileId(shifted[index])]);
    expect(pairs.filter(([left, right]) => left === right)).toEqual([]);
  });

  it('keeps a two-script name distinct from an ASCII abbreviation of it', () => {
    /**
     * The original defect in its most dangerous form: "Ahmed" and a Bengali name
     * that happens to contain "Ahmed" both slagged to "ahmed", so one person's
     * facts were filed under the other. Built here from generated words, not
     * from a name list.
     */
    const foreign = makeCorpus(500, 11)
      .filter(fullyNameable)
      .map(identityWords)
      .filter((parts) => parts.some((word) => /[^a-z0-9]/.test(word)));
    const pairs = foreign
      .map((parts) => [parts.join(' '), parts.filter((w) => /^[a-z0-9]+$/.test(w)).join(' ')])
      .filter(([, ascii]) => ascii !== '');
    expect(
      pairs.filter(
        ([mixed, ascii]) => mixed !== ascii && toProfileId(mixed) === toProfileId(ascii),
      ),
    ).toEqual([]);
  });
});

describe('profile id stability', () => {
  it('is idempotent, so a key can be passed back in as a name', () => {
    const unstable = CORPUS.filter(nameable).filter(
      (label) => toProfileId(toProfileId(label)) !== toProfileId(label),
    );
    expect(unstable).toEqual([]);
  });

  it('ignores case, surrounding space and Unicode composition', () => {
    const unstable: string[] = [];
    for (const label of CORPUS) {
      if (!nameable(label)) {
        continue;
      }
      const expected = toProfileId(label);
      /** Upper-casing is only a case change when it round-trips; for some
       *  scripts it is a different string (\u00df -> SS), which is out of scope. */
      const caseInvariant = label.toUpperCase().toLowerCase() === label.toLowerCase();
      const variants = [
        `  ${label}  `,
        label.normalize('NFD'),
        ...(caseInvariant ? [label.toUpperCase()] : []),
      ];
      for (const variant of variants) {
        if (nameable(variant) && toProfileId(variant) !== expected) {
          unstable.push(`${JSON.stringify(label)} vs ${JSON.stringify(variant)}`);
        }
      }
    }
    expect(unstable).toEqual([]);
  });

  it('is a pure function of the label', () => {
    expect(
      CORPUS.filter(nameable).every((label) => toProfileId(label) === toProfileId(label)),
    ).toBe(true);
  });
});

describe('resolveProfileName agreement with the key derivation', () => {
  /** A record named in its own language; nothing about it is vocabulary we hold. */
  const selfName = CORPUS.filter(nameable)[0];

  it('agrees with toProfileId for every nameable label that is not the user themselves', () => {
    const disagreements = CORPUS.filter(nameable)
      .filter((label) => resolveProfileName(label, selfName).isSelf === false)
      .filter((label) => {
        const resolved = resolveProfileName(label, selfName);
        return resolved.profileId !== toProfileId(label);
      });
    expect(disagreements).toEqual([]);
  });

  it('resolves a generated non-self label to a non-empty partition every time', () => {
    const empty = CORPUS.filter(nameable)
      .filter((label) => resolveProfileName(label, selfName).isSelf === false)
      .filter((label) => {
        const resolved = resolveProfileName(label, selfName);
        return resolved.profileId == null || resolved.profileId === '';
      });
    expect(empty).toEqual([]);
  });

  it('routes to the user themselves exactly the labels that denote them', () => {
    /** The rule is structural: blank, the id we publish, or the name on the
     *  record. Any other generated label is somebody else. */
    const misrouted = CORPUS.filter(nameable).filter((label) => {
      const resolved = resolveProfileName(label, selfName);
      const normalized = label.normalize('NFKC').trim().toLowerCase();
      const denotesSelf =
        normalized === 'self' || normalized === selfName.normalize('NFKC').trim().toLowerCase();
      return resolved.isSelf !== denotesSelf;
    });
    expect(misrouted).toEqual([]);
  });

  it('keeps the two people apart when a label is one character away from the user`s name', () => {
    const nearMisses = CORPUS.filter(nameable)
      .map((label) => `${label} \u0985`)
      .filter((label) => label !== selfName);
    expect(nearMisses.filter((label) => resolveProfileName(label, selfName).isSelf)).toEqual([]);
  });
});
