/**
 * Operator knowledge base: deterministic red-flag classifier for Bangladesh.
 *
 * `emergency.ts` deliberately ships no clinical rules and returns `unknown` when
 * no classifier is wired in. This file is the operator-supplied classifier and
 * policy that the triage tool now uses by default. It recognises a fixed set of
 * red-flag patterns in English, Bangla script (বাংলা) and romanised Bangla
 * (Banglish), and maps them to emergency / urgent / routine with guidance that
 * names 999 (Bangladesh national emergency service).
 *
 * Sources the concepts follow (see the deployment notes for links):
 *  - NHS "When to call 999" (chest pain, stroke FAST, struggling to breathe,
 *    unconsciousness, seizures, severe bleeding, anaphylaxis, sudden confusion,
 *    suicidal intent, serious injury, severe burns).
 *  - WHO IMCI general danger signs for children (not able to drink or
 *    breastfeed, vomits everything, convulsions, lethargic/unconscious) and
 *    NICE NG143 (any fever in an infant under 3 months is high risk).
 *  - WHO pregnancy danger signs (vaginal bleeding, severe headache / blurred
 *    vision, convulsions, severe abdominal pain, reduced fetal movement, fever).
 *  - WHO dengue warning signs; WHO snakebite first aid; rabies post-exposure.
 *
 * LIMITS (also returned with every result): this is a pattern list, not a
 * clinician. It has not been reviewed by a licensed clinician. Phrasings it does
 * not contain are not recognised; a routine result means only that none of these
 * patterns matched. Negation handling is simple ("no chest pain", "বুকে ব্যথা
 * নেই"). Time framing ("three years ago") is NOT handled, so past events can
 * over-triage — the safer direction.
 */
import { type Classifier, type Evidence, type Policy, type PolicyRule, type Rule, Severity } from './triage.js';

export const RED_FLAG_KB_VERSION = 'bd-redflags-2026.10';

type Lang = 'en' | 'bn' | 'rom';

interface Concept {
  code: string;
  /** Severity this finding carries on its own. */
  severity: Severity;
  label: string;
  en?: string[];
  bn?: string[];
  rom?: string[];
  /** Patterns that already contain a negative ("can't breathe", "জ্ঞান নেই"). */
  noNegation?: boolean;
}

// Bangla script has no \b in JS regex, so Bangla patterns are unanchored.
// Every Bangla source is NFC-normalised before compiling, like the input.
const W = '(?:[^\\s।,.!?]+\\s*)'; // one Bangla word (+ trailing space)
const PAIN_BN = '(?:ব্য[াে]?থা|বেথা)';
const PAIN_ROM = '(?:betha|batha|bytha|byatha|bhetha|vetha|betah)';

