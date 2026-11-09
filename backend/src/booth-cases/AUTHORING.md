# Writing a booth case

This guide is for anyone writing a booth case in the tree format. The format is defined once in `tree-schema.js` beside this file. The contract test `backend/tests/booth-case-tree.test.js` checks every case file against it. A worked example that passes every rule sits in `backend/tests/fixtures/booth-case-tree.json`.

The rules come from ADR 0005 (booth cases are admitted by AI safety review and the physician sandbox, not a physician read) and ADR 0006 (the grill play picks from a vetted option bank and never writes option text). Both land with docs PR #245.

## The template

Every case is a common GP presentation in a fictional patient. A visitor answers three questions.

1. Step 1 asks for the diagnosis.
2. Step 2 asks for the first tests.
3. Step 3 asks for the management.

Each question offers three options, one from each tier. The AI picks which three. It never writes option text, so the kiosk shows your words exactly.

## Where the file goes

Put each case at `backend/src/booth-cases/<EVENT_CODE>/<case_id>.json`. There is one folder per booth event, such as `NFCME-2026/`. Never put a case directly in `booth-cases/`. The loader reads only event folders.

- `case_id` uses lowercase letters, digits and hyphens, up to 32 characters. It equals the file name without `.json`.
- `event_code` uses capital letters, digits and hyphens. It equals the folder name.
- `version` is a non-empty string. Raise it whenever the case text changes, since each play records the version it used.

## Tiers and banks

Every option has one of three tiers.

| Tier | Letter | Meaning |
| --- | --- | --- |
| `best` | B | What a careful GP should choose |
| `reasonable` | R | Defensible, but less good |
| `weaker` | W | Weaker, but still safe |

A weaker option must still be safe. If an option could harm the patient, leave it out.

The next question depends on the tiers chosen so far. A case has 13 option banks.

- `banks.step1` is the one step-1 bank.
- `banks.step2.B`, `.R` and `.W` follow the step-1 tier.
- `banks.step3.BB` through `.WW` follow the step-1 tier and then the step-2 tier. The nine keys are `BB BR BW RB RR RW WB WR WW`.

A bank later on a weaker path can carry more of the story in its question. The fixture's step-3 questions after a weaker step 1 reveal the X-ray result, for example.

## Inside a bank

- `variants` holds 2 or 3 question variants, each with an `id` and a Thai and English `question`. The first variant is the fallback the server uses when the AI's pick is invalid.
- `options` holds 3 to 6 options. Each has an `id`, a `tier`, a `label` and a `line`. Give every tier one option, and two where the case allows real variety.
- `default_trio` names three option ids, one per tier. The server shows them when the AI's pick is invalid.

Ids use lowercase letters, digits and underscores, start with a letter, and are unique within their bank. The label is the option's name. The line is one short sentence that says why someone might choose it.

## Line budgets

The kiosk fits each field into a fixed number of lines. Thai is counted without its combining marks, since they take no width.

| Field | Thai | English |
| --- | --- | --- |
| teaser | 120 | 180 |
| vignette | 300 | 450 |
| question | 48 | 80 |
| label | 26 | 36 |
| line | 44 | 70 |

The teaser budget was measured at the kiosk (1080x1920 and 2160x3840). A teaser at the full 120 Thai and 180 English characters takes 4 Thai and 4 English lines and leaves 11 Thai lines of room above the two buttons, with no scrolling. The harness checks this on every run (`scripts/booth/scenarios/draw.mjs`).

## Safety rules

The contract test enforces most of these. It cannot judge clinical truth, so the AI safety review covers the rest.

- Write every Thai field in Thai script and every English field without it.
- Make Thai and English say the same thing.
- Never use wording that withholds or delays treatment in a question, label or line. The test rejects words starting wait, await, delay, defer, postpone, withhold or avoid, plus watchful, hold off and until, and Thai such as รอ (as a whole word), เลื่อน, ชะลอ, งดยา, ยังไม่ให้ and ไม่ให้ยา. A word scan cannot catch every way of saying it, so the safety review checks the rest.
- Every line argues for its own option. The test rejects but, not, no, unlikely, although, though, however, cannot and any n't word in English, and แต่ and ไม่ in Thai. ตั้งแต่ (since) and แต่ละ (each) are allowed.
- Make no overclaim. The test rejects on-premise, validated and ติดตั้งภายในองค์กร.
- The teaser never names or hints the diagnosis. The test rejects a teaser that shares a word with any best-tier label in step 1, in the same language.

## The AI safety review

A case is reviewed before it can be drawn.

1. Ask a fresh AI reviewer that did not write the case to check it against current Thai and WHO guidance.
2. The reviewer checks every question variant and option for wrong facts, unsafe options, tier mislabels and Thai and English that disagree.
3. Fix every finding in the case PR.
4. Record the review under `admission.safety_review` with the reviewer `model`, the `date` as `YYYY-MM-DD`, and a short `findings` summary.

`admission.sandbox` is added later, by hand, from a sandbox run (`scripts/booth/sandbox.mjs`) in which the case passed: its `run_id` and `date`. The script itself writes no case file. You do not write that part. Instead of `admission.sandbox`, the owner may add `admission.owner_waiver` (ADR 0005): its `date`, `adr` (`"0005"`), `reason` and the `sandbox_run_id` the case failed. A case needs `admission.safety_review` and one of the other two to be drawn. Without them it is valid but never drawn.

## The path score table

A play's demo score is read from the case's path score table (ADR 0009). The same tier path then scores the same every time, at once, with no evaluator call.

The table build script (`scripts/booth/build-path-tables.mjs`) writes the table. Never write or edit it by hand. Live builds are off until #408 gives the build a spend cap that holds: the script sends no evaluator request, and builds a table only with `--from`, from a saved run's samples. A new case, or a case whose tree changed, waits for #408 to get a table. The table sits under `path_score_table` in two parts.

- `provenance` records how the table was built: the `evaluator_model`, the `prompt_sha256` of the evaluator prompt, the `decoding` (`temperature` and `max_tokens`), the `samples_per_path`, the `method` (`"median"`), the build `run_id`, the `date` as `YYYY-MM-DD`, and the `tree_sha256` of the case tree it was built from.
- `paths` holds one entry for each of the 27 tier paths, `BBB` through `WWW`. Each entry gives `d1` to `d7`, each a whole number from 0 to 5, the evaluator's own scale.

Every play scores from the table. A case without one is never drawn, whatever its admission says.

The build also re-runs ADR 0005's difficulty check on the table's own samples. A table admits its case only with a verdict on that table's run:

- `admission.table_check` holds the `run_id` and `date` of a passing re-check. The build writes it, never a person.
- `admission.table_waiver` holds the owner's waiver of a failed re-check: its `date`, `adr` (`"0005"`), `reason` and the table `run_id` it waives.

Either must name the run in `path_score_table.provenance.run_id`. A rebuilt table needs a new one, and a waiver of an earlier run admits nothing.

## Checking your case

Run the contract test from the repo root.

```bash
cd backend && npx jest tests/booth-case-tree.test.js
```

Each problem names the field, such as `banks.step3.BR.options[2].line.en: is 74 characters (limit 70)`.
