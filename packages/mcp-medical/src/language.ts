/**
 * Reply-language and home-care hints that ride on every tool result.
 *
 * Free models often miss that "kalajor er lokkhon ki" is Bangla written in
 * Latin letters (Banglish) and answer in English, or they invent unsafe home
 * care ("don't give paracetamol" for a child's fever). The server appends a
 * short, deterministic note to each tool result based on the tool's own
 * arguments, so the model sees the right language and the right fever care
 * right next to the evidence it is about to use.
 */

const BANGLA_SCRIPT = /[\u0980-\u09FF]/;

// Common Banglish words. Two or more hits (or one strong hit) = Banglish.
const BANGLISH_WORDS = new Set([
  'ami',
  'amar',
  'amake',
  'halka',
  'kemne',
  'koto',
  'koyta',
  'lagbe',
  'lage',
  'jabe',
  'khete',
  'khawa',
  'khaowa',
  'apni',
  'apnar',
  'tumi',
  'tomar',
  'ki',
  'keno',
  'kivabe',
  'kemon',
  'korbo',
  'korte',
  'korle',
  'kori',
  'koro',
  'koren',
  'hobe',
  'hoy',
  'hoyeche',
  'hocche',
  'hoise',
  'ache',
  'nai',
  'nei',
  'na',
  'din',
  'dhore',
  'theke',
  'jonno',
  'kintu',
  'ekhon',
  'onek',
  'khub',
  'baccha',
  'baccar',
  'bacchar',
  'bachcha',
  'ammu',
  'abbu',
  'amma',
  'abba',
  'bhai',
  'apu',
  'betha',
  'batha',
  'byatha',
  'jor',
  'jwor',
  'jvor',
  'kashi',
  'kasi',
  'shordi',
  'sordi',
  'matha',
  'pet',
  'buke',
  'buk',
  'gaye',
  'gaa',
  'dana',
  'lal',
  'pani',
  'khabo',
  'khabar',
  'osudh',
  'oshudh',
  'ousud',
  'oushodh',
  'lokkhon',
  'lakkhan',
  'rog',
  'rogi',
  'daktar',
  'dactar',
  'hashpatal',
  'haspatal',
  'chikitsa',
  'kalajor',
  'kalazor',
  'jokkha',
  'jokkho',
  'khos',
  'pachra',
  'bomi',
  'patla',
  'paikhana',
  'ghamche',
  'ghum',
  'prochondo',
  'beshi',
  'kom',
  'sap',
  'shap',
  'kamor',
  'kamrse',
  'kamriyeche',
  'dorkar',
  'parbo',
  'jabo',
  'jete',
  'shorir',
  'sorir',
  'durbol',
  'rokto',
  'chap',
  'daibetis',
  'suger',
  'gola',
  'chokh',
  'kan',
  'nak',
  'dat',
  'haat',
  'pa',
  'komor',
  'mukh',
  'jibon',
]);
const STRONG_BANGLISH = new Set([
  'lokkhon',
  'kalajor',
  'kalazor',
  'jokkha',
  'ghamche',
  'prochondo',
  'baccar',
  'bacchar',
  'korbo',
  'hoyeche',
  'oshudh',
  'osudh',
  'betha',
  'byatha',
  'khos',
  'pachra',
  'kamriyeche',
]);

export type ReplyLanguage = 'bn' | 'en';

export function detectReplyLanguage(text: string): ReplyLanguage | null {
  if (!text || !text.trim()) return null;
  if (BANGLA_SCRIPT.test(text)) return 'bn';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return null;
  let hits = 0;
  for (const w of words) {
    if (STRONG_BANGLISH.has(w)) return 'bn';
    if (BANGLISH_WORDS.has(w)) hits++;
  }
  if (
    hits >= 2 ||
    (words.length <= 3 && hits >= 1 && words.some((w) => w.length > 3 && BANGLISH_WORDS.has(w)))
  ) {
    return 'bn';
  }
  return null;
}

const FEVER =
  /(\bjor\b|\bjwor\b|\bjvor\b|জ্বর|জর|fever|febrile|pyrexia|dengue|ডেঙ্গু|ডেংগু|typhoid|টাইফয়েড|chikungunya|চিকুনগুনিয়া|measles|হাম|\bham\b|malaria|ম্যালেরিয়া)/i;
const CHILD =
  /(child|children|kid|infant|baby|toddler|paediatric|pediatric|শিশু|বাচ্চা|বাবু|ছেলে|মেয়ে|baccha|baccar|bacchar|bachcha|babu|sishu|shishu|\b\d{1,2}\s*(month|mas|বছর|মাস|years?|bochor|yr)s?\b)/i;

export function collectArgText(args: unknown, depth = 0): string {
  if (depth > 3 || args == null) return '';
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) return args.map((a) => collectArgText(a, depth + 1)).join(' ');
  if (typeof args === 'object') {
    return Object.entries(args as Record<string, unknown>)
      .filter(([k]) => !/^(base64|data|file|image|content_b64)$/i.test(k))
      .map(([, v]) => collectArgText(v, depth + 1))
      .join(' ');
  }
  return '';
}

/** Notes appended to a tool result, based on the tool's arguments. */
export function resultHints(args: unknown): string[] {
  const text = collectArgText(args).slice(0, 4000);
  const hints: string[] = [];
  const lang = detectReplyLanguage(text);
  if (lang === 'bn') {
    hints.push(
      'REPLY LANGUAGE: The user writes Bangla or Banglish (Bangla in Latin letters). Write the whole answer in clear, natural Bangla script (standard Bangladeshi Bangla), with drug and test names in English in brackets where useful, e.g. প্যারাসিটামল (Paracetamol). Write every number (doses, lab values, phone numbers) with English digits, e.g. 500 mg, 16263.',
    );
  }
  if (FEVER.test(text)) {
    hints.push(
      'FEVER HOME CARE. Quoted sources (the only two this note is based on; cite them only for what these quotes say): ' +
        'WHO, "Dengue and severe dengue" fact sheet (https://www.who.int/news-room/fact-sheets/detail/dengue-and-severe-dengue): "pain can be managed with medication such as paracetamol (acetaminophen). Non-steroidal anti-inflammatory medicines such as ibuprofen and aspirin should be avoided as they can increase the risk of bleeding." ' +
        'NHS, "High temperature (fever) in children" (https://www.nhs.uk/conditions/fever-in-children/): "give them plenty of fluids"; "do not give aspirin to children under 16 years of age"; "do not undress your child or sponge them down to cool them". ' +
        "Rules: paracetamol IS the right medicine for fever and pain, including in children and in suspected dengue; dose by weight from the pack or a pharmacist. Never tell the user not to give paracetamol. While dengue is possible (any fever in Bangladesh in season), avoid ibuprofen, aspirin, diclofenac and other NSAIDs. Never aspirin under 16. Fluids (ORS, water, soup), rest, light clothing; do not sponge to cool. The danger signs and rules beyond these quotes are this app's own guidance, not a quote: do not attribute them to WHO or NHS." +
        (CHILD.test(text)
          ? ' CHILD: danger signs are a baby under 3 months with fever, drowsiness or hard to wake, not drinking or no urine for 8 hours, repeated vomiting, fast or difficult breathing, fits, a rash that does not fade when pressed, bleeding, cold hands and feet.'
          : ''),
    );
  }
  return hints;
}