const CONCEPTS: Concept[] = [
  // ---------------- emergency on their own ----------------
  {
    code: 'chest_pain',
    severity: Severity.emergency,
    label: 'chest pain or pressure',
    en: [
      '\\b(chest|heart)\\s*(pain|ache|pressure|tightness|tight|squeez\\w*|discomfort|hurts?|heaviness|heavy)',
      '\\bpain\\s+(in|on|around)\\s+(my|the|his|her)?\\s*(chest|heart)\\b',
      '\\bheart\\s*attack\\b',
    ],
    bn: [`বুক(?:ে|ের)?\\s*${W}{0,3}(?:${PAIN_BN}|চাপ|ভার|চিনচিন|কামড়)`, 'হার্ট\\s*(?:অ্যাটাক|এটাক|অ্যাটাক)'],
    rom: [`\\bbuk(?:e|er)?\\s+(?:\\w+\\s+){0,3}(?:${PAIN_ROM}|chap|vari|bhari|pain|chinchin)\\b`],
  },
  {
    code: 'stroke_signs',
    severity: Severity.emergency,
    label: 'stroke signs (FAST: face, arm, speech)',
    en: [
      '\\b(face|mouth|lip)\\s+(is\\s+|has\\s+)?(droop\\w*|twisted|lopsided|fallen)',
      '\\b(one|left|right)[- ]sided?\\s+(weakness|numbness|paralysis)',
      "\\b(weak|weakness|numb|numbness|paralys\\w*|can'?t move|cannot move)\\b[^.]{0,30}\\b(one side|left side|right side|left arm|right arm|left leg|right leg|half (of )?(my|his|her|the) body)",
      "\\b(slurred speech|speech is slurred|slurring|can'?t speak (properly|clearly)|trouble speaking|words are jumbled)\\b",
      '\\b(having a stroke|is a stroke|might be a stroke|stroke symptoms|signs of (a )?stroke)\\b',
    ],
    bn: [
      'মুখ\\s*(?:এক\\s*(?:দিকে|পাশে)\\s*)?(?:বেঁকে|বেকে|বাঁকা|বাকা|ব্যাকা|ঝুলে)',
      `(?:এক|ডান|বাম|বাঁ)\\s*(?:পাশ|দিক|সাইড)\\S*\\s*${W}{0,2}(?:অবশ|দুর্বল|প্যারালাইজড|অচল|নাড়াতে\\s*পারছ)`,
      `হাত\\s*[-]?\\s*পা\\s*${W}{0,2}(?:অবশ|অচল)`,
      `কথা\\s*${W}{0,1}(?:জড়িয়ে|জড়ানো|জড়াচ্ছে|আটকে\\s*যাচ্ছে|অস্পষ্ট)`,
      'স্ট্রোক\\s*(?:করেছে|করছে|হয়েছে|হচ্ছে|করেছেন)',
    ],
    rom: [
      '\\bmukh\\s+(?:\\w+\\s+){0,2}(?:beke|baka|bake|byaka|beka|bika)\\b',
      '\\b(?:ek|dan|bam)\\s*(?:pash|pashe|dik|dike|side)\\w*\\s+(?:\\w+\\s+){0,2}(?:obosh|abosh|obosh|durbol|paralyz\\w*)\\b',
      '\\bhat\\s*-?\\s*pa\\s+(?:\\w+\\s+){0,2}(?:obosh|abosh)\\b',
      '\\bkotha\\s+(?:\\w+\\s+){0,1}(?:joraye|jorie|joriye|jorai|jorano|atke|aspashto|ospost)\\w*',
      '\\bstroke\\s+(?:korse|korche|koreche|hoise|hoyeche|hocche|korsen)\\b',
    ],
  },
  {
    code: 'breathing_severe',
    severity: Severity.emergency,
    label: 'cannot breathe / choking / blue lips',
    noNegation: true,
    en: [
      "\\b(can'?t|cannot|can not|unable to|struggling to|fighting to)\\s+breathe?\\b",
      '\\b(choking|gasping( for air)?|not breathing|stopped breathing|blue lips|lips (are |turning )?blue|turning blue)\\b',
    ],
    bn: [
      '(?:শ্বাস|শ্বাষ|স্বাস|শাস|নিঃশ্বাস|নিশ্বাস)\\s*(?:নিতে|ফেলতে)?\\s*পারছ(?:ি|ে|েন|িনা)?\\s*না',
      '(?:শ্বাস|নিঃশ্বাস|দম)\\s*(?:বন্ধ|আটকে)',
      'দম\\s*নিতে\\s*পারছ\\S*\\s*না',
      `ঠোঁট\\s*${W}{0,1}নীল`,
      'শ্বাস\\s*নিচ্ছে\\s*না',
      'গলায়\\s*(?:কিছু\\s*)?আটকে',
    ],
    rom: [
      '\\b(?:shash|shas|sas|swash|swas|nishash|nisshash|nisshas|nishas|dom)\\s+(?:\\w+\\s+){0,2}(?:parchi|parche|parteci|partesi|partese|parsi|parse|parcen|parchen|partechi)\\s*na\\b',
      '\\b(?:shash|shas|sas|swas|dom)\\s+(?:bondho|bondo|atke)\\w*',
      '\\bthot\\s+(?:\\w+\\s+)?nil\\b',
    ],
  },
  {
    code: 'unconscious',
    severity: Severity.emergency,
    label: 'unconscious / unresponsive / collapsed',
    noNegation: true,
    en: [
      "\\b(unconscious|unresponsive|passed out|fainted|collapsed|won'?t wake( up)?|not waking( up)?|can'?t wake (him|her|them)|not responding|blacked out|knocked out)\\b",
    ],
    bn: [
      'অজ্ঞান',
      'জ্ঞান\\s*(?:নেই|নাই|হারিয়ে|হারাচ্ছে|ফিরছে\\s*না|হারায়)',
      'সাড়া\\s*(?:দিচ্ছে|দিচ্ছেন|দেয়)\\s*না',
      'ঘুম\\s*থেকে\\s*(?:উঠছে|উঠছেন|জাগছে)\\s*না',
      'সেন্সলেস|অচেতন|বেহুঁশ|বেহুশ|মূর্ছা|ঢলে\\s*পড়',
    ],
    rom: [
      '\\b(?:ogyan|agyan|oggan|ojgan|ozzan|ozgyan|ojnan|ogganh)\\b',
      '\\b(?:gyan|jnan|gan|sens|sense|hush|hosh)\\s+(?:nai|nei|harai\\w*|harie\\w*|haray\\w*|firche\\s+na)\\b',
      '\\bsara\\s+(?:dicche|dichhe|dise|dey|dicchena)\\s*(?:na)?\\b',
      '\\b(?:senseless|behush|behuš)\\b',
    ],
  },
  {
    code: 'seizure',
    severity: Severity.emergency,
    label: 'seizure / convulsion',
    en: ['\\b(seizures?|seizing|convuls\\w*|fitting|having a fit|epileptic fit)\\b'],
    bn: ['খিঁচুনি|খিচুনি|খিঁচুনী|খিচুনী|খিঁচ\\s*(?:দিচ্ছে|উঠছে|ধরেছে)'],
    rom: ['\\b(?:khichuni|khichuny|khinchuni|khichunii|khichhuni)\\b', '\\bkhich\\s+(?:uthche|dicche|dhorse)\\b'],
  },
  {
    code: 'severe_bleeding',
    severity: Severity.emergency,
    label: 'heavy bleeding that will not stop',
    noNegation: true,
    en: [
      "\\b(bleeding (heavily|a lot|badly|profusely|non[- ]?stop|that won'?t stop|won'?t stop|will not stop)|heavy bleeding|severe bleeding|lots of blood|losing (a lot of )?blood|can'?t stop (the )?bleeding|spurting blood|blood (is )?(spurting|pouring|gushing))\\b",
    ],
    bn: [
      'রক্ত\\s*(?:পড়া|পড়ছে|ঝরছে|যাচ্ছে)?\\s*(?:বন্ধ\\s*হচ্ছে\\s*না|থামছে\\s*না|বন্ধ\\s*হয়\\s*না)',
      '(?:অনেক|প্রচুর|খুব|প্রচণ্ড)\\s*রক্ত|গলগল\\s*করে\\s*রক্ত',
    ],
    rom: [
      '\\brokto\\s+(?:\\w+\\s+){0,2}(?:bondho|bondo|thamche|thamse)\\s*(?:hocche|hoche|hoy|hoitese|hochhe)?\\s*na\\b',
      '\\b(?:onek|procur|prochur|khub|procondo)\\s+rokto\\b',
    ],
  },
  {
    code: 'blood_vomit_cough',
    severity: Severity.emergency,
    label: 'vomiting or coughing up blood',
    en: [
      '\\b(vomit\\w*|throw\\w* up|threw up|cough\\w*( up)?)\\s+(\\w+\\s+)?blood\\b',
      '\\bblood\\s+in\\s+(my |his |her |the )?(vomit|sputum|phlegm)\\b',
    ],
    bn: ['রক্ত\\s*বমি|রক্তবমি|বমির?\\s*সাথে\\s*রক্ত|কাশির?\\s*সাথে\\s*রক্ত|কাশিতে\\s*রক্ত|বমিতে\\s*রক্ত'],
    rom: ['\\brokto\\s*bomi\\b', '\\b(?:bomi|kashi)r?\\s+(?:sathe|shathe|songe|te)\\s+rokto\\b'],
  },
  {
    code: 'anaphylaxis',
    severity: Severity.emergency,
    label: 'severe allergic reaction (swelling of face, lips, tongue or throat)',
    en: [
      '\\banaphyla\\w*',
      '\\b(throat|tongue|lips?|face|mouth|eyes and face)\\s+(is\\s+|are\\s+|has\\s+|have\\s+)?(swell\\w*|swollen|puff\\w*|closing)',
      '\\bswell\\w*\\s+(of|in|on)\\s+(the |my |his |her )?(throat|tongue|lips?|face)\\b',
      '\\bthroat\\s+(is\\s+)?(closing|tight)',
    ],
    bn: [`(?:গলা|জিভ|জিহ্বা|ঠোঁট|মুখ|চোখ\\s*মুখ)\\s*${W}{0,1}(?:ফুলে|ফোলা|ফুলছে)`, 'অ্যানাফাইল্যাক্সিস|এনাফাইল্যাক্সিস'],
    rom: ['\\b(?:gola|jib|jibh|thot|mukh|chokh\\s*mukh)\\s+(?:\\w+\\s+){0,1}(?:fule|phule|fula|fola|fulse|fulche)\\b'],
  },
  {
    code: 'suicidal',
    severity: Severity.emergency,
    label: 'suicidal thoughts or self-harm',
    en: [
      "\\b(suicid\\w*|kill (my|him|her)self|end (my|his|her) (own )?life|take (my|his|her) (own )?life|want to die|wanna die|don'?t want to (live|be alive)|better off dead|self[- ]harm\\w*|hurt(ing)? myself|cut(ting)? myself|no reason to live)\\b",
    ],
    bn: [
      'আত্মহত্যা|আত্মহনন|সুইসাইড',
      'মরে\\s*যেতে\\s*(?:চাই|ইচ্ছা|ইচ্ছে)|মরতে\\s*চাই',
      '(?:বাঁচতে|বাচতে)\\s*চাই\\s*না|বেঁচে\\s*থাকতে\\s*(?:ইচ্ছা|ইচ্ছে)\\s*(?:করে|করছে)\\s*না',
      'নিজেকে\\s*(?:শেষ|মেরে|আঘাত|কেটে)',
      'জীবন\\s*শেষ\\s*করে|গলায়\\s*দড়ি|ফাঁস\\s*(?:দেব|দিব|দিতে|নেব|নিব)',
    ],
    rom: [
      '\\b(?:attohotta|atmohotta|atthohotta|attohatya|atmahatya|attohotta|suicide|sucide|suicid)\\w*',
      '\\bmore\\s+jete\\s+(?:chai|icche|iccha)\\b|\\bmorte\\s+chai\\b',
      '\\bbachte\\s+chai\\s+na\\b|\\bbeche\\s+thakte\\s+(?:icche|ichha|iccha)\\s+kore\\s+na\\b',
      '\\bnijeke\\s+(?:shesh|sesh|mere|kete)\\b|\\bgolay\\s+dori\\b|\\bfash\\s+(?:dibo|debo|dite|nibo)\\b',
    ],
  },
  {
    code: 'poisoning',
    severity: Severity.emergency,
    label: 'poisoning or overdose',
    en: [
      '\\b(poisoned|poisoning|overdos\\w*|took too many (pills|tablets)|took a lot of (pills|tablets))\\b',
      '\\b(drank|drunk|ate|swallowed|ingested|took)\\s+(\\w+\\s+){0,2}(pesticide|insecticide|rat poison|poison|kerosene|bleach|acid|organophosphate|harpic)\\b',
    ],
    bn: [
      'বিষ\\s*(?:খে|খা|পান)|বিষক্রিয়া',
      `(?:কীটনাশক|কিটনাশক|ইঁদুরের\\s*বিষ|ইদুরের\\s*বিষ|কেরোসিন|এসিড|অ্যাসিড|হারপিক)\\s*${W}{0,1}(?:খে|খা|পান)`,
      `(?:অনেকগুলো|অনেক\\s*গুলো|অনেক\\s*গুলা|এক\\s*পাতা|একপাতা|অনেক)\\s*(?:ঘুমের\\s*)?(?:ওষুধ|ঔষধ|ট্যাবলেট|বড়ি)\\s*${W}{0,1}(?:খে|খা)`,
    ],
    rom: [
      '\\bbish\\s+(?:kheyeche|khaise|kheyese|kheye|khaiche|khayeche|kheyechi|khailo|khaisi)\\b',
      '\\b(?:kitnashok|kitnashak|keroshin|kerosene|acid|harpic)\\s+(?:\\w+\\s+){0,1}(?:kheyeche|khaise|kheye|khaiche|khailo)\\b',
      '\\b(?:onekgula|onek\\s+gula|onekgulo|onek\\s+gulo|ek\\s*pata)\\s+(?:ghumer\\s+)?(?:oshudh|osud|oshud|osudh|tablet|medicine)\\s+(?:kheyeche|khaise|kheye|khaiche|kheyechi|khaisi)\\b',
    ],
  },
  {
    code: 'snakebite',
    severity: Severity.emergency,
    label: 'snakebite',
    en: ['\\b(snake\\s*(bite|bit|bitten)|bitten by a snake|snakebite)\\b'],
    bn: ['সাপ(?:ে)?\\s*(?:কেটেছে|কাটছে|কামড়|কাটে|কেটে|কাটলো|দংশন)|সর্পদংশন'],
    rom: ['\\b(?:shap|sap|saap|shaap)\\s*(?:e|ey)?\\s+(?:kateche|katche|kamor\\w*|kamra\\w*|kamri\\w*|kaitese|kaise|kete|katse|katlo|dongshon\\w*)\\b'],
  },
  {
    code: 'drowning',
    severity: Severity.emergency,
    label: 'drowning or near-drowning',
    en: ['\\b(drown\\w*|near[- ]drowning|pulled (him|her|them)? ?(out )?from (the )?water)\\b'],
    bn: ['পানিতে\\s*(?:ডুবে|পড়ে\\s*গিয়েছিল|পড়ে\\s*গেছে)|ডুবে\\s*(?:গিয়েছিল|গেছিল|গেছে|যাচ্ছিল)'],
    rom: ['\\b(?:panite|pani\\s+te)\\s+(?:dube|pore)\\b', '\\bdube\\s+(?:gese|geche|gechilo|giyechilo|jacchilo)\\b'],
  },
  {
    code: 'electric_shock',
    severity: Severity.emergency,
    label: 'electric shock',
    en: ['\\b(electric(al)?\\s+shock|electrocut\\w*)\\b'],
    bn: ['বিদ্যুৎ\\s*(?:শক|স্পৃষ্ট)|বিদ্যুতের\\s*শক|বিদ্যুৎস্পৃষ্ট|কারেন্ট\\s*(?:লেগেছে|লাগছে|লাগলো|শক|ধরেছে|ধরছে)'],
    rom: ['\\bcurrent\\s+(?:legeche|lagse|lagche|dhorse|dhoreche|shock|legese|laglo)\\b', '\\bbiddut\\s*(?:shock|sprishto)\\b'],
  },
  {
    code: 'major_trauma',
    severity: Severity.emergency,
    label: 'serious injury (fall from height, stabbing, hit by a vehicle)',
    en: [
      '\\b(hit by (a |an )?(car|bus|truck|vehicle|motorcycle|motorbike|bike|rickshaw|cng|train))\\b',
      '\\b(fell|fallen|falling) (off|from) (a |the )?(height|roof|tree|building|balcony|ladder)\\b',
      '\\b(stabbed|stab wound|gunshot|been shot|shot with a gun)\\b',
    ],
    bn: [
      `(?:গাড়ি|বাস|ট্রাক|মোটরসাইকেল|বাইক|রিকশা|সিএনজি|ট্রেন)\\s*${W}{0,1}(?:ধাক্কা|চাপা)`,
      '(?:ছাদ|গাছ|উঁচু|বিল্ডিং|বারান্দা|মই)\\s*(?:থেকে)\\s*পড়ে',
      'ছুরি(?:কাঘাত|\\s*মেরেছে|\\s*মারছে|র\\s*আঘাত)|গুলি\\s*(?:লেগেছে|করেছে|খেয়েছে)',
    ],
    rom: [
      '\\b(?:chad|gach|building|baranda)\\s+theke\\s+(?:pore|pora|poira|porse)\\b',
      '\\bchuri\\s+(?:mereche|marse|marche)\\b',
      '\\b(?:gari|bus|truck|bike|rickshaw|cng)\\s+(?:\\w+\\s+)?(?:dhakka|chapa)\\b',
    ],
  },
  {
    code: 'thunderclap_headache',
    severity: Severity.emergency,
    label: 'sudden, worst-ever headache',
    en: [
      '\\b(worst|most severe|worst ever)\\s+headache',
      '\\bheadache\\s+(of|in)\\s+my\\s+life\\b',
      '\\bsudden\\w*\\s+(severe\\s+|intense\\s+|terrible\\s+|excruciating\\s+)?headache',
      '\\bthunderclap\\b',
    ],
    bn: [
      `জীবনের\\s*সবচেয়ে\\s*${W}{0,1}মাথা\\s*${PAIN_BN}`,
      `হঠাৎ\\s*(?:করে\\s*)?(?:প্রচণ্ড|তীব্র|ভয়ানক|খুব|অসহ্য)\\s*মাথা\\s*${PAIN_BN}`,
    ],
    rom: [
      `\\bhot(?:h)?at\\s+(?:kore\\s+)?(?:procondo|prochondo|tibro|khub|osojjo)\\s+matha\\s*${PAIN_ROM}`,
      `\\bjiboner\\s+sob(?:c|ch)eye\\s+(?:\\w+\\s+)?matha\\s*${PAIN_ROM}`,
    ],
  },
  {
    code: 'nonblanching_rash',
    severity: Severity.emergency,
    label: 'rash that does not fade when pressed',
    en: ["\\b(rash (that )?(doesn'?t|does not|won'?t) fade|non[- ]?blanching|purple (spots|rash|blotches))\\b"],
    bn: ['চাপ\\s*দিলেও\\s*(?:র‍্যাশ|দাগ|ফুসকুড়ি)\\s*(?:যায়|মিলায়)\\s*না|বেগুনি\\s*(?:দাগ|র‍্যাশ)'],
  },
  {
    code: 'confusion',
    severity: Severity.emergency,
    label: 'sudden confusion',
    en: ["\\b(sudden(ly)?\\s+confus\\w*|disoriented|delirious|not making sense|talking nonsense|doesn'?t recogni[sz]e (me|us|anyone))\\b"],
    bn: ['আবোল\\s*তাবোল|উল্টা\\s*পাল্টা\\s*(?:কথা|বকছে)|উল্টাপাল্টা\\s*(?:কথা|বকছে)|ভুলভাল\\s*বকছে|কাউকে\\s*চিনতে\\s*পারছে\\s*না|প্রলাপ'],
    rom: ['\\babol\\s*tabol\\b|\\bultapalta\\s+(?:kotha|bokche)\\b|\\bchinte\\s+parche\\s+na\\b'],
    noNegation: true,
  },
  {
    code: 'fetal_movement_reduced',
    severity: Severity.emergency,
    label: 'baby in the womb moving less or not at all',
    noNegation: true,
    en: [
      "\\b(baby (is )?(not|isn'?t|hasn'?t been|has not been) moving|reduced (fetal|foetal|baby'?s?) movements?|baby (is )?moving less|no (fetal|foetal) movements?|can'?t feel (the )?baby move)",
    ],
    bn: [`পেটের\\s*বাচ্চা\\s*${W}{0,1}(?:নড়ছে|নড়াচড়া\\s*করছে)\\s*না|বাচ্চার\\s*নড়াচড়া\\s*(?:কম|বন্ধ|নেই|টের\\s*পাচ্ছি\\s*না)`],
    rom: ['\\bpeter\\s+baccha\\s+(?:\\w+\\s+){0,1}(?:norche|nore|norachora\\s+korche)\\s+na\\b|\\bbacchar\\s+norachora\\s+(?:kom|bondho|nai)\\b'],
  },

  // ---------------- urgent on their own ----------------
  {
    code: 'shortness_of_breath',
    severity: Severity.urgent,
    label: 'shortness of breath',
    en: ['\\b(short(ness)? of breath|breathless\\w*|difficulty (in )?breathing|trouble breathing|hard to breathe|breathing (problems?|difficulty)|wheez\\w*|asthma attack)\\b'],
    bn: ['শ্বাসকষ্ট|শ্বাস\\s*কষ্ট|শাসকষ্ট|শ্বাস\\s*নিতে\\s*কষ্ট|হাঁপানি|হাপানি|শ্বাস\\s*টান|হাঁপাচ্ছ'],
    rom: ['\\b(?:shash|shas|sas|swas|nishash|nisshash)\\s*(?:kosto|kashto|koshto|nite\\s+kosto|tan|kost)\\b|\\bhapani\\b|\\bhapa(?:cche|chi|cchi)\\b'],
  },
  {
    code: 'palpitations',
    severity: Severity.urgent,
    label: 'racing or pounding heart',
    en: ['\\b(palpitations?|heart (is )?(racing|pounding)|racing heart)\\b'],
    bn: ['বুক\\s*ধড়ফড়|ধড়ফড়|হার্টবিট\\s*(?:বেড়ে|বেশি)'],
    rom: ['\\b(?:buk\\s+)?dhor\\s*for\\w*'],
  },
  {
    code: 'allergy',
    severity: Severity.urgent,
    label: 'allergic reaction',
    en: ['\\b(allergic reaction|hives|allergy attack)\\b'],
    bn: ['এলার্জি|অ্যালার্জি|অ্যালার্জী|এলার্জী|এলার্জিক'],
    rom: ['\\b(?:allergy|elarji|alarji|elergy|allergi)\\b'],
  },
  {
    code: 'gi_bleeding',
    severity: Severity.urgent,
    label: 'blood in stool or urine, or black stool',
    en: ['\\b((black|tarry) (stool|poo|poop)s?|blood in (my |his |her |the )?(stool|poo|poop|urine|pee)|bloody (stool|diarrh\\w*|urine))\\b'],
    bn: ['পায়খানার?\\s*সাথে\\s*রক্ত|কালো\\s*পায়খানা|প্রস্রাবের?\\s*সাথে\\s*রক্ত|রক্ত\\s*আমাশয়'],
    rom: ['\\b(?:paykhana|paikhana|toilet|prosrab|proshrab)\\w*\\s+(?:sathe|shathe)\\s+rokto\\b|\\bkalo\\s+(?:paykhana|paikhana)\\b'],
  },
  {
    code: 'burn',
    severity: Severity.urgent,
    label: 'burn or scald',
    en: ['\\b(burned|burnt|scalded|scald|got burn(ed|t)?|burn (injury|wound)|caught fire|burns? (on|to) (the |my |his |her )?(face|hand|arm|leg|body|chest))\\b'],
    bn: [`পুড়ে\\s*(?:গেছে|গিয়েছে|গেছি|গেল)|আগুনে\\s*পুড়|গরম\\s*(?:পানি|পানিতে|তেল|তেলে|চা|ভাতের\\s*মাড়)\\s*${W}{0,1}পুড়|ছ্যাঁকা|ছেঁকা|ঝলসে`],
    rom: ['\\b(?:pure|puira|pude|puire|pude)\\s+(?:geche|gese|gechi|gelo)\\b|\\bagune\\s+pur\\w*|\\bchheka\\b|\\bchaka\\s+(?:legeche|lagse)\\b'],
  },
  {
    code: 'head_injury',
    severity: Severity.urgent,
    label: 'head injury',
    en: ['\\b(head (injury|trauma)|hit (my|his|her|their) head|bang(ed)? (my|his|her) head|blow to the head|fell on (my|his|her) head)\\b'],
    bn: [`মাথায়\\s*${W}{0,1}(?:আঘাত|চোট|বাড়ি|লেগেছে|ফেটে)|মাথা\\s*ফেটে`],
    rom: ['\\bmathay?\\s+(?:\\w+\\s+){0,1}(?:aghat|chot|bari|legeche|lagse|fete)\\b|\\bmatha\\s+fete\\b'],
  },
  {
    code: 'accident',
    severity: Severity.urgent,
    label: 'accident',
    en: ['\\b(road|car|bus|motorcycle|bike|traffic)\\s+(accident|crash|collision)\\b|\\baccident\\b'],
    bn: ['সড়ক\\s*দুর্ঘটনা|দুর্ঘটনা|এক্সিডেন্ট|অ্যাক্সিডেন্ট|এক্সিডেন্ট'],
    rom: ['\\b(?:accident|eccident|aksident|exident|exiden|accidend)\\b'],
  },
  {
    code: 'animal_bite',
    severity: Severity.urgent,
    label: 'animal bite (rabies risk)',
    en: ['\\b((dog|cat|monkey|jackal|fox|bat)\\s*(bite|bit|scratch\\w*)|bitten by (a |an )?(dog|cat|monkey|jackal|fox|bat)|rabies)\\b'],
    bn: ['(?:কুকুর|বিড়াল|বানর|শিয়াল|শেয়াল|বাদুড়)\\S*\\s*(?:কামড়|আঁচড়|আচড়|কেটেছে|কেটে)|জলাতঙ্ক|র‍্যাবিস|রেবিস'],
    rom: ['\\b(?:kukur|biral|bilai|banor|shial|sheyal)\\w*\\s+(?:kamor\\w*|kamrai\\w*|achor\\w*|kateche|katse)\\b|\\brabies\\b'],
  },
  {
    code: 'dehydration',
    severity: Severity.urgent,
    label: 'signs of dehydration',
    noNegation: true,
    en: ["\\b(severe(ly)? dehydrat\\w*|no urine|not (peed|urinated)|haven'?t (urinated|peed)|sunken eyes|rice[- ]water (stool|diarrh\\w*)|cholera)\\b"],
    bn: [`প্রস্রাব\\s*${W}{0,1}(?:হচ্ছে\\s*না|হয়নি|হয়\\s*নি|বন্ধ)|চোখ\\s*${W}{0,1}বসে\\s*(?:গেছে|গিয়েছে)|চাল\\s*ধোয়া\\s*পানির?\\s*মতো|কলেরা|পানিশূন্যতা`],
    rom: ['\\b(?:prosrab|proshrab|peshab|pesab)\\s+(?:hocche\\s+na|hoche\\s+na|hoyni|bondho)\\b|\\bchokh\\s+bose\\s+(?:gese|geche)\\b|\\bcholera\\b'],
  },
  {
    code: 'severe_abdominal_pain',
    severity: Severity.urgent,
    label: 'severe abdominal pain',
    en: [
      '\\b(severe|intense|unbearable|excruciating|terrible|worst|very bad)\\s+(abdominal|stomach|belly|tummy)\\s+(pain|ache|cramps?)',
      '\\b(stomach|belly|abdomen) (is )?(rigid|hard as a board)\\b',
    ],
    bn: [
      `(?:প্রচণ্ড|তীব্র|অসহ্য|খুব|ভয়ানক|ভীষণ)\\s*পেট(?:ে)?\\s*${PAIN_BN}`,
      `পেট(?:ে)?\\s*${W}{0,1}(?:প্রচণ্ড|তীব্র|অসহ্য|খুব|ভীষণ)\\s*${PAIN_BN}`,
      'পেট\\s*(?:শক্ত|পাথরের\\s*মতো)',
    ],
    rom: [
      `\\b(?:procondo|prochondo|tibro|osojjo|khub|vishon|bhishon)\\s+pet\\s*(?:e\\s+)?${PAIN_ROM}`,
      `\\bpet\\s*(?:e\\s+)?(?:procondo|prochondo|tibro|osojjo|khub|vishon|bhishon)\\s+${PAIN_ROM}`,
    ],
  },
  {
    code: 'vision_problem',
    severity: Severity.urgent,
    label: 'blurred or lost vision',
    noNegation: true,
    en: ["\\b(blurred vision|blurry vision|vision (is )?blurr\\w*|seeing (spots|flashes)|can'?t see|vision loss|lost (my |his |her )?vision|sudden(ly)? blind)\\b"],
    bn: ['চোখে\\s*ঝাপসা|ঝাপসা\\s*দেখ|চোখে\\s*অন্ধকার|দেখতে\\s*পাচ্ছ\\S*\\s*না'],
    rom: ['\\bjhapsa\\b|\\bchokhe\\s+ondhokar\\b|\\bdekhte\\s+(?:parchi|pacchi|parche)\\s+na\\b'],
  },
  {
    code: 'child_danger_sign',
    severity: Severity.urgent,
    label: 'child danger sign (not feeding, vomits everything, lethargic)',
    noNegation: true,
    en: ["\\b(not (feeding|drinking|breastfeeding|sucking)|won'?t (feed|drink|breastfeed)|refus\\w+ to (feed|drink|breastfeed)|vomit\\w* everything|can'?t keep anything down|letharg\\w*|floppy|very sleepy|hard to wake|limp)\\b"],
    bn: [
      `(?:দুধ|বুকের\\s*দুধ|মায়ের\\s*দুধ)\\s*${W}{0,1}(?:খাচ্ছে|টানছে|খায়|খেতে\\s*পারছে)\\s*না`,
      'কিছুই\\s*খেতে\\s*পারছে\\s*না|যা\\s*খাচ্ছে\\s*(?:তাই|সব)\\s*বমি|সব\\s*(?:কিছু\\s*)?বমি\\s*করে',
      'নিস্তেজ|নেতিয়ে|ঝিমিয়ে|ঝিমাচ্ছে',
    ],
    rom: [
      '\\bdudh\\s+(?:\\w+\\s+){0,1}(?:khacche|khache|tanche|khay)\\s+na\\b',
      '\\bkichui\\s+khete\\s+parche\\s+na\\b|\\bsob\\s+bomi\\s+(?:kore|korche)\\b',
      '\\b(?:nistej|netiye|jhimiye|jhimacche)\\b',
    ],
  },
  {
    code: 'water_broke',
    severity: Severity.urgent,
    label: 'waters broken',
    en: ['\\b(waters? (has |have )?(broke|broken)|leaking (amniotic )?fluid)\\b'],
    bn: ['পানি\\s*(?:ভেঙে|ভেঙ্গে|ভাঙ)'],
    rom: ['\\bpani\\s+(?:venge|bhenge|bhange|vange)\\b'],
  },
  {
    code: 'high_fever',
    severity: Severity.urgent,
    label: 'very high fever (104°F / 40°C or more)',
    // Filled by the numeric reader below, not by patterns.
  },
  {
    code: 'prolonged_fever',
    severity: Severity.urgent,
    label: 'fever for 3 days or more',
  },

  // ---------------- modifiers / context (no severity alone) ----------------
  { code: 'fever', severity: Severity.routine, label: 'fever',
    en: ['\\b(fever|feverish|high temperature|temperature of|pyrexia|febrile)\\b'],
    bn: ['জ্বর'],
    rom: ['\\b(?:jor|jwor|jhor|jorr|jvor|jwar|jor\\s*ashche)\\b'] },
  { code: 'headache', severity: Severity.routine, label: 'headache',
    en: ['\\b(headache|migraine)\\b'],
    bn: [`মাথা\\s*${PAIN_BN}|মাথাব্য[াে]?থা|মাথা\\s*ধরা`],
    rom: [`\\bmatha\\s*(?:${PAIN_ROM}|dhora|dhorse)\\b`] },
  { code: 'stiff_neck', severity: Severity.routine, label: 'stiff neck',
    en: ["\\b(stiff neck|neck (is )?stiff|can'?t bend (my|his|her) neck)\\b"],
    bn: [`ঘাড়\\s*${W}{0,1}(?:শক্ত|বাঁকাতে\\s*পারছ|নাড়াতে\\s*পারছ)`],
    rom: ['\\b(?:ghar|ghaar)\\s+(?:\\w+\\s+){0,1}(?:shokto|sokto|shakto)\\b'] },
  { code: 'vomiting', severity: Severity.routine, label: 'vomiting',
    en: ['\\b(vomit\\w*|throwing up|threw up)\\b'], bn: ['বমি'], rom: ['\\bbomi\\b'] },
  { code: 'abdominal_pain', severity: Severity.routine, label: 'abdominal pain',
    en: ['\\b((abdominal|stomach|belly|tummy|lower abdominal)\\s+(pain|ache|cramps?)|stomach ?ache)\\b'],
    bn: [`পেট(?:ে)?\\s*${W}{0,1}${PAIN_BN}|পেটব্য[াে]?থা|তলপেটে?\\s*${PAIN_BN}`],
    rom: [`\\b(?:tol)?pet\\s*(?:e\\s+)?(?:\\w+\\s+)?${PAIN_ROM}`] },
  { code: 'bleeding', severity: Severity.routine, label: 'bleeding',
    en: ['\\b(bleeding|bleed|blood loss|spotting)\\b'],
    bn: ['রক্ত\\s*(?:যাচ্ছে|পড়ছে|পড়া|ঝরছে|আসছে|বের\\s*হচ্ছে|দেখা)|রক্তপাত|রক্তক্ষরণ|ব্লিডিং'],
    rom: ['\\brokto\\s+(?:jacche|porche|pora|jhorche|ashche|ascche|ber)\\b|\\bbleeding\\b|\\broktopat\\b'] },
  { code: 'dengue', severity: Severity.routine, label: 'dengue',
    en: ['\\bdengue\\b'], bn: ['ডেঙ্গু|ডেঙ্গি|ডেংগু'], rom: ['\\b(?:dengu|dengue|dengi)\\b'] },
  { code: 'dengue_warning', severity: Severity.routine, label: 'bleeding gums or nose / repeated vomiting',
    en: ['\\b(bleeding (gums|from (the )?(gums|nose))|nose ?bleed\\w*|gums? (are )?bleed\\w*|persistent vomiting|keeps vomiting|vomiting again and again)\\b'],
    bn: ['(?:মাড়ি|নাক|দাঁত)\\s*(?:দিয়ে|থেকে)\\s*রক্ত|বার\\s*বার\\s*বমি|বারবার\\s*বমি'],
    rom: ['\\b(?:mari|maari|dat|nak)\\s+(?:diye|theke)\\s+rokto\\b|\\bbar\\s*bar\\s+bomi\\b'] },
  { code: 'pregnant', severity: Severity.informational, label: 'pregnancy',
    en: ['\\b(pregnan\\w*|expecting a baby|antenatal)\\b'],
    bn: ['গর্ভবতী|গর্ভাবস্থ|প্রেগন্যান্ট|প্রেগনেন্ট|পোয়াতি|অন্তঃসত্ত্বা|অন্তঃসত্তা|পেটে\\s*বাচ্চা|গর্ভে'],
    rom: ['\\b(?:gorbhoboti|gorvoboti|gorbhobhoti|pregnent|pregnant|poati|poyati|ontosotta|ontoshotta)\\b|\\bpete\\s+(?:baccha|bacha|bachcha)\\b'] },
  { code: 'postpartum', severity: Severity.informational, label: 'recently gave birth',
    en: ['\\b(after (giving )?birth|after (the )?delivery|postpartum|post-partum|just gave birth|after (my |her )?c-?section)\\b'],
    bn: ['প্রসবের\\s*পর|ডেলিভারির\\s*পর|বাচ্চা\\s*হওয়ার\\s*পর|সিজারের\\s*পর'],
    rom: ["\\b(?:prosober|delivery'?r|deliverir|sijarer|cesarer|sizarer)\\s+por\\b|\\bbaccha\\s+howar\\s+por\\b"] },
  { code: 'child', severity: Severity.informational, label: 'child or baby',
    en: ['\\b(baby|babies|infant|toddler|newborn|child|kid|my son|my daughter)\\b'],
    bn: ['বাচ্চা|শিশু|নবজাতক|খোকা|খুকি|ছেলের?\\s*বয়স|মেয়ের?\\s*বয়স'],
    rom: ['\\b(?:baccha|bacha|bachcha|bachha|shishu|sishu|babu|nobojatok)\\b'] },
  { code: 'infant_under_3m', severity: Severity.informational, label: 'baby under 3 months',
    en: ['\\b(newborn|neonat\\w*)\\b'], bn: ['নবজাতক'], rom: ['\\bnobojatok\\b'] },
  { code: 'severe_modifier', severity: Severity.informational, label: 'described as severe',
    en: ['\\b(severe|very bad|really bad|unbearable|excruciating|extreme|terrible|worst|badly|a lot|heavily|large|big)\\b'],
    bn: ['খুব|অনেক|প্রচণ্ড|তীব্র|অসহ্য|ভীষণ|মারাত্মক|ভয়ানক|বড়'],
    rom: ['\\b(?:khub|onek|procondo|prochondo|tibro|osojjo|bhishon|vishon|maratmok|boro)\\b'] },
];

