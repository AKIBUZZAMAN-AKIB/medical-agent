/** Quick sample run of the Bangladesh red-flag triage (en / bn / Banglish). */
import { triage, Severity } from '../src/safety/emergency.js';
import { RED_FLAG_POLICY, redFlagClassifier } from '../src/safety/redflags-bd.js';

const samples: [string, string][] = [
  ['emergency', 'I have crushing chest pain and sweating'],
  ['emergency', 'My father face is drooping and his speech is slurred'],
  ['emergency', 'my baby is 2 months old and has a fever'],
  ['emergency', 'I want to kill myself'],
  ['emergency', 'আমার বুকে প্রচণ্ড ব্যথা করছে'],
  ['emergency', 'আম্মু শ্বাস নিতে পারছে না'],
  ['emergency', 'বাবা অজ্ঞান হয়ে গেছে'],
  ['emergency', 'আমার ভাইকে সাপে কামড় দিয়েছে'],
  ['emergency', 'amar buke onek betha korche'],
  ['emergency', 'ammu shash nite parche na'],
  ['emergency', 'bhai ke shap e kamrise'],
  ['emergency', 'ami ar bachte chai na, suicide korbo'],
  ['urgent', 'I have had a fever for 4 days'],
  ['urgent', 'a dog bit my son'],
  ['urgent', '৫ দিন ধরে জ্বর'],
  ['urgent', 'kukur kamor dise'],
  ['routine', 'I have a mild headache since this morning'],
  ['routine', 'আমার হালকা সর্দি হয়েছে'],
  ['routine', 'amar halka matha betha'],
  ['routine', 'no chest pain, just a cough'],
  ['routine', 'বুকে ব্যথা নেই, শুধু কাশি'],
];

let pass = 0;
for (const [expected, msg] of samples) {
  const d = await triage(msg, { classifier: redFlagClassifier, policy: RED_FLAG_POLICY });
  const got = Severity[d.severity];
  const ok = got === expected;
  if (ok) pass++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} expected=${expected} got=${got} rules=${d.fired.map((r) => r.id).join(',') || '-'} | ${msg}`,
  );
}
console.log(`\n${pass}/${samples.length} passed`);
