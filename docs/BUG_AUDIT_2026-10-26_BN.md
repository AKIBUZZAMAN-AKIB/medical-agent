# গভীর বাগ-অডিট — ২৬ অক্টোবর ২০২৬

কোড পড়ে অনুমান নয় — প্রতিটি বাগ **চালিয়ে দেখানো** হয়েছে (কোড থেকে প্রত্যাশা, তারপর বাস্তব আউটপুট), তারপর ঠিক করে টেস্ট লেখা হয়েছে।
কাঁচা প্রমাণ: `docs/REPOSITORY_DEEP_AUDIT.md` §F-29 … §F-40।

## এক নজরে

| # | বাগ | 심각도 | অবস্থা |
| --- | --- | --- | --- |
| F-29 | ল্যাব রিপোর্টের একক (unit) না দেখে `lab_result_interpreter` — mmol/L-এর স্বাভাবিক রিপোর্ট থেকে **দুটি ভুয়া "CRITICAL" প্যানিক অ্যালার্ট** | P1 | ✅ ঠিক |
| F-30 | `drug_interaction_check` শব্দ ভাগ করে "acid" মিলেই বলে দিত **"labelled interaction"** | P1 | ✅ ঠিক |
| F-31 | ৬৪ অক্ষরের বেশি লম্বা প্রোফাইল নাম কেটে ফেলা হত → **দুই ব্যক্তির রেকর্ড এক** | P1 | ✅ ঠিক |
| F-32 | Europe PMC ডাউন থাকলে জানাত **"এই পেপারের ফুল টেক্সট নেই"** | P1 | ✅ ঠিক |
| F-33 | অ্যাডমিন ট্রায়াজ ম্যাচারে গ্রেডেড severity কোড **কখনো চলত না** | P2 | ✅ ঠিক |
| F-34 | অ্যাডমিন API প্রতি রিকোয়েস্টে **পুরো users / messages কালেকশন** মেমরিতে তুলত | P2 | ✅ ঠিক |
| F-35 | `unknown` severity `emergency`-র চেয়ে উপরে ⇒ নিশ্চিত ইমার্জেন্সিও "NOT ASSESSED" দেখায় | P1 | ⏳ আপনার সিদ্ধান্ত দরকার |
| F-36 | HTTP বডির সাইজ-লিমিট পুরো বডি পড়ার **পরে** চেক হয় | P2 | ⏳ খোলা |
| F-37 | optional enrichment ব্যর্থ হলে "কিছু নেই" বলে জানায় | P3 | ⏳ খোলা |
| F-38 | `emptyOnNotFound` অপশনটির **কোনো প্রভাব নেই** | P3 | ⏳ খোলা |
| F-39 | `updateProfile({relationship: null})` ফিল্ড মুছতে পারে না, তবু "ok" ফেরায় | P3 | ⏳ খোলা |
| F-40 | অ্যাডমিন প্যানেল এখনো হাতে লেখা কীওয়ার্ড তালিকা (আপনার "predefined নয়" নিয়মের পরিপন্থী) | P2 | ⏳ আপনার সিদ্ধান্ত |

## সবচেয়ে বিপজ্জনক তিনটি, বিস্তারিত

### ১. ল্যাব রিপোর্টের একক উপেক্ষা (F-29)

একজন সুস্থ মানুষের SI-একক রিপোর্ট দিলে টুল যা বলত:

```
values: { fasting_glucose: 5.5, creatinine: 88, bilirubin_total: 12, albumin: 42 }
→ CRITICAL LOW Fasting Plasma Glucose: 5.5 mg/dL — immediate emergency clinical assessment required.
→ CRITICAL HIGH Serum Creatinine: 88 mg/dL — immediate emergency clinical assessment required.
```

৫.৫ mmol/L গ্লুকোজ আর ৮৮ µmol/L ক্রিয়েটিনিন পুরোপুরি স্বাভাবিক; কিন্তু টুল সেগুলোকে mg/dL ধরে
নিয়ে **দুটি ভুয়া ইমার্জেন্সি** বানাচ্ছিল। উল্টো দিকটাও বিপজ্জনক — SI সংখ্যা কনভেনশনাল রেঞ্জের ভিতরে
পড়ে গেলে আসল প্যানিক ভ্যালু "স্বাভাবিক" দেখাবে।
**ফিক্স:** ঐচ্ছিক `units` ম্যাপ; যে একক টেবিলের একক নয় তা **ব্যাখ্যাই করা হয় না**, আলাদা করে দেখানো হয়।