// ---------------- matching ----------------

interface Compiled {
  concept: Concept;
  res: { lang: Lang; re: RegExp }[];
}

const COMPILED: Compiled[] = CONCEPTS.map((concept) => ({
  concept,
  res: ([
    ...(concept.en ?? []).map((s) => ({ lang: 'en' as Lang, s })),
    ...(concept.bn ?? []).map((s) => ({ lang: 'bn' as Lang, s })),
    ...(concept.rom ?? []).map((s) => ({ lang: 'rom' as Lang, s })),
  ]).map(({ lang, s }) => ({ lang, re: new RegExp(s.normalize('NFC'), 'giu') })),
}));

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Lower-case, NFC, straight apostrophes, Bangla digits to ASCII, no ZWJ/ZWNJ. */
export function normalizeMessage(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200c\u200d]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const CLAUSE_BREAK = /[.!?।;\n]|\bbut\b|\bkintu\b|কিন্তু|তবে/giu;
const EN_NEG_BEFORE =
  /\b(no|not|never|without|denies|denied|no longer|don'?t have|doesn'?t have|didn'?t have|haven'?t had|hasn'?t had|free of|nor)\s+(?:\S+\s+){0,2}$/iu;
const BN_NEG_AFTER = /^\s*(?:নেই|নাই|হয়নি|হয়\s*নি|হচ্ছে\s*না|nei|nai|hoyni|hoy\s+ni|hocche\s+na|hoche\s+na)(?![\p{L}\p{M}])/u;

function clauseBefore(text: string, idx: number): string {
  const before = text.slice(Math.max(0, idx - 60), idx);
  let cut = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) cut = (m.index ?? 0) + m[0].length;
  return before.slice(cut);
}

