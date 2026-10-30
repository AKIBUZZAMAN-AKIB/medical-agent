/**
 * Bangla-script and romanised-Banglish terms mapped to the English words the
 * disease knowledge base is written in. The knowledge base itself is English,
 * so a Bangla or Banglish question is expanded with these words before the
 * keyword search, and the expansion is also passed to the embedding model
 * (multilingual-e5-base) and to the reranker.
 *
 * `bn` entries match as substrings (Bangla has no reliable word boundaries in
 * practice: "ডেঙ্গুর", "ডেঙ্গুতে"). `latin` entries match as whole words, or as a
 * word prefix when they end in `*`.
 *
 * Hand-curated for this repository; safe to extend. Keep the English side to
 * words that actually appear in disease names, synonyms or symptom text.
 */
export interface LexiconEntry {
  bn: string[];
  latin: string[];
  en: string;
}

export const DISEASE_LEXICON: LexiconEntry[] = [
  // Infectious diseases common in Bangladesh
  { bn: ['ডেঙ্গু', 'ডেংগু'], latin: ['dengu*', 'denggu'], en: 'dengue fever' },
  {
    bn: ['চিকুনগুনিয়া', 'চিকনগুনিয়া'],
    latin: ['chikungunia', 'chikun*', 'chikon*'],
    en: 'chikungunya',
  },
  { bn: ['ম্যালেরিয়া'], latin: ['maleria', 'malaria'], en: 'malaria' },
  {
    bn: ['টাইফয়েড', 'টাইফয়েড', 'টাইফেড'],
    latin: ['taifoid', 'taifeyed', 'typhoid', 'taifed'],
    en: 'typhoid fever enteric fever',
  },
  { bn: ['প্যারাটাইফয়েড'], latin: ['paratyphoid'], en: 'paratyphoid fever' },
  { bn: ['কলেরা'], latin: ['colera', 'kolera'], en: 'cholera' },
  {
    bn: ['ডায়রিয়া', 'ডায়রিয়া', 'ডাইরিয়া', 'পাতলা পায়খানা'],
    latin: ['diarrhea', 'daeria', 'dayria', 'dairia', 'patla paikhana', 'patla pykhana'],
    en: 'diarrhea gastroenteritis',
  },
  {
    bn: ['আমাশয়', 'আমাশা', 'রক্ত আমাশয়'],
    latin: ['amashoy', 'amasha', 'amashay'],
    en: 'dysentery shigellosis bloody diarrhea',
  },
  {
    bn: ['যক্ষ্মা', 'যক্ষা', 'টিবি'],
    latin: ['jokkha', 'jokkhma', 'jokkhaa', 'tb'],
    en: 'tuberculosis',
  },
  {
    bn: ['জলাতঙ্ক', 'কুকুরে কামড়', 'কুকুরের কামড়'],
    latin: ['jolatonko', 'kukur kamor', 'kukure kamor', 'kukur kamrise'],
    en: 'rabies dog bite',
  },
  {
    bn: ['জন্ডিস', 'হেপাটাইটিস'],
    latin: ['jondis', 'jaundice', 'hepatitis', 'hepataitis'],
    en: 'jaundice hepatitis',
  },
  { bn: ['হাম'], latin: ['ham'], en: 'measles' },
  {
    bn: ['জলবসন্ত', 'চিকেন পক্স', 'চিকেনপক্স', 'বসন্ত'],
    latin: ['jolbosonto', 'bosonto', 'chicken pox', 'chickenpox'],
    en: 'varicella chickenpox',
  },
  {
    bn: ['খোসপাঁচড়া', 'খোস পাঁচড়া', 'পাঁচড়া', 'স্ক্যাবিস'],
    latin: ['khos pachra', 'khospachra', 'pachra', 'scabis'],
    en: 'scabies',
  },
  { bn: ['দাদ'], latin: ['daad', 'dad rog'], en: 'tinea ringworm dermatophytosis' },
  { bn: ['কৃমি'], latin: ['krimi', 'kirmi'], en: 'intestinal worms helminth ascariasis' },
  {
    bn: ['কালাজ্বর', 'কালা জ্বর'],
    latin: [
      'kalajor',
      'kala jor',
      'kalajwor',
      'kala jwor',
      'kalazor',
      'kalajar',
      'kalajhor',
      'kala azar',
      'kala-azar',
      'kalaazar',
    ],
    en: 'visceral leishmaniasis kala-azar',
  },
  {
    bn: ['গোদ', 'ফাইলেরিয়া'],
    latin: ['god rog', 'filaria', 'fileria'],
    en: 'lymphatic filariasis',
  },
  { bn: ['নিপাহ'], latin: ['nipah', 'nipa'], en: 'nipah virus' },
  { bn: ['ধনুষ্টংকার', 'টিটেনাস'], latin: ['dhonustonkar', 'titenus'], en: 'tetanus' },
  { bn: ['ডিপথেরিয়া'], latin: ['diptheria'], en: 'diphtheria' },
  {
    bn: ['হুপিং কাশি', 'হুপিংকাশি'],
    latin: ['huping kashi', 'whooping'],
    en: 'pertussis whooping cough',
  },
  { bn: ['মাম্পস', 'গলাফোলা', 'গাল ফোলা'], latin: ['mumps', 'gal fola'], en: 'mumps' },
  { bn: ['কুষ্ঠ'], latin: ['kustho', 'kushtho'], en: 'leprosy' },
  { bn: ['করোনা', 'কোভিড'], latin: ['corona', 'korona', 'covid'], en: 'COVID-19 coronavirus' },
  { bn: ['ইনফ্লুয়েঞ্জা', 'ফ্লু'], latin: ['flu', 'influenza'], en: 'influenza' },
  {
    bn: ['নিউমোনিয়া', 'নিউমোনিয়া'],
    latin: ['niumonia', 'pneumonia', 'numonia'],
    en: 'pneumonia',
  },
  {
    bn: ['সর্দি', 'ঠান্ডা লাগা', 'সর্দিকাশি'],
    latin: ['sordi', 'thanda laga', 'thanda legeche'],
    en: 'common cold',
  },
  {
    bn: ['গলা ব্যথা', 'টনসিল'],
    latin: ['gola betha', 'gola batha', 'tonsil'],
    en: 'sore throat pharyngitis tonsillitis',
  },
  {
    bn: ['চোখ ওঠা', 'চোখ উঠা'],
    latin: ['chokh utha', 'chokh otha', 'chok utha'],
    en: 'conjunctivitis',
  },
  { bn: ['কান পাকা', 'কানপাকা'], latin: ['kan paka'], en: 'otitis media ear infection' },
  {
    bn: ['প্রস্রাবে জ্বালা', 'প্রস্রাবের সংক্রমণ', 'ইউরিন ইনফেকশন'],
    latin: ['prosrabe jala', 'prosab jala', 'urine infection', 'uti'],
    en: 'urinary tract infection',
  },
  { bn: ['লেপ্টোস্পাইরোসিস'], latin: ['lepto*'], en: 'leptospirosis' },
  { bn: ['জিকা'], latin: ['zika'], en: 'zika virus' },
  // Chronic and non-communicable
  {
    bn: ['ডায়াবেটিস', 'ডায়াবেটিস', 'বহুমূত্র'],
    latin: ['diabetes', 'diabetis', 'daibetis', 'sugar'],
    en: 'diabetes mellitus',
  },
  {
    bn: ['উচ্চ রক্তচাপ', 'হাই প্রেসার', 'প্রেসার'],
    latin: ['high pressure', 'presar', 'pressure', 'high bp'],
    en: 'hypertension high blood pressure',
  },
  {
    bn: ['হাঁপানি', 'হাপানি', 'অ্যাজমা'],
    latin: ['hapani', 'haapani', 'azma', 'asthma'],
    en: 'asthma',
  },
  { bn: ['স্ট্রোক'], latin: ['stroke', 'strok'], en: 'stroke' },
  {
    bn: ['হার্ট অ্যাটাক', 'হার্ট এটাক', 'হৃদরোগ'],
    latin: ['heart attack', 'hart attack', 'heart atak'],
    en: 'myocardial infarction heart attack',
  },
  { bn: ['মৃগী'], latin: ['mrigi', 'mirgi'], en: 'epilepsy seizure' },
  {
    bn: ['থ্যালাসেমিয়া', 'থ্যালাসেমিয়া'],
    latin: ['thalassemia', 'thalasemia'],
    en: 'thalassemia',
  },
  {
    bn: ['রক্তশূন্যতা', 'রক্তস্বল্পতা'],
    latin: ['roktoshunnota', 'rokto shunnota', 'roktoshollota', 'anemia'],
    en: 'anemia',
  },
  {
    bn: ['গ্যাস্ট্রিক', 'আলসার', 'অম্বল'],
    latin: ['gastric', 'ulcer', 'ombol', 'gas hoy'],
    en: 'peptic ulcer gastritis dyspepsia',
  },
  {
    bn: ['পিত্তথলির পাথর', 'পিত্তে পাথর'],
    latin: ['pitto thoni pathor', 'gallstone'],
    en: 'gallstones cholelithiasis',
  },
  {
    bn: ['কিডনিতে পাথর', 'কিডনি পাথর'],
    latin: ['kidney pathor', 'kidney stone'],
    en: 'kidney stones nephrolithiasis',
  },
  { bn: ['কিডনি'], latin: ['kidney', 'kidni'], en: 'kidney disease' },
  { bn: ['লিভার'], latin: ['liver'], en: 'liver disease' },
  { bn: ['ক্যান্সার'], latin: ['cancer', 'kansar', 'cansar'], en: 'cancer' },
  { bn: ['গেঁটে বাত', 'গেটে বাত'], latin: ['gete bat', 'gout'], en: 'gout' },
  { bn: ['বাত', 'আর্থ্রাইটিস'], latin: ['bat byatha', 'arthritis'], en: 'arthritis' },
  {
    bn: ['থাইরয়েড', 'থাইরয়েড'],
    latin: ['thyroid', 'thairoid'],
    en: 'thyroid hypothyroidism hyperthyroidism',
  },
  { bn: ['পাইলস', 'অর্শ'], latin: ['piles', 'arsh', 'orsho'], en: 'hemorrhoids' },
  { bn: ['মাইগ্রেন'], latin: ['migraine', 'maigren'], en: 'migraine' },
  { bn: ['অ্যালার্জি', 'এলার্জি'], latin: ['allergy', 'elarji', 'alarji'], en: 'allergy allergic' },
  { bn: ['একজিমা'], latin: ['eczema', 'ekjima'], en: 'eczema atopic dermatitis' },
  { bn: ['সোরিয়াসিস'], latin: ['psoriasis', 'soriasis'], en: 'psoriasis' },
  { bn: ['শ্বেতী'], latin: ['sheti', 'shweti'], en: 'vitiligo' },
  { bn: ['ব্রণ'], latin: ['bron'], en: 'acne' },
  { bn: ['হার্নিয়া'], latin: ['hernia'], en: 'hernia' },
  {
    bn: ['অ্যাপেন্ডিসাইটিস', 'অ্যাপেন্ডিক্স'],
    latin: ['appendix', 'apendix', 'appendicitis'],
    en: 'appendicitis',
  },
  { bn: ['আর্সেনিক'], latin: ['arsenic'], en: 'arsenicosis arsenic poisoning' },
  {
    bn: ['বিষণ্নতা', 'ডিপ্রেশন'],
    latin: ['depression', 'bishonnota'],
    en: 'depression depressive disorder',
  },
  { bn: ['দুশ্চিন্তা', 'উদ্বেগ'], latin: ['anxiety', 'dushchinta'], en: 'anxiety disorder' },
  { bn: ['অপুষ্টি'], latin: ['oputi', 'oppushti', 'malnutrition'], en: 'malnutrition' },
  { bn: ['হিট স্ট্রোক', 'গরমে অজ্ঞান'], latin: ['heat stroke', 'heatstroke'], en: 'heat stroke' },
  {
    bn: ['পানিশূন্যতা'],
    latin: ['panishunnota', 'pani shunnota', 'dehydration'],
    en: 'dehydration',
  },
  {
    bn: ['সাপে কাটা', 'সাপের কামড়'],
    latin: ['shape kata', 'shap kamor', 'snake bite'],
    en: 'snakebite envenoming',
  },
  // Symptoms and question words (expand the question, not a disease)
  { bn: ['জ্বর'], latin: ['jor', 'jwor', 'jhor', 'jvor', 'jorr'], en: 'fever' },
  { bn: ['কাশি'], latin: ['kashi', 'kasi'], en: 'cough' },
  {
    bn: ['মাথাব্যথা', 'মাথা ব্যথা'],
    latin: ['matha betha', 'matha batha', 'mathabetha'],
    en: 'headache',
  },
  {
    bn: ['বুকে ব্যথা', 'বুক ব্যথা'],
    latin: ['buke betha', 'buk betha', 'buke batha'],
    en: 'chest pain',
  },
  {
    bn: ['পেট ব্যথা', 'পেটে ব্যথা'],
    latin: ['pet betha', 'pete betha', 'pet batha'],
    en: 'abdominal pain',
  },
  {
    bn: ['শ্বাসকষ্ট', 'শ্বাস কষ্ট'],
    latin: ['shash kosto', 'shashkosto', 'swash kosto'],
    en: 'shortness of breath dyspnea',
  },
  { bn: ['বমি'], latin: ['bomi', 'vomi'], en: 'vomiting' },
  {
    bn: ['গিরায় ব্যথা', 'জয়েন্টে ব্যথা', 'গিঁটে ব্যথা'],
    latin: ['giray betha', 'joint betha', 'gite betha'],
    en: 'joint pain arthralgia',
  },
  {
    bn: ['র‍্যাশ', 'ফুসকুড়ি', 'চুলকানি'],
    latin: ['rash', 'fuskuri', 'chulkani', 'khujli'],
    en: 'rash itching',
  },
  { bn: ['দুর্বলতা', 'দুর্বল'], latin: ['durbol', 'durbolota'], en: 'weakness fatigue' },
  { bn: ['রক্তপাত'], latin: ['roktopat'], en: 'bleeding' },
  { bn: ['খিঁচুনি'], latin: ['khichuni'], en: 'seizure convulsion' },
  { bn: ['লক্ষণ', 'উপসর্গ'], latin: ['lokkhon', 'lokkhan', 'loksmon', 'uposorgo'], en: 'symptoms' },
  { bn: ['কারণ', 'কেন হয়'], latin: ['karon', 'keno hoy'], en: 'causes' },
  { bn: ['প্রতিরোধ', 'প্রতিকার'], latin: ['protirodh', 'protikar'], en: 'prevention' },
  {
    bn: ['ছড়ায়', 'ছোঁয়াচে'],
    latin: ['choray', 'choyache', 'chhoyache'],
    en: 'transmission contagious',
  },
  { bn: ['পরীক্ষা', 'টেস্ট'], latin: ['porikkha', 'test'], en: 'diagnosis test' },
  { bn: ['শিশু', 'বাচ্চা'], latin: ['shishu', 'baccha', 'bacha'], en: 'child children' },
  {
    bn: ['গর্ভবতী', 'গর্ভাবস্থা'],
    latin: ['gorbhoboti', 'pregnant', 'pregnancy'],
    en: 'pregnancy pregnant',
  },
];

function escape(re: string): string {
  return re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED = DISEASE_LEXICON.map((entry) => ({
  entry,
  latin: entry.latin.map((term) => {
    const prefix = term.endsWith('*');
    const body = escape(prefix ? term.slice(0, -1) : term).replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^a-z0-9])${body}${prefix ? '' : '(?![a-z0-9])'}`, 'i');
  }),
}));

/** English words implied by Bangla / Banglish words in the query, in lexicon order, de-duplicated. */
export function expandQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const out: string[] = [];
  for (const { entry, latin } of COMPILED) {
    const hit = entry.bn.some((b) => query.includes(b)) || latin.some((re) => re.test(lower));
    if (hit && !out.includes(entry.en)) {
      out.push(entry.en);
    }
  }
  return out;
}

export function hasBangla(text: string): boolean {
  return /[\u0980-\u09FF]/.test(text);
}