### ২. মিথ্যা "labelled interaction" (F-30)

`aspirin + valproic acid` দিলে টুল বলত —
*"aspirin's label text names valproic acid: treat it as a labelled interaction"*।
কারণ: নাম ভেঙে যেকোনো একটা শব্দ (এখানে **"acid"**) মিললেই মিলেছে ধরে নিত।
sodium/chloride/potassium/acid — বাস্তব ওষুধের বড় অংশেই এই ভুয়া পজিটিভ সম্ভব।
**ফিক্স:** পুরো নাম মিললে তবেই "নাম আছে" — কম মিলবে, কিন্তু বানানো মিল কখনো নয়।

### ৩. দুই ব্যক্তি, এক রেকর্ড (F-31)

```
'A'×70 + ' father'  → aaaa…aaaa  (৬৪ অক্ষর)
'A'×70 + ' mother'  → aaaa…aaaa  (হুবহু একই)
```

নাম ৬৪ অক্ষরে কেটে ফেলা হত, তাই দুইজনের ফ্যাক্ট একই পার্টিশনে যেত — কোনো এরর ছাড়াই।
**ফিক্স:** কী পুরোটা রাখা হয়, না হলে হ্যাশ — কখনো কাটা হয় না।

## যা ইচ্ছাকৃতভাবে বদলাইনি (আপনার সিদ্ধান্ত দরকার)

1. **F-35 — `unknown` বনাম `emergency`।** ট্রায়াজ ফ্রেমওয়ার্কে `unknown`(৫) > `emergency`(৪), আর join হল max।
   ফলে একটি অনিশ্চিত ফাইন্ডিং একসাথে থাকা **নিশ্চিত কার্ডিয়াক অ্যারেস্ট ফাইন্ডিংকেও** "NOT ASSESSED" বানিয়ে দেয়,
   আর `safetyAlerts` সেটি বাদ দেয়। এটি ডকুমেন্টেড + টেস্টেড ডিজাইন, তাই নিজে বদলাইনি।
   বিকল্প: (ক) `emergency` জিতবে, অনিশ্চয়তা আলাদা লাইনে থাকবে; (খ) যেমন আছে তেমন, শুধু কনসোল লেখা বদলাবে।
2. **F-40 — অ্যাডমিন ট্রায়াজ প্যানেল।** `medicalCommand.js`-এ এখনো ~৯০ লাইনের হাতে লেখা উপসর্গ-শব্দ (বাংলা+ইংরেজি)
   এবং হার্ডকোড করা ক্রাইসিস নম্বর। আপনি বলেছিলেন কোনো predefined তালিকা থাকবে না।
   বিকল্প: (ক) প্যানেলের severity আসুক এজেন্টের নিজের `emergency_triage_check` ফলাফল থেকে;
   (খ) তালিকা থাক, কিন্তু প্যানেলে স্পষ্ট লেখা থাকুক "unvalidated keyword screen"।

## টেস্ট ফলাফল (সব পাস)

| স্যুট | ফল |
| --- | --- |
| `packages/mcp-medical` (৯ ফাইল, নতুন `audit-regressions.spec.ts` সহ) | **153 / 153** |
| `config/medical-deployment-config.spec.js` | **17 / 17** |
| `api/.../medicalCommand.spec.js` (২টি নতুন টেস্ট) | **8 / 8** |
| `packages/data-schemas` (profile + memory) | **41 / 41** |
| `packages/api` (profiles + agents/memory) | **90 / 90** |
| `handleTools` (api) | **39 / 39** |
| `tsc --noEmit` (mcp-medical) | পরিষ্কার |
| eslint (আমার বদলানো লাইন) | পরিষ্কার |

