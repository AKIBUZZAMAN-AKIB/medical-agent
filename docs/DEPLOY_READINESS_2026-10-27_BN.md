# ডিপ্লয় রেডিনেস রিপোর্ট — ২৭ অক্টোবর ২০২৬

এই রিপোর্টের প্রতিটি দাবির পেছনে একটি executed command বা একটি log line আছে।
যা যাচাই করা যায়নি, তা **`NOT TESTED`** বা **`BLOCKED`** হিসেবে লেখা হয়েছে — অনুমান
করিনি।

---

## ১. পদ্ধতি

ডিপ্লয় ফাইলগুলো পড়ে নয়, **চালিয়ে** দেখা হয়েছে:

- সত্যিকারের `mongod` (v8.2.1) + `NODE_ENV=production` পরিবেশে `node api/server/index.js`
  বুট করা হয়েছে, `librechat.pure-doctor.yaml` দিয়ে।
- আসল `config/create-user.js` ও `config/seed-medical-agent.js` চালিয়ে ডেটাবেসে
  এজেন্ট বসানো হয়েছে।
- `config/verify-deployment.js` (নতুন) দিয়ে ১৫টি প্রি-ফ্লাইট চেক চালানো হয়েছে।
- nginx কনফিগ `nginx -t` দিয়ে সিনট্যাক্স-যাচাই করা হয়েছে।

Docker daemon এই স্যান্ডবক্সে নেই, তাই **`docker build` বা `docker compose up` চালানো
হয়নি**। Docker-সংক্রান্ত প্রতিটি সংশোধন ফাইল-বিশ্লেষণ এবং হোস্টে সেই একই ব্যর্থতার
পুনরুৎপাদনের ভিত্তিতে করা — নিচে প্রতিটির প্রমাণ দেওয়া আছে।

---

## ২. যা ভাঙা ছিল এবং ঠিক করা হয়েছে

### ২.১ কনফিগ ফাইল (সবচেয়ে বড়)

| সমস্যা | ফলাফল | প্রমাণ | অবস্থা |
| --- | --- | --- | --- |
| `version: 1.3.8`, কোডে `CONFIG_VERSION = '1.3.16'` | ভুল স্কিমায় ভ্যালিডেশন, প্রতি বুটে `Outdated Config version` | বুট লগ | ঠিক হয়েছে |
| `serverInstructions` অনুপস্থিত | ইমার্জেন্সি সেফটি প্রিম্পট মডেলের কাছে পৌঁছায় না | লগ: `Server Instructions: N/A` | ঠিক হয়েছে → এখন `configured (1203 chars)` |
| MCP arg আপেক্ষিক পথ | `api/` থেকে চালালে সার্ভারই সংযোগ করে না | `Cannot find module '/app/api/packages/...'` → ০টি টুল | ডকুমেন্টেড + টেস্টে লক করা |
| `baseURL: http://127.0.0.1:4120/v1` | কন্টেইনারের ভিতরে `127.0.0.1` মানে কন্টেইনার নিজেই → চ্যাট অচল | ফাইল-বিশ্লেষণ | এখন `${MEDICAL_LLM_BASE_URL}` (compose ডিফল্ট `host.docker.internal`) |

### ২.২ Docker image

- **`Dockerfile.multi`-তে `packages/mcp-medical/data` কপি হচ্ছিল না।** ৭৬২ KB-র
  BDDrugBank কর্পাস ছাড়া `bd_medicine_lookup` টুলটি ইমেজের ভিতরে
  `"BDDrugBank corpus archive ... was not found"` এরর দিত, অথচ ডেভেলপার মেশিনে নিখুঁত
  কাজ করত। প্রমাণ: `data/` সরিয়ে টুলটি চালিয়ে ঠিক এই এররটি পুনরুৎপাদন করা হয়েছে।
  → `COPY --from=mcp-medical-build .../data` যোগ হয়েছে।
- **`WORKDIR /app/api` + `CMD node server/index.js`।** সব আপেক্ষিক পথ (MCP এন্ট্রি,
  `medicalCommand.js`-এর কর্পাস পথ, `meiliLogger`-এর `/app/logs` সিলেকশন) ভুল জায়গায়
  রিজলভ হত। → `WORKDIR /app` + `node api/server/index.js`।
- **`.dockerignore`-এ `librechat*`** থাকায় ফর্কের কনফিগ কখনো ইমেজে ঢুকত না।
  → শুধু `librechat.pure-doctor.yaml`-এর জন্য negation যোগ করা হয়েছে (এতে কোনো সিক্রেট
  নেই; কী/URL রানটাইমে env থেকে আসে)।

### ২.৩ Compose

