# Domain Concepts

## PLE vs PLE — the same thing, two names

The CREC082 protocol says **PLE** (Professional Learning Episode). The code says **PLE** (Continuous
Learning Episode) everywhere: tables, routes, components, `ple_id`. They are the same unit of
analysis.

**Do not rename the code.** A PLE→PLE rename has already been done once in this repo and it left FK
constraints named `ples_*`, which broke a PostgREST embed hint and took `/admin/ples` down in
production with admins seeing zero PLEs. The gain would be cosmetic; the risk is not.

Instead: **use PLE in every CREC-facing artefact** (documents, exports, correspondence with the
ethics committee) and PLE in the code. `ples.ple_code` renders as `PLE-001`; if the committee wants
`PLE-001` in an export, map it at the export boundary, not in the schema.

| Term | Meaning |
|------|---------|
| **PLE** / **PLE** | One physician–AI dialogue session, the unit of analysis. `PLE` in code, `PLE` in the protocol — see above |
| **PIS-7** | 7-domain scoring rubric (0–5 per domain) used to evaluate physician reasoning quality in a PLE |
| **RIMPL** | On-premise middleware: pre-filters prompts, strips PII, injects anti-sycophancy + ELM signals |
| **SBMA** | Score Behavior Matching Algorithm — matches PLE patterns to scoring profiles |
| **ICC** | Intraclass Correlation Coefficient — primary metric for AI vs. expert-auditor agreement (target ≥ 0.75) |
| **LPDP** | Longitudinal Professional Development Profile — per-physician score trajectory chart |
| **C1–C7** | Screening criteria. C1–C3 are recorded metadata; **C4–C7 decide** whether the session qualifies — see below |
| **Credit Engine** | Converts validated PLE scores into CPD credit units |
| **Pilot Study** | The CREC082 study: 75 physicians × 3 PLEs = 225 evaluable PLEs. **Not yet started** — see below |
| **sandbox round** | The internal blinded test cohort (SBX-*). Test data, never participant data — see below |
| **`cme-dev`** | The on-prem inference box, `100.68.210.69`, running Ollama. **The** local-model target |
| **`cme-dgx`** | A real inference host on `cme-dev`'s private LAN, **not reachable from the tailnet** — see below |
| **purpose** | What an AI call is *for* — `chat` / `evaluate` / `criteria` / `discuss` / `embed`. Routes name a purpose, never a vendor |
| **shadow evaluation** | A second PIS-7 score on the same transcript from a non-serving provider. Recorded, never shown, never credit-bearing |

## PIS-7 Domains (weights)

1. Clinical Question Intelligence (15%)
2. Reasoning Depth (20%)
3. Contextual Integration (15%)
4. Iterative Inquiry (15%)
5. Critical Appraisal (15%)
6. Reflective Synthesis (10%)
7. AI Literacy & Prompt Skill (10%)

Composite = Σ(domain × weight) × 20 → 0–100 (`backend/src/services/ple-gate.js`).

## Screening criteria (C1–C7)

CREC082 PLE Instruction Sheet §1 defines a qualifying episode by **four qualities**, not by length:
a meaningful problem, developing reasoning, integration of context/evidence, and reflective
synthesis — and explicitly *not* a short factual lookup, repeated questioning, or passive copying.

- **C4–C7 are the gate** (content, manual QA on fail; delegated to RIMPL `/evaluate-criteria`):
  C4 meaningful clinical question · C5 ≥ 2 developing follow-ups · **C7 context/evidence
  integration** · C6 reflective synthesis.
- **C1–C3 are METADATA, not a gate** (`computeTier1`): C1 duration ≥ 10 min · C2 turns ≥ 4 ·
  C3 tokens ≥ 10,000. They are computed and recorded on every session and decide nothing.

  Until 2026-08 they hard-failed a session at `ple_fail_t1` before it was ever scored, which
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

## Pilot Study vs sandbox round — do not conflate these

The **Pilot Study** is the CREC082 study: 75 physicians × 3 PLEs = **225 evaluable PLEs**, gated on
CREC approval, with data collection at month 3–4 *after* that approval. **It has not started.**

The **sandbox round** is the internal blinded test cohort — isolated SANDBOX council, `SBX-*` codes,
`is_test = true`. It ran through Aug–Sep 2026 and produced real transcripts and real scores, but they
are **test data and count toward nothing**.