> নোট: `eslint .` পুরো রিপোতে **২০৭টি পূর্ব-বিদ্যমান** সমস্যা দেখায় (অনেক ফাইল আমি ছুঁইনি)।
> `calculators.ts`-এর ৩০টি এরর সবই ৬৩২ নম্বর লাইনের আগে — অর্থাৎ আমার যোগ করা কোডের আগেই ছিল।

## যেভাবে নিজে যাচাই করবেন

```bash
export PATH=/home/user/.toolchain/node24/bin:$PATH
cd packages/mcp-medical && npx jest --maxWorkers=1          # 153
cd /home/user/medical-agent && npx jest --config api/jest.config.js --maxWorkers=1 --rootDir api \
  --testPathPatterns medicalCommand                          # 8
node -e "…"   # F-29/F-30/F-31-এর লাইভ প্রমাণ: docs/REPOSITORY_DEEP_AUDIT.md §F-29…31
```

---

# পর্ব ২ — ২৭ অক্টোবর ২০২৬: "predefined keyword" সম্পূর্ণ নির্মূল

আপনার নির্দেশ ছিল: **কোথাও কোনো predefined keyword/লিস্ট থাকবে না — severity/speciality আসবে classifier, মডেল বা বাহ্যিক তথ্য থেকে।**
পুরো রিপোতে গ্রেপ করে ৬টি জায়গা পাওয়া গিয়েছিল যেখানে আমি নিজে লেখা শব্দ-তালিকা সিদ্ধান্ত নিচ্ছিল। সবগুলোই সরানো হয়েছে:

| # | কোথায় ছিল | কী ছিল | এখন কী |
| --- | --- | --- | --- |
| F-40 | `api/.../medicalCommand.js` → `classifyClinicalMessageRisk` | ~৯০ লাইনের regex লেক্সিকন (suicide/chest pain/dengue/napa/bizoran… + বাংলা শব্দ), প্রতিটি ম্যাচে severity ও "specialty" | ফাংশনটি **ডিলিট**। severity এখন সংরক্ষিত `emergency_triage_check` সিদ্ধান্ত (sentinel) থেকে পড়া হয় — নতুন ফাইল `triageEvidence.js`। কোনো সংরক্ষিত সিদ্ধান্ত না থাকলে সারি লেখে **`unassessed`** |
| F-40 | একই ফাইলে `dengueAlerts` / `pgxAlerts` KPI | রোগীর বাক্যে `/dengue|ডেঙ্গু/` ও `/cyp2c19|hla-b|…/` ম্যাচ গুনত | KPI ডিলিট → `assessedMessages` / `unassessedMessages` / `undecidedMessages` |
| F-40 | একই ফাইল, `specialty` ও `flags` | শব্দ দেখে অনুমান করা "specialty" ও ট্যাগ | `specialty` = কোন এজেন্ট আসলে উত্তর দিয়েছে (`conversations.agent_id`); `flags` = আসলে কল হওয়া MCP টুলের তালিকা |
| F-25 | `packages/mcp-medical/src/tools/orchestration.ts` → `SPECIALTY_PROFILES` | ৫টি প্রোফাইল, প্রতিটির `keywords: RegExp` (একটি `/.*/`), প্রথম ম্যাচ wins + লেখা redFlags/প্রশ্ন | ডিলিট। ব্লুপ্রিন্ট এখন কেবল caller-এর দেওয়া `specialty`/`clinical_focus`/`red_flags`/`context_questions`/`tools` থেকে তৈরি, আর লাইভ টুল ক্যাটালগ দেখায়। কিছু না দিলে লেখে "No red-flag triggers were supplied" — কিছু বানায় না |
| F-41 | `pharmacogenomics.ts` → `POPULATION_PGX_NOTES` | ৭টি "South Asian population alert" প্যারাগ্রাফ, drug/gene regex দিয়ে বাছাই, হাতে লেখা allele frequency | ডিলিট। এখন CPIC API-র `genesymbol`/`drugname`/`cpiclevel` থেকেই সেকশন তৈরি; population তথ্যের জন্য guideline URL |
| F-42 | `calculators.ts` → lab pattern | সংখ্যা-শর্তে "Dengue Plasma-Leakage … Warning Pattern" নামকরণ + চিকিৎসা-নির্দেশ | এখন শুধু মাপা সংখ্যা + "Reported as measurements only: this tool does not name a cause, a diagnosis or a treatment" |
| F-43 | `PRESET_SPECIALTY_BLUEPRINTS` | ১০টি preset সাব-এজেন্টের ভেতরে লেখা ক্লিনিকাল নির্দেশনা (SJS/TEN স্ক্রিনিং, QTc অডিট, ক্রাইসিস নম্বর) | preset থাকল, কিন্তু instructions এখন একটাই নিরপেক্ষ টেমপ্লেট: severity `emergency_triage_check` থেকে, তথ্য MCP টুল+citation থেকে, নিজে ডায়াগনোজ/ডোজ পরিবর্তন না |
| F-26 | `LAB_RANGES`-এর note | "strictly avoid NSAIDs/aspirin…", "critical clue in Dengue plasma leakage" | note এখন শুধু দিক বলে ("Below/Above the adult reference interval…")। সংখ্যাগত রেঞ্জ/panic threshold আছে — সেটা গণিত |

