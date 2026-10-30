import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * The agent's instructions are the safety boundary. Nothing in the code can stop
 * the model from reassuring someone whose symptom is a stroke, agreeing to a
 * second prescription, or quoting a study that does not exist — only the prompt
 * can. That makes these lines exactly as load-bearing as a test, and an
 * instructions edit that quietly drops one is invisible to every other suite in
 * the repository.
 *
 * These assertions are deliberately about the *presence of a rule*, not its
 * prose, so that rewording the file does not break them and deleting a rule
 * does.
 */
const instructions = readFileSync(resolve(__dirname, '../../agent/instructions.md'), 'utf8');

describe('agent instructions — safety rules that must survive editing', () => {
  it('holds the line between research and clinical care', () => {
    expect(instructions).toMatch(
      /You do not\s+prescribe, start, stop, or set or change an individual's dose/i,
    );
    /** A differential is reasoning shown to the user, not a verdict on them. */
    expect(instructions).toMatch(/never as a diagnosis/i);
    /** Bystander first aid and a person's own rescue medicine are the two
     *  exceptions, and each has to stay written down or the model resolves the
     *  conflict in whichever direction it guesses. */
    expect(instructions).toMatch(/Two things are\s+not prescribing/i);
    expect(instructions).toMatch(/\*\*First aid\.\*\*/);
    expect(instructions).toMatch(/A rescue medicine already prescribed to this person/i);
  });

  it('treats a bare referral as a failed reply', () => {
    expect(instructions).toMatch(
      /only says "consult a\s+doctor" or "go to the hospital" is a failed reply/i,
    );
    expect(instructions).toMatch(/Never reply with only questions/i);
  });

  it('identifies the system as an AI', () => {
    expect(instructions).toMatch(/You are an AI, and you say so plainly if asked/);
  });

  it('treats underestimating urgency as the more dangerous error', () => {
    expect(instructions).toMatch(/Underestimating urgency is the dangerous error/i);
    expect(instructions).toMatch(/When you cannot tell, give the higher urgency/i);
    /** The sentence that ends a conversation before the illness does. */
    expect(instructions).toMatch(/Never close with reassurance you have not earned/i);
    expect(instructions).toMatch(/Say how long they have/i);
  });

  it('holds position under repeated or socially-backed pressure', () => {
    expect(instructions).toMatch(/Asking again does not change what the evidence says/i);
    expect(instructions).toMatch(/Someone speaking for the user is still the user/i);
    expect(instructions).toMatch(/Verify any study the user quotes/i);
  });

  it('refuses the retired FDA pregnancy letter categories', () => {
    expect(instructions).toMatch(/Never report an FDA pregnancy letter category/i);
    expect(instructions).toMatch(/Pregnancy and Lactation Labeling Rule/i);
  });

  it('offers the emotional-support line on every mention of self-harm', () => {
    expect(instructions).toMatch(/Whenever self-harm comes up, offer the Kaan Pete Roi/i);
  });

  it('leaves urgency to the model, with no keyword screen or triage tool', () => {
    expect(instructions).toMatch(
      /No tool, keyword list or pattern decides whether a situation is urgent/i,
    );
    expect(instructions).toMatch(/A single word is never\s+enough/i);
    expect(instructions).not.toMatch(/emergency_triage_check/);
  });

  it('has no scripted emergency-call line and gives the help itself', () => {
    /** Calling services is the user's decision; the agent's job is the medical
     *  help. No fixed opener, alarm emoji or emergency number is scripted. */
    expect(instructions).not.toMatch(/999|৯৯৯|🚨/);
    expect(instructions).not.toMatch(/call emergency services/i);
    expect(instructions).toMatch(
      /Do not tell the user to phone an emergency or\s+ambulance number/i,
    );
    expect(instructions).toMatch(
      /There is no fixed opening line, no alarm emoji and no scripted\s+sentence/i,
    );
    expect(instructions).toMatch(/Open with the first thing to do right now/i);
    /** A doctor still says plainly when hospital care is needed. */
    expect(instructions).toMatch(
      /When\s+a person needs hospital or urgent in-person care, say so plainly/i,
    );
    /** A definition question is information, not an emergency. */
    expect(instructions).toMatch(
      /\(a definition, education, general knowledge\): a normal informative answer/i,
    );
  });

  it('writes out the danger signs when it is not urgent', () => {
    expect(instructions).toMatch(/with the danger signs\s+that would make it urgent/i);
  });

  it('keeps clinical facts out of memory and personal facts out of databases', () => {
    expect(instructions).toMatch(/never look a clinical fact up in memory/i);
    expect(instructions).toMatch(/never look a personal fact up\s+in a database/i);
  });

  it('does not let a breastfeeding summary become a clearance', () => {
    /** LactMed answers about a substance, and the person deciding is a mother
     *  weighing her own infant. "Compatible with breastfeeding" read as "safe
     *  for my baby" is the failure this rule exists to prevent. */
    expect(instructions).toMatch(/"Compatible with breastfeeding" is not "safe for this baby\."/i);
    expect(instructions).toMatch(/look up each active ingredient/i);
  });

  it('will only name a source it actually read', () => {
    expect(instructions).toMatch(/Do not\s+cite a source you did not read in this conversation/i);
    expect(instructions).toMatch(/never fill the gap from\s+memory/i);
  });
});

describe('agent instructions — no rule may contradict another', () => {
  it('does not claim the full text is unreachable when read_full_text exists', () => {
    /** A stale "these tools cannot reach the full text" tells the model to
     *  refuse work it can do, and reads as authoritative while being wrong. */
    expect(instructions).not.toMatch(/full text, which these tools cannot reach/i);
    expect(instructions).toMatch(/read it with `read_full_text`/i);
  });

  it('does not tell the agent to apply a label to a specific person', () => {
    /** The tool notices are injected into context alongside these
     *  instructions, so a notice that says "apply it to the patient in front of
     *  you" contradicts the one rule with no exception. */
    expect(instructions).not.toMatch(/apply (it|label text) to the (specific )?patient/i);
  });
});

describe('agent instructions — bystander playbook matches current guidance', () => {
  it('scales compression depth to the patient, not the adult default', () => {
    /** One adult number applied to an infant under-compresses, and the
     *  guidance is one third of chest depth at every age. */
    expect(instructions).toMatch(/one third of the depth of their\s+chest/i);
    expect(instructions).toMatch(/4 cm\s+in an infant under 1/i);
  });

  it('acts on anaphylaxis without requiring a rash', () => {
    /** Skin signs are absent in 10-20% of anaphylaxis, most often in the
     *  fatal cases; a hives-first trigger list misses exactly those. */
    expect(instructions).toMatch(/no rash is needed to act/i);
    expect(instructions).not.toMatch(/\(hives plus breathing difficulty/i);
  });

  it('defers to the device label for the epinephrine hold time', () => {
    /** 3 seconds is right for EpiPen/Jext/Anapen and wrong for injectors
     *  labelled to be held while counting to ten. */
    expect(instructions).toMatch(/time printed on that\s+device's own\s+label/i);
    expect(instructions).toMatch(/counting slowly to\s+ten/i);
  });

  it('does not let an anaphylaxis casualty stand up', () => {
    expect(instructions).toMatch(/do \*\*not\*\* let them stand up or sit up/i);
  });

  it('relies on last-known-well for stroke and does not elevate the head', () => {
    /** No major guideline recommends raising the head, and elevating an
     *  unconscious or vomiting casualty raises aspiration risk. */
    expect(instructions).toMatch(/time\s+they were last known well/i);
    expect(instructions).not.toMatch(/head slightly raised/i);
  });
});