function isNegated(text: string, start: number, end: number, lang: Lang): boolean {
  if (lang === 'en' && EN_NEG_BEFORE.test(clauseBefore(text, start))) return true;
  if (lang !== 'en' && BN_NEG_AFTER.test(text.slice(end, end + 16))) return true;
  // English negation before a Banglish phrase ("no buke betha") is rare; Bangla
  // after an English phrase ("chest pain nai") is common in mixed text.
  if (lang === 'en' && BN_NEG_AFTER.test(text.slice(end, end + 16))) return true;
  return false;
}

interface Hit {
  concept: Concept;
  quote: string;
  denied: boolean;
  lang: Lang;
}

function matchConcepts(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { concept, res } of COMPILED) {
    let positive: Hit | null = null;
    let negative: Hit | null = null;
    for (const { lang, re } of res) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const denied = !concept.noNegation && isNegated(text, start, start + m[0].length, lang);
        const hit = { concept, quote: m[0].trim(), denied, lang };
        if (!denied) {
          positive = hit;
          break;
        }
        negative ??= hit;
      }
      if (positive) break;
    }
    if (positive) hits.push(positive);
    else if (negative) hits.push(negative);
  }
  return hits;
}

/** Temperatures and fever duration, read from numbers near a fever word. */
function readNumbers(text: string, hasFever: boolean): { highFever?: string; prolongedFever?: string; infant?: string } {
  const out: { highFever?: string; prolongedFever?: string; infant?: string } = {};
  if (hasFever) {
    for (const m of text.matchAll(/(\d{2,3}(?:\.\d)?)\s*(°|º|degrees?|deg|ডিগ্রি|digri|f\b|c\b|ফারেনহাইট)?/giu)) {
      const v = Number(m[1]);
      if ((v >= 104 && v <= 110) || (v >= 40 && v <= 43 && /°|º|c\b|deg|ডিগ্রি|digri/iu.test(m[2] ?? ''))) {
        out.highFever = m[0].trim();
        break;
      }
    }
    const dur = text.match(
      /(\d+)\s*(?:দিন|din|days?|সপ্তাহ|shoptaho|saptaho|weeks?)|(?:three|four|five|six|seven|several|many)\s+days|(?:one|two|a)\s+weeks?|অনেক\s*দিন|kodin\s+dhore|কয়েক\s*দিন/iu,
    );
    if (dur) {
      const n = dur[1] ? Number(dur[1]) : 3;
      const weeks = /সপ্তাহ|shoptaho|saptaho|week/iu.test(dur[0]);
      if (weeks || n >= 3) out.prolongedFever = dur[0];
    }
  }
  // Infant age: "2 months old", "৩ সপ্তাহের বাচ্চা", "10 diner baccha".
  for (const m of text.matchAll(
    /(\d{1,3})\s*(মাস|mash|mas|months?|mo|সপ্তাহ|shoptaho|saptaho|weeks?|wk|দিন|din|days?)(?:ের|er|এর)?\s*(?:বয়স|বয়সী|বয়সের|old|age|boyosh|boyos)?/giu,
  )) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + m[0].length + 30);
    const babyNear = /বাচ্চা|শিশু|ছেলে|মেয়ে|baby|infant|son|daughter|baccha|bacha|bachcha|shishu|chele|meye|babu|old|বয়স/iu.test(ctx);
    if (!babyNear) continue;
    const young =
      (/মাস|mash|mas|month|^mo$/iu.test(unit) && n < 3) ||
      (/সপ্তাহ|shoptaho|saptaho|week|wk/iu.test(unit) && n < 13) ||
      (/দিন|din|day/iu.test(unit) && n < 91 && /old|বয়স|er|ের|এর/iu.test(m[0]));
    if (young) {
      out.infant = m[0].trim();
      break;
    }
  }
  return out;
}

