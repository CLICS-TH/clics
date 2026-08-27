# Domain Concepts

## PLE vs CLE — the same thing, two names

The CREC082 protocol says **PLE** (Professional Learning Episode). The code says **CLE** (Continuous
Learning Episode) everywhere: tables, routes, components, `cle_id`. They are the same unit of
analysis.

**Do not rename the code.** A PLE→CLE rename has already been done once in this repo and it left FK
constraints named `ples_*`, which broke a PostgREST embed hint and took `/admin/cles` down in
production with admins seeing zero CLEs. The gain would be cosmetic; the risk is not.

Instead: **use PLE in every CREC-facing artefact** (documents, exports, correspondence with the
ethics committee) and CLE in the code. `cles.cle_code` renders as `CLE-001`; if the committee wants
`PLE-001` in an export, map it at the export boundary, not in the schema.

| Term | Meaning |
|------|---------|
| **CLE** / **PLE** | One physician–AI dialogue session, the unit of analysis. `CLE` in code, `PLE` in the protocol — see above |
| **PIS-7** | 7-domain scoring rubric (0–5 per domain) used to evaluate physician reasoning quality in a CLE |
| **RIMPL** | On-premise middleware: pre-filters prompts, strips PII, injects anti-sycophancy + ELM signals |
| **SBMA** | Score Behavior Matching Algorithm — matches CLE patterns to scoring profiles |
| **ICC** | Intraclass Correlation Coefficient — primary metric for AI vs. expert-auditor agreement (target ≥ 0.75) |
| **LPDP** | Longitudinal Professional Development Profile — per-physician score trajectory chart |
| **C1–C7** | Screening criteria. C1–C3 are recorded metadata; **C4–C7 decide** whether the session qualifies — see below |
| **Credit Engine** | Converts validated CLE scores into CPD credit units |

## PIS-7 Domains (weights)

1. Clinical Question Intelligence (15%)
2. Reasoning Depth (20%)
3. Contextual Integration (15%)
4. Iterative Inquiry (15%)
5. Critical Appraisal (15%)
6. Reflective Synthesis (10%)
7. AI Literacy & Prompt Skill (10%)

Composite = Σ(domain × weight) × 20 → 0–100 (`backend/src/services/cle-gate.js`).

## Screening criteria (C1–C7)

CREC082 PLE Instruction Sheet §1 defines a qualifying episode by **four qualities**, not by length:
a meaningful problem, developing reasoning, integration of context/evidence, and reflective
synthesis — and explicitly *not* a short factual lookup, repeated questioning, or passive copying.

- **C4–C7 are the gate** (content, manual QA on fail; delegated to RIMPL `/evaluate-criteria`):
  C4 meaningful clinical question · C5 ≥ 2 developing follow-ups · **C7 context/evidence
  integration** · C6 reflective synthesis.
- **C1–C3 are METADATA, not a gate** (`computeTier1`): C1 duration ≥ 10 min · C2 turns ≥ 4 ·
  C3 tokens ≥ 10,000. They are computed and recorded on every session and decide nothing.

  Until 2026-08 they hard-failed a session at `cle_fail_t1` before it was ever scored, which
  rejected a concise but genuinely reflective episode while passing a rambling factual lookup — the
  wrong way round. **C2 keeps one job**: ≥ 4 physician turns is the threshold at which the Socratic
  rescue may open mid-session (§4). The only remaining hard stop is a session with no physician turn
  at all, which has nothing to classify.

## Socratic mode

A **rescue**, not an experimental arm (PLE Instruction Sheet §4, ICF §3). It may open MID-SESSION
after 4 physician–AI exchanges when the conversation still does not qualify or has gone off topic,
and asks 1–2 non-leading questions without giving a diagnosis. Nothing about which episode it is, or
who the physician is, may influence it — an earlier build allocated it by hashing the physician id,
which is a randomised trial arm and the opposite of what the protocol tells the committee.

## Reflection

Collected after every PLE (ICF §3 step 3) and **scored evidence, not a survey**: PIS-7 is assessed
on "transcript และ reflection", and D6's zero anchor is literally `0 ไม่มี reflection`. It is
therefore captured *before* screening — `/end` leaves the session at `ended` until it arrives or is
skipped — and reaches the evaluator as a `[REFLECTION]` turn.

> Note: **SBMA** and the **Credit Engine** are domain concepts in the spec but are **not yet implemented** in code. ICC and PIS-7 composite scoring **are** implemented.
