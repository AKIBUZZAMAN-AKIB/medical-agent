# Behavioural evaluation

`npx jest` proves the agent's instructions *contain* the safety rules.
`instructions.spec.ts` proves they have not been quietly deleted. Neither can
tell you whether a model *follows* them — and a rule that is in the prompt and
ignored in the reply is not a rule.

This directory is the only thing in the repository that measures the reply.

## What it is

`cases.mjs` holds adversarial conversations. Each case is a short multi-turn
script with assertions on the final reply, and every case corresponds to a
failure mode that was **measured in published evaluation of models doing this
job**, not invented:

| Risk class | Evidence it is real |
| --- | --- |
| `sycophancy` | Acquiescence to unindicated care ranged 0%–100% across 19 models, uncorrelated with model scale (SycoEval-EM); models drift toward unsafe agreement over five turns of pressure (MedPRESS). |
| `under-triage` | Consumer health AI under-triages true emergencies at ~51.6% while over-triaging routine cases at ~64.8% (Ramaswamy et al., *Nature Medicine* 2026). The two errors are not equivalent. |
| `safety-net` | Suicide-risk alerts "appeared inconsistently, including failing to appear when patients described plans for self-harm." |
| `retired-convention` | FDA pregnancy letter categories were removed effective 30 June 2015 and remain in wide circulation. |
| `first-aid` | Skin signs are absent in 10–20% of anaphylaxis, most often in the fatal cases (WAO 2020; *Resuscitation* 2022). |
| `over-refusal` | A safety prompt that grows without bound produces a safe and useless agent. The instructions say "a wall of refusal helps nobody"; these cases are what keeps that true. |

## Running it

```bash
MEDICAL_EVAL_API_KEY=... \
MEDICAL_EVAL_MODEL=gpt-4o \
node packages/mcp-medical/eval/run.mjs

# One risk class, while iterating on a rule:
MEDICAL_EVAL_GROUPS=sycophancy,under-triage node packages/mcp-medical/eval/run.mjs
```

`MEDICAL_EVAL_BASE_URL` points it at any OpenAI-compatible endpoint.
`npm run eval --workspace @librechat/mcp-medical` is the same thing.

Exit code is 0 only when every case passes, so it works as a gate.

## What it does not do, and why that is deliberate

**Tools are not wired in.** The tools' own behaviour is covered by the unit
suite and by `scripts/smoke.mjs` against the live upstreams. What is under test
here is the reply text, and a case that needs a live lookup asserts the honest
fallback — the agent saying what it can and deferring what it cannot. The
fabricated-citation case is the clearest example: with no search available, the
only correct behaviour is to decline to rely on the paper, and that is exactly
what it asserts.

**There is no LLM judge.** Assertions are regexes on required, forbidden and
ordered patterns. This is brittle in one direction and honest in the other: it
cannot credit a good answer that words an unexpected phrase, and it will not
grade a harmful reply as acceptable because a judge model was feeling generous.

**The `ordered` assertions are the interesting ones.** An emergency that mentions
911 in its last sentence satisfies `includes: [/\b911\b/]`. `ordered: [[/\b911\b/,
/because/]]` fails it, because the number has to come *before* the explanation
to be useful to the person reading it.

## Interpreting the result

A failure is not automatically a defect in the instructions. It can be the model,
the model version, or an assertion that turned out to match the wrong thing. Read
the printed reply before changing a rule — the failure output exists so that
diagnosis does not start from the assertion.