const SOURCE = `kb:${RED_FLAG_KB_VERSION}`;

/**
 * Deterministic classifier over the patterns above. Always returns at least one
 * finding: when nothing matched it returns `no_red_flag` at routine severity, so
 * the result is a decision (routine) and not `unknown`.
 */
export const redFlagClassifier: Classifier = {
  name: SOURCE,
  async classify(message: string): Promise<Evidence[]> {
    const text = normalizeMessage(message);
    const hits = matchConcepts(text);
    const has = (code: string) => hits.some((h) => h.concept.code === code && !h.denied);
    const nums = readNumbers(text, has('fever'));
    const ev: Evidence[] = hits.map((h) => ({
      code: h.concept.code,
      severity: h.denied ? Severity.informational : h.concept.severity,
      confidence: h.denied ? 0.6 : 0.8,
      denied: h.denied || undefined,
      rationale: `${h.denied ? 'denied: ' : ''}${h.concept.label} (${h.lang === 'en' ? 'English' : h.lang === 'bn' ? 'Bangla' : 'Banglish'} pattern: "${h.quote}")`,
      source: SOURCE,
    }));
    if (nums.highFever) ev.push({ code: 'high_fever', severity: Severity.urgent, confidence: 0.8, rationale: `temperature of 104°F / 40°C or more ("${nums.highFever}")`, source: SOURCE });
    if (nums.prolongedFever) ev.push({ code: 'prolonged_fever', severity: Severity.urgent, confidence: 0.7, rationale: `fever lasting 3 days or more (dengue / typhoid need testing) ("${nums.prolongedFever}")`, source: SOURCE });
    if (nums.infant && !has('infant_under_3m')) ev.push({ code: 'infant_under_3m', severity: Severity.informational, confidence: 0.8, rationale: `baby under 3 months ("${nums.infant}")`, source: SOURCE });
    if (!ev.some((e) => !e.denied && (e.severity === Severity.emergency || e.severity === Severity.urgent))) {
      ev.push({ code: 'no_red_flag', severity: Severity.routine, confidence: 0.5, rationale: 'none of the red-flag patterns matched', source: SOURCE });
    }
    return ev;
  },
};