- `deploy-compose.yml` কেবল আপস্ট্রিম রেজিস্ট্রি ইমেজ চালাত — যেখানে medical
  প্যাকেজ, কর্পাস, সিড স্ক্রিপ্ট বা ফর্ক কনফিগের কিছুই নেই। অর্থাৎ ওই ফাইল দিয়ে ডিপ্লয়
  করলে **শূন্য মেডিকেল টুল**। → এখন `Dockerfile.multi` (`target: api-build`) থেকে বিল্ড।
- `./librechat.yaml` মাউন্ট করা হচ্ছিল, যেটি ফর্কে **নেই**। Docker তখন ওই পথে একটি খালি
  ডিরেক্টরি বানায়, YAML লোড ব্যর্থ হয়, আর অ্যাপ **কোনো কাস্টম কনফিগ ছাড়াই** চুপচাপ
  চালু হয়ে যায়। → `./librechat.pure-doctor.yaml` → `/app/librechat.yaml`।
- `SCHEDULES_SINGLE_PROCESS=true` ছাড়া শিডিউলার চালু হয় না, প্রতিটি schedule write
  503। এক রেপ্লিকা + Redis-হীন স্ট্যাকের জন্য এটি সঠিক মান → যোগ করা হয়েছে।
- api-র healthcheck ছিল না অথচ `client` `depends_on: api` — `condition: service_healthy`
  যোগ করা হয়েছে; mongodb/meilisearch-ও healthcheck-যুক্ত।
- `/health`, `/readyz` এন্ডপয়েন্টের অস্তিত্ব যাচাই করা হয়েছে (`api/server/index.js:321`)।
- `client/public/images`, `uploads` ডিরেক্টরি রিপোতে ছিল না (bind mount source missing)
  → `.gitkeep` সহ ট্র্যাক করা হয়েছে।

### ২.৪ প্রথম-রান অর্ডার (আগে কোথাও লেখা ছিল না)

1. `deploy-compose.yml` বুট।
2. **ADMIN ইউজার তৈরি** — `config/create-user.js ... --email-verified=true`।
   `--email-verified=true` ছাড়া স্ক্রিপ্টটি একটি y/N প্রম্পটে অনন্তকাল অপেক্ষা করে
   (TTY-হীন Docker-এ ঝুলে যায়)। এটা পরীক্ষায় ধরা পড়েছে।
3. `config/seed-medical-agent.js` — ADMIN ইউজার না থাকলে সিড নিজেই থেমে বলে:
   *"No ADMIN user exists yet, so the agent would have no owner."*

---

## ৩. যা এখন প্রমাণসহ কাজ করে

```
$ node api/server/index.js          # আসল mongod, production mode
[MCP][medical] Tools: emergency_triage_check, bd_medicine_lookup, … (33)
[MCP][medical] Server Instructions: configured (1203 chars)
[MCP] Initialized with 1 configured server and 33 tools.
Server readiness checks passing.
```

```
$ node config/seed-medical-agent.js --share-with-role=USER
agent "Super-Power Doctor AI" (agent_medical_research) is ready with 36 tool(s)
and 7 specialist sub-agent(s)
```

```
$ node config/verify-deployment.js
15 passed, 3 warning(s), 0 failure(s)
```

```
$ npx jest --config config/jest.config.js config/medical-deployment-config.spec.js
Tests: 27 passed, 27 total          (আগে ১৭)
$ (packages/mcp-medical) npx jest --ci
Tests: 157 passed, 157 total
$ npx eslint config/verify-deployment.js config/medical-deployment-config.spec.js
clean
$ nginx -t  (client/nginx.conf)
syntax is ok
```

`config/verify-deployment.js` হলো নতুন প্রি-ফ্লাইট: কনফিগ ভার্সন, MCP এন্ট্রি
রিজলভযোগ্যতা, `serverInstructions`, টুল সংখ্যা (৩৩), BD কর্পাস, JWT/CREDS সিক্রেট,
লেখার যোগ্য ডিরেক্টরি, MongoDB, সিড করা এজেন্ট + সাব-এজেন্ট, এবং চ্যাট এন্ডপয়েন্ট
`GET {baseURL}/models` — শেষটি `agent.json`-এর মডেলটি সত্যিই সার্ভ হচ্ছে কিনা তাও দেখে।
কোনো একটি FAIL হলে exit code 1।

---

## ৩.১ ব্রাউজার টেস্ট — এখন সত্যিই চালানো হয়েছে

আসল Chromium (Playwright) দিয়ে vite dev server + API-এর বিরুদ্ধে চালানো হয়েছে:

```
$ npm run verify-ui
18/18 checks passed
```