**একটি নতুন কনট্রাক্ট যোগ হয়েছে (এবং কেন):** `emergency_triage_check` এখন আউটপুটে এক লাইন মেশিন-পাঠযোগ্য সারাংশ দেয় —
`<<<TRIAGE_DECISION {"severity":"…","decided":true,"classifier":"…","ruleset":"2.0.0-generation"}>>>`।
এটি ছাড়া অ্যাডমিন কনসোল "ক্লাসিফায়ার কী বলেছিল" জানতে আবার বাক্য পড়তে বাধ্য হতো — অর্থাৎ আবার লেক্সিকনে ফিরে যেত। এখন কনসোল সংরক্ষিত ফলাফল পড়ে।

**সৎ সীমাবদ্ধতা (গুরুত্বপূর্ণ):**
- যদি ডিপ্লয়মেন্ট কখনো `emergency_triage_check` কল না করে, তাহলে অ্যাডমিন প্যানেলের **সব সারি `unassessed`** দেখাবে। এটা মিথ্যা নয় — রেকর্ডে কোনো সিদ্ধান্তই নেই। এটাই `unassessedMessages` KPI-তে দেখানো হয়।
- এই সার্ভারে কোনো মডেল নেই, তাই `emergency_triage_check` নিজেই `unknown` (undecided) ফেরায়। আসল ক্লাসিফায়ার হোস্ট সাইডে যুক্ত করতে হবে।
- সংখ্যাগত ক্লিনিকাল কনস্ট্যান্ট (lab intervals, calculator point tables, BMI cut-offs) এখনো আমি-লেখা ও unversioned → **F-44, OPEN** (কোন স্ট্যান্ডার্ড সাইট করবেন সেটা আপনার সিদ্ধান্ত; আমি বানিয়ে দিলে সেটাই আবার একই ভুল)।

## টেস্ট ফলাফল (পর্ব ২)

| স্যুট | ফল |
| --- | --- |
| `packages/mcp-medical` (৯ ফাইল) | **157 / 157** |
| `packages/mcp-medical` `tsc --noEmit` | পরিষ্কার |
| `api/.../triageEvidence.spec.js` (নতুন) | **8 / 8** |
| `api/.../medicalCommand.spec.js` (৪টি টেস্ট নতুন লেখা) | **9 / 9** |
| `client` `AdminPortalView.spec.tsx` | **2 / 2** (টেস্ট পাস; এরপর রানার হোস্ট-র‍্যামে OOM — নিচে দেখুন) |

```bash
cd packages/mcp-medical && npx jest
cd /home/user && npx jest --config api/jest.config.js --rootDir api server/routes/admin/__tests__/
cd client && NODE_ENV=test npx jest --config jest.config.cjs src/components/Admin/__tests__/AdminPortalView.spec.tsx
```

> **NOT TESTED:** ব্রাউজারে রেন্ডার হওয়া অ্যাডমিন UI (vite build/client bundle এই ২GB হোস্টে OOM)। এছাড়া লাইভ CPIC API ও লাইভ MCP সার্ভার এই সেশনে কল করা হয়নি (নেটওয়ার্ক-নির্ভর), তাই সেগুলো `NOT TESTED` হিসেবেই থাকল।