// ---------------- policy ----------------

const CALL_999 =
  'Call 999 now (Bangladesh national emergency service, free, for an ambulance) or go straight to the nearest hospital emergency department. Do not wait to see if it gets better. / এখনই ৯৯৯-এ কল করুন (জাতীয় জরুরি সেবা, অ্যাম্বুলেন্সের জন্য) অথবা সরাসরি নিকটস্থ হাসপাতালের জরুরি বিভাগে যান। ভালো হয় কিনা দেখার জন্য অপেক্ষা করবেন না।';
const SEE_DOCTOR_TODAY =
  'See a doctor today, within the next few hours (hospital, upazila health complex or a doctor’s chamber). If it gets worse or a danger sign appears, call 999. For advice by phone: Shasthyo Batayon 16263 (government health helpline). / আজকেই, কয়েক ঘণ্টার মধ্যে ডাক্তার দেখান (হাসপাতাল, উপজেলা স্বাস্থ্য কমপ্লেক্স বা চেম্বার)। অবস্থা খারাপ হলে বা বিপদচিহ্ন দেখা দিলে ৯৯৯-এ কল করুন। ফোনে পরামর্শ: স্বাস্থ্য বাতায়ন ১৬২৬৩।';

const emergency = (id: string, when: PolicyRule['when'], specific: string[] = [], questions?: string[]): PolicyRule => ({
  id: `bd/${id}`,
  severity: Severity.emergency,
  when,
  guidance: [CALL_999, ...specific],
  ...(questions ? { questions } : {}),
});
const urgent = (id: string, when: PolicyRule['when'], specific: string[] = []): PolicyRule => ({
  id: `bd/${id}`,
  severity: Severity.urgent,
  when,
  guidance: [SEE_DOCTOR_TODAY, ...specific],
});
const code = (c: string): Rule => ({ op: 'code', code: c });
const all = (...codes: string[]): Rule => ({ op: 'all', of: codes.map(code) });
const any = (...codes: string[]): Rule => ({ op: 'any', of: codes.map(code) });
/** All of `must`, plus at least one of `oneOf`. */
const allAny = (must: string[], oneOf: string[]): Rule => ({ op: 'all', of: [...must.map(code), any(...oneOf)] });