যা প্রমাণ হয়েছে: `/login` রেন্ডার হয় ও ফর্ম কাজ করে; `POST /api/auth/login` → 200 এবং
httpOnly `refreshToken` কুকি; `/api/models` কাস্টম এন্ডপয়েন্ট (OpenRouter (Free)) ও সিড
করা মডেল সার্ভ করে; `/c/new`-এ **Super-Power Doctor AI** বাংলা স্টার্টারসহ দেখা যায়;
`/admin` → *Medical Admin OS* লাইভ ডেটাসহ (২৪,৭২৫ ব্র্যান্ড, ৮ এজেন্ট, সার্ভিস হেলথ);
চারটি admin এন্ডপয়েন্ট 200; টুল সংখ্যা **৩৩**; এবং **ব্রাউজার কনসোলে কোনো এরর নেই**।

এই টেস্ট চালাতে গিয়ে আরও তিনটি আসল ত্রুটি ধরা পড়ে ও ঠিক করা হয়েছে:

1. **অ্যাডমিন কনসোল ৩২ টুল দেখাত, সার্ভার ৩৩ দিত।** টুল তালিকাটি
   `medicalCommand.js`-এ হাতে লেখা অ্যারে ছিল, ফলে `specialist_subagent_blueprint`
   কনসোলে অদৃশ্য থাকত। এখন তালিকা MCP সার্ভারের নিজের রেজিস্ট্রি থেকে আসে: বিল্ডে
   `packages/mcp-medical/scripts/emit-catalog.mjs` → `dist/tool-catalog.json`, আর
   কনসোল সেটিই পড়ে। হাতে লেখা কিছুই নেই; রঙ/বাংলা লেবেল আলাদা ম্যাপে।
2. **`GET /api/tags` প্রতি mount-এ 403।** `/api/tags` BOOKMARKS পারমিশনের পেছনে, অথচ
   ক্লায়েন্ট পারমিশন না দেখেই কোয়েরি চালাত। এখন কোয়েরি নিজেই পারমিশন দেখে চলে।
3. **`GET /api/convos/new/subagents` 404।** `useParentSubagentsQuery`-এর `enabled`
   গার্ডের পরে caller-এর `...config` স্প্রেড হয়ে গার্ডটি মুছে দিত, তাই নতুন চ্যাট পেজেও
   কোয়েরি চলত। এখন `enabled` সবশেষে হিসাব হয়।

## ৪. এখনও যা বাকি (সৎ তালিকা)

| আইটেম | অবস্থা |
| --- | --- |
| `docker build` / `docker compose up` | **NOT TESTED** — স্যান্ডবক্সে Docker নেই |
| রেন্ডার হওয়া UI (admin portal, login, chat) | **PASS** — `npm run verify-ui` 18/18 (vite dev server; production `vite build` এই বক্সে OOM) |
| লাইভ আপস্ট্রিম API (PubMed, openFDA, CPIC…) | **BLOCKED** — আউটবাউন্ড নেটওয়ার্ক নেই |
| ১৯-কেস LLM ইভ্যালুয়েশন | **NOT TESTED** — কোনো মডেল-এন্ডপয়েন্ট নেই |
| MongoDB অথেন্টিকেশন | ডিফল্টে বন্ধ (`--noauth`), পোর্ট পাবলিশ করা নেই — নেটওয়ার্ক প্রাইভেট থাকলে ঠিক, নইলে নয় |
| TLS | `client/nginx.conf`-এ শুধু HTTP; 443 পাবলিশ করা হয়নি। সামনে TLS টার্মিনেটর দরকার |
| ব্যাকআপ/রিস্টোর ড্রিল | **NOT TESTED** |
| মেডিকেল কমপ্লায়েন্স (HIPAA/GDPR) | কোনো দাবি নেই; টেস্টে কেবল সিন্থেটিক ডেটা |

বিস্তারিত প্রসিডিউর: `docs/DEPLOYMENT.md`।

---

## ৫. নিরাপত্তা

- রিপোতে কোনো সিক্রেট কমিট হয়নি। স্থানীয় `.env` (আনট্র্যাকড) বাদে কোথাও কী নেই।
- আগে চ্যাটে পেস্ট করা GitHub PAT-টি **রিভোক করা বাধ্যতামূলক**; সেটি কোনো ফাইলে লেখা হয়নি।
- মেডিকেল সেফটি সংক্রান্ত কোনো "প্রোডাকশন-রেডি" দাবি এই রিপোর্টে নেই — ইমার্জেন্সি
  স্ক্রিন মডেল-ইনভোকড, অর্থাৎ মডেল টুলটি না ডাকলে কোনো ডিটারমিনিস্টিক চেক চলে না।