Both have been called "the pilot" in conversation, and the conflation has already cost something
concrete: `LOCAL-MODEL-ROADMAP.md` opened with *"we are inside the pilot study window"*, concluded
that swapping the model would split the study cohort, and deferred the entire local-AI migration to
"after the pilot". There was no study cohort to split. The roadmap's phase order was inverted on
2026-08-27 once the two were told apart.

When it matters which one you mean, say **Pilot Study** or **sandbox round**. "The pilot" on its own
is ambiguous and has been wrong at least once.

A related trap: the 6 evaluated PLEs in the real TMC council with `is_test = false` are **neither** —
they are pre-approval development runs that were never labelled. See D3 in `docs/HANDOFF.md`.

## Local model — the boxes, and what "on-prem AI" does and does not claim

**`cme-dev` (`100.68.210.69`, Ollama) is the target** — and is the only box on the tailnet that can
be one. `cme-dgx` was named as the target throughout the early planning; it is real but unreachable from
the tailnet — see *`cme-dgx` is real, but not reachable* below. Say the hostname, not "the DGX".

Moving inference on-prem closes the **inference** leg: de-identification stops being the *sole*
barrier for AI processing and becomes defence-in-depth. It does **not** close the **storage** leg —
Supabase Postgres is in `ap-northeast-1` (Tokyo), and the backend reads raw transcripts from it.

> **"PII never leaves Thailand" is false** and must not appear in any CREC-facing document while
> storage is offshore. That is A3 (GDCC hosting), a separate and unresolved migration.

## Purpose

An AI call names a **purpose** — `chat`, `evaluate`, `criteria`, `discuss`, `embed` — never a vendor.
Each purpose resolves to a provider independently (`app_settings.ai_provider_<purpose>`), so a split
configuration is a legitimate end state rather than a half-finished migration. `evaluate` is guarded
separately: changing it takes a typed confirmation, and once `evaluator_locked_at` is set the change
is refused outright, because it is the instrument the ≥0.75 credit gate is defined against.

## Shadow evaluation

A second PIS-7 score produced on the **same** transcript by a provider that is *not* serving the
result. It is recorded in `shadow_evaluations` (RLS deny-all), never displayed, never credit-bearing,
and sheds rather than queues when the provider is busy — a shadow bug or backlog must never cost a
physician their credit.

Its purpose is paired comparison: local-vs-Claude on identical inputs, out of normal operation. It
survives the evaluator lock by design, so calibration evidence keeps accumulating after the
configuration is frozen. **It must be disclosed in the Model Lock Record** — an undisclosed second
scoring system is exactly what §10.2 exists to rule out.

> Note: **SBMA** and the **Credit Engine** are domain concepts in the spec but are **not yet implemented** in code. ICC and PIS-7 composite scoring **are** implemented.

## `cme-dgx` is real, but not reachable

**Corrected 2026-09-04.** This section previously said the box "does not exist". It does. Open WebUI's
Connections panel on `cme-dev` lists `http://cme-dgx:8888/v1` as a configured upstream, alongside
`http://192.168.1.178:8000/v1` (`:8000` is the vLLM/SGLang default) and two Ollama hosts on the same
private `192.168.1.0/24`.

What the 2026-08-26 tailnet inventory actually established was narrower than the conclusion drawn from
it: `cme-dgx` is not a **tailnet node**. It sits on `cme-dev`'s LAN, which `cme-dev` does not advertise
as a subnet route (`PrimaryRoutes: None`), so nothing outside that LAN can address it — verified again
on 2026-09-04 by timeout to the IP and DNS failure on the hostname. The `100.119.96.52` address the early
planning documents attach to the name was never confirmed and should not be trusted.

The operational conclusion is unchanged: **`cme-dev` at `100.68.210.69` is the only box CLICS can reach**,
and it is where every model benchmark ran. What changes is the reason — it is the reachable *gateway*, not
the machine doing inference. The model is served by vLLM behind it (`system_fingerprint:
vllm-0.21.1rc1…-tp2`), proxied through Open WebUI.

Still true, and the reason this section exists: a measurement-bearing figure ("the DGX returned 400 …
exceeds the available context size (4096)") was attributed to a machine nobody had connected to. Any
statement of the form "measured on the DGX" should still be read as "measured through `cme-dev`".