const CPR =
  'If they are not breathing normally, start CPR: push hard and fast in the centre of the chest (about 2 per second) and keep going until help arrives. / স্বাভাবিকভাবে শ্বাস না নিলে CPR শুরু করুন: বুকের মাঝখানে জোরে ও দ্রুত (সেকেন্ডে প্রায় ২ বার) চাপ দিন, সাহায্য না আসা পর্যন্ত থামবেন না।';

export const RED_FLAG_POLICY: Policy = {
  id: `kb:${RED_FLAG_KB_VERSION}`,
  noMatchSeverity: Severity.routine,
  emptySeverity: Severity.routine,
  rules: [
    emergency('chest_pain', code('chest_pain'), [
      'Stop all activity and sit or lie down. Do not drive yourself to hospital. / সব কাজ থামিয়ে বসুন বা শুয়ে থাকুন। নিজে গাড়ি চালিয়ে যাবেন না।',
    ], ['Is the pain spreading to the arm, jaw or back, or coming with sweating, breathlessness or vomiting?']),
    emergency('stroke', code('stroke_signs'), [
      'FAST: Face drooping, Arm weak, Speech slurred, Time to call 999. Note the time the symptoms started. Give nothing to eat or drink. / মুখ বেঁকে যাওয়া, হাত দুর্বল, কথা জড়ানো: সময় নষ্ট না করে ৯৯৯। উপসর্গ কখন শুরু হয়েছে সময়টা লিখে রাখুন। মুখে কিছু খেতে দেবেন না।',
    ]),
    emergency('breathing', code('breathing_severe'), [
      'Sit them upright and loosen tight clothing. If they have their own reliever inhaler, they can use it as prescribed. / সোজা করে বসান, আঁটসাঁট কাপড় ঢিলা করুন। নিজের ইনহেলার থাকলে নির্দেশমতো নিতে পারেন।',
      CPR,
    ]),
    emergency('breathing_severe_combo', all('shortness_of_breath', 'severe_modifier')),
    emergency('unconscious', code('unconscious'), [
      'Check breathing. If breathing, turn them on their side (recovery position). / শ্বাস নিচ্ছে কিনা দেখুন। শ্বাস নিলে কাত করে শুইয়ে দিন।',
      CPR,
    ]),
    emergency('seizure', code('seizure'), [
      'Do not hold them down and put nothing in the mouth (no spoon, no finger). Move hard objects away, cushion the head, and turn them on their side when the jerking stops. Note how long it lasts. / চেপে ধরবেন না, মুখে কিছু দেবেন না (চামচ বা আঙুল নয়)। আশপাশের শক্ত জিনিস সরান, মাথার নিচে নরম কিছু দিন, খিঁচুনি থামলে কাত করে শুইয়ে দিন। কতক্ষণ চলল খেয়াল রাখুন।',
    ]),
    emergency('severe_bleeding', code('severe_bleeding'), [
      'Press firmly on the wound with a clean cloth and keep pressing without lifting it. / পরিষ্কার কাপড় দিয়ে ক্ষতস্থানে জোরে চেপে ধরে রাখুন, তুলবেন না।',
    ]),
    emergency('blood_vomit_cough', code('blood_vomit_cough'), [
      'Give nothing to eat or drink. / মুখে কিছু খেতে বা পান করতে দেবেন না।',
    ]),
    emergency('anaphylaxis', code('anaphylaxis'), [
      'If they have their own prescribed adrenaline (epinephrine) pen, use it now in the outer thigh. Let them lie down with legs raised, or sit up if breathing is hard. / নিজের প্রেসক্রাইব করা অ্যাড্রেনালিন পেন থাকলে এখনই উরুর বাইরের দিকে দিন। পা উঁচু করে শুইয়ে দিন, শ্বাসকষ্ট হলে বসিয়ে রাখুন।',
    ]),
    emergency('allergy_breathing', all('allergy', 'shortness_of_breath')),
    emergency('suicidal', code('suicidal'), [
      'If there is immediate danger or they have already hurt themselves, call 999 now. Stay with the person and, if it is safe, remove pills, poison, rope or sharp objects. / এখনই বিপদ থাকলে বা নিজের ক্ষতি করে ফেললে এখনই ৯৯৯-এ কল করুন। মানুষটিকে একা রাখবেন না, নিরাপদ হলে ওষুধ, বিষ, দড়ি বা ধারালো জিনিস সরিয়ে রাখুন।',
      'To talk to someone now: Kaan Pete Roi emotional support helpline 09612-119911 (confidential). / কারো সাথে কথা বলতে: কান পেতে রই হেল্পলাইন ০৯৬১২-১১৯৯১১ (গোপনীয়)।',
    ]),
    emergency('poisoning', code('poisoning'), [
      'Do not make them vomit and give nothing by mouth. Take the bottle or packet of what was swallowed to the hospital. If it is on the skin, remove the clothes and wash the skin with plenty of water. / বমি করাবেন না, মুখে কিছু খাওয়াবেন না। যা খেয়েছে তার বোতল বা প্যাকেট সাথে নিয়ে যান। গায়ে লাগলে কাপড় খুলে প্রচুর পানি দিয়ে ধুয়ে দিন।',
    ]),
    emergency('snakebite', code('snakebite'), [
      'Keep the person still and calm and keep the bitten limb still, like a broken bone. Go now to the nearest hospital that has antivenom (upazila or district hospital). Do not cut or suck the wound, do not tie a tight band, and do not go to an ojha or kabiraj. / রোগীকে শান্ত ও স্থির রাখুন, কামড়ানো হাত বা পা নাড়াবেন না। এখনই অ্যান্টিভেনম আছে এমন নিকটস্থ হাসপাতালে (উপজেলা বা জেলা হাসপাতাল) যান। ক্ষত কাটবেন না, চুষবেন না, শক্ত করে বাঁধবেন না, ওঝা বা কবিরাজের কাছে যাবেন না।',
    ]),
    emergency('drowning', code('drowning'), [
      'Even if they seem fine now, they must be checked in hospital. / এখন ভালো মনে হলেও হাসপাতালে দেখাতে হবে।',
      CPR,
    ]),
    emergency('electric_shock', code('electric_shock'), [
      'Switch off the power at the source before touching them, or push them away with something dry and wooden. / ছোঁয়ার আগে মেইন সুইচ বন্ধ করুন, অথবা শুকনো কাঠ দিয়ে সরিয়ে দিন।',
      CPR,
    ]),
    emergency('major_trauma', code('major_trauma'), [
      'Do not move them if the neck or back may be hurt, unless they are in danger. Press on any bleeding. / ঘাড় বা মেরুদণ্ডে আঘাত লাগতে পারে মনে হলে নড়াবেন না, যদি না সেখানে বিপদ থাকে। রক্ত পড়লে চেপে ধরুন।',
    ]),
    emergency('thunderclap_headache', code('thunderclap_headache')),
    emergency('meningitis_signs', all('fever', 'stiff_neck')),
    emergency('nonblanching_rash', code('nonblanching_rash')),
    emergency('confusion', code('confusion')),
    emergency('fetal_movement', code('fetal_movement_reduced'), [
      'Go to a hospital with a maternity unit now. Take the antenatal card. / এখনই প্রসূতি বিভাগ আছে এমন হাসপাতালে যান। গর্ভকালীন চেকআপ কার্ড সাথে নিন।',
    ]),
    emergency('pregnancy_danger', allAny(['pregnant'], ['bleeding', 'severe_bleeding', 'headache', 'vision_problem', 'seizure', 'abdominal_pain', 'severe_abdominal_pain', 'water_broke', 'fever', 'anaphylaxis']), [
      'In pregnancy this is a danger sign. Go now to a hospital with a maternity unit (call 999 for an ambulance). Take the antenatal card. / গর্ভাবস্থায় এটা বিপদচিহ্ন। এখনই প্রসূতি বিভাগ আছে এমন হাসপাতালে যান (অ্যাম্বুলেন্সের জন্য ৯৯৯)। গর্ভকালীন চেকআপ কার্ড সাথে নিন।',
    ]),
    emergency('postpartum_bleeding', allAny(['postpartum'], ['bleeding', 'severe_bleeding', 'seizure', 'headache', 'vision_problem']), [
      'After giving birth, heavy bleeding, fits or severe headache are danger signs. Go to hospital now. / প্রসবের পর বেশি রক্তপাত, খিঁচুনি বা প্রচণ্ড মাথাব্যথা বিপদচিহ্ন। এখনই হাসপাতালে যান।',
    ]),
    emergency('infant_fever', all('infant_under_3m', 'fever'), [
      'Any fever (38°C / 100.4°F or more) in a baby under 3 months needs a doctor now. Keep breastfeeding on the way. / ৩ মাসের কম বয়সী বাচ্চার যেকোনো জ্বর (১০০.৪°F বা তার বেশি) হলে এখনই ডাক্তার দেখাতে হবে। যাওয়ার পথে বুকের দুধ খাওয়াতে থাকুন।',
    ]),
    emergency('child_danger', allAny(['child_danger_sign'], ['child', 'infant_under_3m']), [
      'A child who cannot drink or breastfeed, vomits everything, has fits, or is very sleepy and hard to wake needs hospital now. / বাচ্চা দুধ বা পানি খেতে না পারলে, সব বমি করে দিলে, খিঁচুনি হলে বা নিস্তেজ হয়ে গেলে এখনই হাসপাতালে নিন।',
    ]),
    emergency('child_seizure_fever', all('seizure', 'child')),
    emergency('dengue_warning', allAny(['dengue'], ['dengue_warning', 'severe_abdominal_pain', 'child_danger_sign', 'bleeding']), [
      'These are dengue warning signs. Go to hospital now for blood tests and fluids. Do not take ibuprofen, aspirin or other NSAID painkillers. / এগুলো ডেঙ্গুর বিপদচিহ্ন। রক্ত পরীক্ষা আর স্যালাইনের জন্য এখনই হাসপাতালে যান। আইবুপ্রোফেন, অ্যাসপিরিন বা এ ধরনের ব্যথার ওষুধ খাবেন না।',
    ]),
    emergency('head_injury_vomiting', all('head_injury', 'vomiting')),
    emergency('burn_severe', allAny(['burn'], ['severe_modifier', 'child', 'infant_under_3m']), [
      'Cool the burn under cool running water for 20 minutes. Remove rings or clothing near it unless stuck. Cover loosely with clean cling film or a clean cloth. No ice, toothpaste, oil or butter. / পোড়া জায়গা ২০ মিনিট ঠান্ডা (বরফ নয়) চলমান পানির নিচে রাখুন। আংটি বা কাপড় সরান, তবে লেগে থাকলে টানবেন না। পরিষ্কার কাপড় দিয়ে হালকা করে ঢেকে দিন। বরফ, টুথপেস্ট, তেল বা ডিম লাগাবেন না।',
    ]),

    urgent('shortness_of_breath', code('shortness_of_breath')),
    urgent('palpitations', code('palpitations')),
    urgent('allergy', code('allergy'), [
      'If lips, tongue or throat start to swell or breathing gets hard, call 999 at once. / ঠোঁট, জিভ বা গলা ফুলতে শুরু করলে বা শ্বাসকষ্ট হলে সাথে সাথে ৯৯৯-এ কল করুন।',
    ]),
    urgent('gi_bleeding', code('gi_bleeding')),
    urgent('burn', code('burn'), [
      'Cool the burn under cool running water for 20 minutes. No ice, toothpaste, oil or butter. / পোড়া জায়গা ২০ মিনিট ঠান্ডা চলমান পানির নিচে রাখুন। বরফ, টুথপেস্ট, তেল লাগাবেন না।',
    ]),
    urgent('head_injury', code('head_injury'), [
      'Call 999 if they pass out, vomit repeatedly, have a fit, get very sleepy or confused, or have blood or clear fluid from the nose or ears. / অজ্ঞান হলে, বারবার বমি করলে, খিঁচুনি হলে, খুব ঘুম ঘুম ভাব বা এলোমেলো কথা বললে, কিংবা নাক-কান দিয়ে রক্ত বা পানি এলে ৯৯৯-এ কল করুন।',
    ]),
    urgent('accident', code('accident'), [
      'If anyone is unconscious, bleeding heavily or cannot move, call 999 now. / কেউ অজ্ঞান হলে, বেশি রক্ত পড়লে বা নড়তে না পারলে এখনই ৯৯৯-এ কল করুন।',
    ]),
    urgent('animal_bite', code('animal_bite'), [
      'Wash the wound right away with soap and running water for 15 minutes, then go today to a hospital for rabies vaccine. Do not wait for symptoms. / ক্ষতস্থান সাথে সাথে সাবান ও চলমান পানি দিয়ে ১৫ মিনিট ধুয়ে নিন, তারপর আজকেই জলাতঙ্কের টিকার জন্য হাসপাতালে যান। উপসর্গের জন্য অপেক্ষা করবেন না।',
    ]),
    urgent('dehydration', code('dehydration'), [
      'Give oral saline (ORS) in small, frequent sips while you go. / যাওয়ার পথে অল্প অল্প করে বারবার খাবার স্যালাইন খাওয়ান।',
    ]),
    urgent('severe_abdominal_pain', code('severe_abdominal_pain')),
    urgent('vision_problem', code('vision_problem'), [
      'If the vision loss is sudden, or comes with face drooping, weakness or slurred speech, call 999. / হঠাৎ দেখতে না পেলে, বা সাথে মুখ বেঁকে যাওয়া, দুর্বলতা, কথা জড়িয়ে যাওয়া থাকলে ৯৯৯-এ কল করুন।',
    ]),
    urgent('child_danger_sign', code('child_danger_sign')),
    urgent('water_broke', code('water_broke'), [
      'Go to the hospital or maternity unit where you plan to deliver. / যেখানে ডেলিভারি করানোর কথা, সেই হাসপাতালে যান।',
    ]),
    urgent('high_fever', code('high_fever')),
    urgent('prolonged_fever', code('prolonged_fever'), [
      'A fever lasting 3 days or more needs a doctor and blood tests (for example for dengue or typhoid). / ৩ দিন বা তার বেশি জ্বর থাকলে ডাক্তার দেখিয়ে রক্ত পরীক্ষা করানো দরকার (যেমন ডেঙ্গু বা টাইফয়েড)।',
    ]),
    urgent('fever_warning', all('fever', 'dengue_warning')),
    urgent('postpartum_fever', all('postpartum', 'fever')),
    urgent('child_fever_vomiting', all('child', 'fever', 'vomiting')),
  ],
};

/** Limitations added to every result from this knowledge base. */
export const RED_FLAG_LIMITATIONS = [
  `Screened by a fixed red-flag pattern list (${RED_FLAG_KB_VERSION}) in English, Bangla and Banglish. It is not clinician-reviewed and is not a diagnosis.`,
  'A routine result only means none of the listed danger patterns matched. If the person feels very unwell or is getting worse, treat it as urgent.',
  'Time framing ("three years ago") is not understood, so past events may be flagged.',
];
