# Local-Model Roadmap — เชื่อม CLICS กับ on-prem LLM

Plan for moving CLICS's AI calls from the Anthropic cloud API to a self-hosted model on the
`cme8.org.github` Tailscale network (**`cme-dev`, `100.68.210.69`**, running Ollama).

**Author date:** 2026-08-24. **Rewritten:** 2026-08-27, after the CREC082 conformance work.
**Revised:** 2026-08-28 — the target box, the phase status, and eleven new decisions.

---

## What changed on 2026-08-27, and why the phase order inverted

The first version of this document opened with a timing constraint: *"We are inside the pilot study
window… swapping the model mid-pilot would split the cohort… therefore build during the pilot and cut
over at a clean boundary, target Oct 2026."*

**Two of that argument's three load-bearing claims are no longer true.**

1. **The Pilot Study has not started.** CREC082 puts data collection at **month 3–4 after CREC
   approval**, and approval has not happened. The Aug–Sep 2026 activity that looked like a pilot is
   the internal **sandbox round** — test data, not participant data. The two were conflated; see the
   *Pilot Study* entry in [domain-concepts.md](domain-concepts.md). There is no cohort to split.
2. **The Socratic CLE1/2/3 experiment no longer exists.** The A1 conformance work deleted the
   randomised arm outright — CREC082 §4 calls Socratic *"a standardized rescue, not an experimental
   arm."* The "changing the model mid-experiment confounds it" argument has no referent.

The third claim — §10.2 requires a locked model + prompt + rubric per evaluation — is still true, and
now argues the *opposite* way. If the evaluator is locked before participant 1, then locking it to
Claude means the local model cannot be the study's evaluator at all: A2 would be decided by inaction.

> **Therefore: get local production-ready BEFORE the Pilot Study, not after it.** All 225 PLEs are
> then scored by one locked configuration and §10.2 provenance is clean from the first row. Cutting
> over *mid-study* is the thing to avoid. Cutting over *before* it is free.

---

See [`LOCAL-MODEL-CUTOVER.md`](LOCAL-MODEL-CUTOVER.md) for the critical path, the paired-PLE
arithmetic behind the decisive gate, and how to compute the slip once an access date exists.
Live position: `npm run local-model:status`.

## Status

| Phase | State |
|---|---|
| **G0 — Access + inventory** | **done 2026-08-31.** `cme-dev` reachable over the tailnet; Open WebUI's OpenAI-compatible endpoint serves `deepseek-v4-flash-dspark`. Still owed from the box owner: weights checksum / engine / quantisation for the Model Lock, and custody (§5 of [GATE0-DGX-RESULTS](GATE0-DGX-RESULTS.md)) |
| **P0 — Probe** | **run 2026-08-31 → 09-01, Gate 0 PASSED.** JSON contract 25/26, Thai 6/6, ≥22,804 input tokens verified; eval p50 68 s; safe concurrency 2. Head-to-head vs Sonnet on 26 PLEs: ICC(A,1) 0.594 (on the unweighted d1–d7 sum — note, 2026-10-02: GATE0 §7.2), and **the evaluator is not reproducible on either model** (same fixture, Σ\|Δ\| 0–8 across sessions). Full numbers: [GATE0-DGX-RESULTS §7](GATE0-DGX-RESULTS.md) |
| **P1 — Provider adapter** | **done**, shipped dark (PR #61) |
| **P1.5 — Readiness gate** | **done** (#71). A switch to a provider that cannot serve is refused with the measured value; unknown counts as unfit |
| **P2 — rimpl relocation + bridge** | **not started, but unblocked** — G0 item 4 answered yes 2026-09-05 |
| **G0.5 — Human-auditor ICC baseline** | **not started. This is still the programme go/no-go** |
| **P3 — Migrate purposes** | shadow evaluator code **done** (PR #65). **Capacity layer built 2026-09-02** on `feat/local-ai-capacity` (commits `ddbba2a` backend/db/portal, `afb83d5` rimpl, `1fe625c` dashboard, `6050e53` smoke, `aecb861` mutations): durable evaluation queue, rimpl two-lane bounded runner, token-denominated budgets, transcript cap, council partition, dev-only provider override, sandbox smoke. **Deployed** — PR #83, 2026-09-03; `db/migration-local-ai-capacity.sql` applied 2026-09-02 and `migration-shadow-evaluations.sql` on 2026-08-28. Re-verified against production 2026-09-07: `shadow_evaluations` exists, `ples.eval_enqueued_at` exists, `app_settings.eval_drain_concurrency` is seeded |
| **P4 — Calibrate + Gate 4** | **instrument done** (#74). **Held-out split reserved first** (D13; `scripts/probe/SPLIT.json`, 8 held-out / 18 tuning, commit `551df47`) and `scripts/probe/screening-verdict.mjs` applies D18 + repeatability + parseability from the production ICC code (`c4bd08d`). Adaptive self-consistency **built** (rimpl `services/consistency.js`; `EVAL_CONSISTENCY=adaptive`, local arm only, billed = call 1, `provenance.consistency`). The local prompt addendum is **written and shipped** (`PIS7_LOCAL_ADDENDUM`, `rimpl/src/lib/prompts.js:231`), the E2 tuning loop **ran**, and the held-out gate was **spent 2026-09-04**: ICC 0.436 (0.000–0.873), n=8, verdict `insufficient` (`scripts/calibration/prompt-versions.md:141`). The decisive gate is still blocked on G0.5 |
| **P5 — Model Lock** | **mechanism done** (#75): the declaration form is closed until the decisive verdict passes, and the freeze is enforced. Blocked on P4 for the verdict that opens it |

Nothing is live in production. Every purpose still resolves to `anthropic` (`openai` for embeddings), so
with the toggles untouched every call goes to the cloud and no shadow evaluation runs. What changed on
2026-09-02 is the *shape*: the code now assumes a slow, shared, bounded model, whichever provider serves.

### The capacity layer (2026-09-02) — what "all purposes local" needs to survive many physicians at once

Measured on the box: eval p50 68 s; p95 114 s at 2 concurrent, 154 s at 4 (over the 150 s timeout);
identical work took 57 s and 956 s two hours apart (the box is shared). Decisions taken 2026-09-01
(plan `synthetic-strolling-kettle`): async submit with a real *queued → scoring* state; usage ceiling in
**tokens** (local is priced $0, so the $0.50 cap never throttled); transcript cap **64k to trial**, ship
the measured value; **adaptive self-consistency + prompt retune, gate = D18**; all purposes local
including chat; smoke from a laptop stack on the tailnet against prod Supabase's SANDBOX council.

| Piece | Where | What it guarantees |
|---|---|---|
| Durable evaluation queue | backend `services/eval-drain.js`, `lib/eval-scope.js`, `db/migration-local-ai-capacity.sql` | the `ple_pass` row **is** the queue; `claim_ple_evaluations()` claims oldest-first under `FOR UPDATE SKIP LOCKED` with a lease; the drain is the **only** caller of rimpl `/evaluate` (finalize, approve, re-evaluate and the reconcile sweep only enqueue + kick). Deterministic errors flag for a human; transient ones back off (honouring `Retry-After`, ≤15 min); exhausted attempts flag with an audit event; nothing is dropped |
| Two-lane bounded runner | rimpl `providers/runtime.js`, `providers/local.js` | interactive lane (chat, criteria, discuss) with a reserved slot vs background lane (evaluate, shadow); bounded depth → `503 queue_full` + `Retry-After` instead of an unbounded wait; a closed client cancels its queued call; a proactive `413 transcript_too_large` backstop |
| Token budgets | backend `lib/usage.js`, reservation RPCs, superadmin settings | `budgetState()` compares $ **and** tokens; per-user overrides; org ceilings seed **0 = no cap** and are set from the capacity report, never by default |
| Transcript cap | backend `routes/ples.js` (`ples.context_tokens`), portal chat | the last context the model saw (rimpl's per-call figure), checked before any reservation → `403 transcript_limit_reached`; the portal warns at 80 % and locks the composer at the cap with **End still enabled** |
| Council partition | setting `eval_drain_exclude_councils` (prod), env `EVAL_DRAIN_ONLY_COUNCILS` (dev only, refused in prod) | a laptop drain scoring SANDBOX on the local model and the prod drain scoring everything else on Claude never touch the same row. Unknown codes fail **closed** (claim nothing) |
| Dev provider override | rimpl `PROVIDER_SETTINGS_SOURCE=env` (refused in prod) | the laptop routes every purpose to `local` without writing prod settings; `/health/deep` shows `routing.override: true` and the smoke refuses to run unless it does |
| Physician-visible states | portal `ple-result.html`, `ple-chat.js` | screening → queued (position, eta) → scoring, poll backoff to 30 s, a non-silent give-up card; `ai_busy` bubble that keeps the typed question |
| Sandbox smoke | `npm run smoke:local-ai` (`scripts/smoke/local-ai-sandbox-smoke.mjs`) | single / burst / cap / down / capacity scenarios; aborts unless the override, the partition and `pilot_test_mode` are visible; never targets a prod host, never flips a global setting, never prints transcript text or credentials |

Everything in the layer is built, **WP-E's prompt addendum** (`PIS7_LOCAL_ADDENDUM`, via `pis7PromptFor('local')`)
included: it was written, the E2 tuning loop ran against it, and the held-out gate has since been spent
(`scripts/calibration/prompt-versions.md`). It is no longer an empty seam. **Coupling to respect before `EVAL_CONSISTENCY=adaptive`
goes live:** adaptive issues 2–3 serial calls (plus up to 2 re-asks) through the background lane, so the backend's
`RIMPL_EVAL_TIMEOUT_MS` 480 s and `EVAL_LEASE_S` 600 s are sized for `eval_drain_concurrency = 1`; at N the calls of N
evaluations interleave and the last finishes at ≈3·N·T (T ≈ 70–115 s measured) — keep the drain at 1, or size the
timeouts at ≥ 3 × N × p95 first. Run 2026-09-02: the capacity probe ([GATE0 §8.1–8.2](GATE0-DGX-RESULTS.md)) and the sandbox smoke on a laptop stack
against prod's SANDBOX council — `single` PASS, `burst` n=5 FIFO + exactly-once verified from the database
(see [HANDOFF](HANDOFF.md)). Migrations applied to prod the same day.

**Cutover is a toggle, not a deploy.** Since 2026-08-26 the provider for each purpose is a superadmin
setting (`app_settings.ai_provider_<purpose>`, *Admin → Overview*), layered over the env chain below
and audit-logged on every change. `evaluate` is guarded separately: it takes a typed confirmation
(`CHANGE EVALUATOR`), and once `evaluator_locked_at` is set the backend **refuses** the change
outright rather than warning about it — see §10.2's locked-configuration requirement.

---

## Decisions of record

Settled 2026-08-27. Each of these was a real fork; they are recorded so a later reader does not
reopen them by accident.

| # | Decision | Why |
|---|---|---|
| **D1** | **Local-ready before the Pilot Study** | The confound that justified waiting is gone (above) |
| **D2** | ~~Target box is **`cme-dgx`** (100.119.96.52)~~ → **superseded 2026-08-28: the target is `cme-dev` (100.68.210.69)** | A tailnet inventory on 26 Aug found three machines and **no `cme-dgx`**. **Corrected 2026-09-04:** `cme-dgx` is real — it sits on `cme-dev`'s LAN (`cme-dgx:8888`), which is not advertised as a subnet route, so it is unreachable from the tailnet. The decision is unchanged (`cme-dev` is still the only reachable target and where every benchmark ran) but the reason is narrower: it is the reachable *gateway*, with vLLM serving from behind it. Read any earlier "measured on the DGX" as "measured through `cme-dev`" |
| **D3** | **rimpl moves on-prem** onto a tailnet node; backend stays on Railway | rimpl *is* the on-premise layer by definition; this makes deployment match the architecture instead of contradicting it |
| **D4** | The **human-auditor ICC baseline is in scope**, as Gate 0.5 | Without it, Gate 4 compares the local model against a number that has never measured the thing the gate is about |
| **D5** | **Amend the Model Lock Record** to name what the box actually serves | A document naming a model that is not there proves nothing. Changing the box to satisfy the paper is the tail wagging the dog |
| **D6** | Apply the shadow migration once local is reachable; shadow is the **paired** Gate 4 instrument | Paired scores on the *same* transcripts beat two independent rescore runs, and it removes the "did the harness reproduce the baseline?" step |
| **D7** | **Accept** the Railway→on-prem raw-PII hop, over Tailscale | See *The PII hop* below. A3 (full on-prem) stays a separate migration |
| **D8** | On pass → **all purposes local** | |
| **D9** | ~~Gate 4 is **ICC ≥ 0.75 absolute**~~ → **refined 2026-08-28 into two stages** (D18) | The threshold is unchanged; what changed is that one number now answers two different questions, and a confidence interval decides rather than a point estimate |
| **D10** | On fail → **retune and re-gate** | The v1 calibration rules were fitted to *Claude's* failure mode; a different model deserves one honest correction |
| **D11** | Lock before participant 1; shadow runs throughout; **disclose the shadow evaluator in the Lock Record** | Otherwise a second scoring system later looks undisclosed |
| **D12** | RAG corpus population is **out of scope**; record retrieval as **inert** in the Lock Record | Otherwise §10.2 describes a RAG-enabled system that does not exist |
| **D13** | Retune freely, but **reserve a held-out cohort before the first tuning run**; the gate run uses only that | A cap on cycles is a proxy; the thing that matters is that the gate run is not the tuning run |
| **D14** | Gate 0.5 is **go/no-go for the whole programme**, surfaced the moment it is measured | |
| **D15** | Change-control commitment **plus** code detection for model drift | A commitment is necessary and not sufficient — good-faith ops changes are exactly the ones nobody thinks to announce |


### Settled 2026-08-28

These came out of a second design pass held after the revised CREC submission set was read in full.
The set changed the standing of the whole programme: it declares **local open-weight AI and no
commercial external AI/API for research transcripts**, in four separate attachments and in the
instruction sheet a physician reads before consenting. Moving on-prem is therefore a **precondition
for participant 1**, not an optimisation, and no fallback that runs the study on a cloud API exists.

| # | Decision | Why |
|---|---|---|
| **D16** | **GDCC hosting is parked**, not resolved | Every attachment says CCME 8.0 on GDCC; CLICS runs on Railway + Vercel + Supabase. Unresolved and deliberately not guessed at |
| **D17** | The Primary Evaluator is **the model named in the submission set**, adopted only after local is connected and evaluated | The set declares a DeepSeek-based custom build. The eight models benchmarked on 26 Aug were Qwen variants, seven of them community "uncensored" fine-tunes — a poor fit for a locked, checksummed research instrument regardless |
| **D18** | **Two gates, one threshold.** Screening = candidate-vs-incumbent ≥ 0.75, runnable today. Decisive = candidate-vs-**human** ≥ 0.75, required before Model Lock | Screening can reject a candidate before a single human rater exists; it can never accept one, because two models can agree closely and be wrong the same way. Nothing is frozen against a number that never touched a human judgement |
| **D19** | A verdict is decided by the **confidence interval**, and `insufficient` is a first-class state | A point estimate of 0.78 on nine pairs looks like a pass. Reporting it as `fail` would be equally wrong — it reads as evidence against when there is none either way |
| **D20** | The Socratic rescue applies **per round** until the session qualifies, and is capped at 8 rounds | The instruction sheet says each round. One-shot left later rounds governed by no constraint at all, and made recovery unobservable. The cap bounds a loop that would otherwise buy a classifier call every turn forever |
| **D21** | Rescue classifier spend is charged to the **episode**, never the physician's budget | The system chose the intervention. Charging for it would penalise exactly the people whose conversation had not yet qualified |
| **D22** | The auditor surface is built **before** the calibration workshop | The workshop's stated output is a map of ambiguous anchors — which is the field that did not exist. Building it afterwards means the workshop leaves no evidence |
| **D23** | Internal deadline **15 Sep 2026**, covering everything through Model Lock | Set deliberately rather than tracked to CREC approval, because the box-side work does not depend on the approval date and needs a fixed date to move |
| **D24** | The **research team authors the synthetic anchor PLE set** | It is on the critical path and had no owner. Anchors must not come from participant data, which is also what makes the decisive gate runnable before participant 1 |
| **D25** | The **15 Sep fallback is retired** | The submission set forecloses running Phase 0 on a cloud API. The honest fallback is to move the start date, not the model |
| **D26** | Expert invitations go out **first** | 20–25 experts against a roster of 3 is the longest path in the programme, and the only one that depends entirely on other people |

**The arithmetic problem, stated plainly.** D23 puts everything inside 18 days from 28 Aug, and D18
requires human ratings before the lock. Those ratings come from the calibration workshop's synthetic
anchor sets (D24) — which do not exist yet, need 20–25 consented experts (D26), and must clear a
sample size the interval will actually support. As of 28 Aug only single-digit numbers of episodes
carry both an AI and a human score. This was raised and the date was reaffirmed; it is recorded here
so nobody has to rediscover it.

---

## The PII hop — state this precisely, do not overclaim

Under **D3**, `rimplEvaluate({ ple_id, transcript, patient_ref, … })` carries the **raw** transcript
and `patient_ref` from Railway to the on-prem node; rimpl is what strips them
(`rimpl/src/routes/chat.js:98`, `rimpl/src/routes/evaluate.js:67` via `rimpl/src/lib/transcript.js:35`). Today that hop is private Railway
networking inside one datacenter. Afterwards it is Virginia → Thailand.

Three things are true at once, and CREC-facing documents must say all three:

- The hop rides **Tailscale (WireGuard)** — encrypted and authenticated, not plaintext internet.
- It is **not a new exposure class**: raw PII already crosses borders today, because Supabase Postgres
  sits in `ap-northeast-1` (Tokyo) and the Railway backend reads it.
- Therefore **"PII never leaves Thailand" is false** and must not be written anywhere. On-prem
  inference closes the *inference* leg. The *storage* leg is A3, and A3 is unresolved.

The honest claim is: *de-identification stops being the sole barrier for AI processing, and becomes
defence-in-depth.* That is a real improvement and it is enough — do not inflate it.

---

## Why do this at all / เหตุผล

| Driver | Assessment |
|---|---|
| **Data sovereignty** | **Strong.** Today Critical Rule #1 holds because de-identification runs before a cloud hop. On-prem inference removes the cloud leg for AI processing entirely |
| **Cost** | **Modest at pilot scale.** ~$0.012/turn against a $0.50/user cap ⇒ 225 PLEs is low hundreds of USD. Material only at national scale |
| **Latency / rate limits** | **Real but secondary.** `CLAUDE_MAX_CONCURRENCY=12` exists because bursts tripped Anthropic's rate limit (~33% success at 40 concurrent). A local box is bounded by VRAM, not someone else's quota |
| **No-training / ZDR** | Currently satisfied by an org-level DPA, not by code. On-prem makes it structural |

---

## The seam is already clean / จุดเชื่อมพร้อมแล้ว

Every AI call funnels through one function, and routes name a **purpose**, never a vendor:

| Call site | Job | max_tokens | Migration risk |
|---|---|---|---|
| `routes/evaluate-criteria.js` | C4–C7 booleans | 200 | **Low** — tiny fixed JSON |
| `routes/chat.js` | PLE dialogue | `RIMPL_CHAT_MAX_TOKENS` | **Medium** — highest volume; already retries on format violation |
| `routes/audit-discuss.js` | auditor calibration tutor | `RIMPL_DISCUSS_MAX_TOKENS` | **Medium** |
| `routes/evaluate.js` | **PIS-7 scoring** | 4096 | **High — ICC-gated, drives CME credit** |

Provenance auto-derives: `versions.js:14` computes `MODEL_VERSION = CCME_LLM_v8.0+${MODEL}`, so a
model swap automatically bumps the recorded version and the DB can separate the two populations with
no extra work. **Caveat that matters for D15:** it derives from the model *name*, so a same-name
update is invisible. That is what the drift check in P2 exists to catch.

---

## Configuration reference

All default to the pre-existing behaviour; setting none of these changes anything.

| Variable | Default | Meaning |
|---|---|---|
| **`app_settings.ai_provider_<purpose>`** | `anthropic` (`openai` for `embed`) | **the superadmin toggle — outranks every variable below.** Set from *Admin → Overview → ผู้ให้บริการ AI*, audit-logged, effective on the next request |
| `AI_PROVIDER` | `anthropic` | provider for every purpose, when no DB override is stored |
| `AI_PROVIDER_CHAT` / `_EVALUATE` / `_CRITERIA` / `_DISCUSS` / `_EMBED` | *(unset)* | per-purpose override |
| `EMBED_PROVIDER` | `openai` | global fallback for RAG embeddings (`openai` \| `local`) |
| `PROVIDER_SETTINGS_TTL_MS` | `15000` | how long the DB override is cached. The database is never read per call |
| `LOCAL_AI_BASE_URL` | *(unset)* | e.g. `http://<dgx>:8000/v1`. Required when any purpose is `local` |
| `LOCAL_AI_MODEL` | *(unset)* | model id the server serves. Required when any purpose is `local` |
| `LOCAL_AI_EMBED_MODEL` | *(unset)* | embedding model id. Usually **not** the chat model |
| `LOCAL_AI_API_KEY` | *(unset)* | optional bearer token |
| `LOCAL_AI_TIMEOUT_MS` | `150000` | per model call. Backend's `RIMPL_EVAL_TIMEOUT_MS` is now `480000` (2–3 serial calls + rimpl's queue wait); `RIMPL_CRITERIA_TIMEOUT_MS` stays `180000` because criteria runs inside the physician's `/end` request |
| `LOCAL_AI_MIN_CONTEXT` | `16384` | `/health/deep` reports the box **down** below this — a PLE transcript cannot be scored at 4096 |
| `LOCAL_AI_NUM_CTX` | *(unset)* | opt-in per-request `num_ctx`. **The authoritative fix is server-side** |
| `CLAUDE_TIMEOUT_MS` | `150000` | Anthropic SDK ceiling, matched to the local one |
| `RAG_EMBED_DIM` | `1536` | the corpus's embedding width. A provider returning a different width fails loudly |
| `LOCAL_MAX_CONCURRENCY` | `2` | in-flight cap across both lanes — the measured knee (p95 114 s at 2, 154 s at 4). Set from the capacity probe, not a guess |
| `LOCAL_INTERACTIVE_RESERVE` / `LOCAL_MAX_QUEUE_INTERACTIVE` / `LOCAL_MAX_QUEUE_BACKGROUND` / `LOCAL_QUEUE_RETRY_AFTER_S` | `1` / `4` / `2` / `30` | two-lane runner: one slot is kept for chat/criteria/discuss so a burst of evaluations cannot block a physician's turn; queue depth beyond the caps returns `503 queue_full` with `Retry-After` |
| `LOCAL_AI_MAX_PROMPT_TOKENS` | `0` (off) | proactive `413 transcript_too_large` before any call, **in the server's `usage.prompt_tokens` unit** — set it to the served count the capacity probe prints for the last size with sentinel recall. rimpl converts its byte estimate through a ratio learnt from 3+ served responses and never pre-rejects before that (`/health/deep` → `queues.local.prompt_calibration`) |
| `RIMPL_BODY_LIMIT` | `2mb` | `/chat` resends the whole history each turn; Express's 100 KB default could not carry a 64k-token transcript |
| `LOCAL_MAX_RETRIES` / `LOCAL_RETRY_BASE_MS` | `3` / `500` | our own request timeout is never retried |
| `LOCAL_INPUT_PER_M` / `LOCAL_OUTPUT_PER_M` | `0` / `0` | set only to put hardware amortisation on the meter |
| `LOCAL_AI_THINKING_STYLE` | `none` | how an optional per-request `thinking` flag reaches the server: `none` (never sent) \| `chat_template_kwargs` (vLLM/SGLang `enable_thinking`) \| `ollama` (`think`). Sent only when a caller passes it — today only the chat route does, and only on a turn the fast/deep router served with `chat_router_enabled` = 1 (fast → off, deep → on); with the router off nothing is sent |
| `LOCAL_AI_THINK_PREOPENED` | `0` | reasoning inside `content` (a server without `--reasoning-parser`): the **returned/stored** reply is always stripped of it. A **stream** withholds a `<think>…</think>` block the model writes itself, but NOT reasoning whose block the chat template opened inside the prompt (DeepSeek-R1, Qwen3 Thinking-2507) — the reply is `…reasoning…</think>answer`, and pieces sent before the `</think>` have already been shown (rimpl warns once, naming this knob). `1` declares such a template: nothing is shown or returned before the first `</think>`, and a reply that never closes it is an error (`503 empty_reply`, `reasoningOnly`), never the reasoning and never a blank turn. Mis-set on a template that does not pre-open, every reply fails — loudly. **The real fix is the server's `--reasoning-parser`.** The probe/quality harness reads the same variable |
| `LOCAL_AI_MAX_TOKENS_FLOOR_<PURPOSE>` | *(unset)* | per purpose (`CHAT` / `EVALUATE` / `CRITERIA` / `DISCUSS` / `SHADOW`), the least `max_tokens` sent to this endpoint; the larger of it and the route's own ceiling goes out. For a reasoning model, whose reasoning counts against `max_tokens` (criteria's 200 is eaten before the answer starts). Any reply with no answer text, on any provider, is a retryable `503 empty_reply` |
| `LOCAL_TUTOR_AI_BASE_URL` / `_MODEL` / `_API_KEY` | *(unset — dormant)* | the on-prem **tutor** model, provider `local-tutor` (CCME R3: the evaluator `local` must be a distinct model from the tutor). Chat / discuss only — rimpl refuses evaluate / criteria / embed on it. Every `LOCAL_AI_*` / `LOCAL_*` knob above exists for it as `LOCAL_TUTOR_AI_*` / `LOCAL_TUTOR_*` (own queue, own context floor `app_settings.local_tutor_ai_min_context`, own backstop, own `/health/deep` check `local_tutor_ai`); the proxy is inherited from `LOCAL_AI_HTTP_PROXY` unless `LOCAL_TUTOR_AI_HTTP_PROXY` is set |
| **backend** `LOCAL_TUTOR_INPUT_PER_M` / `LOCAL_TUTOR_OUTPUT_PER_M` | `0` / `0` | the tutor's rate pair, as `LOCAL_INPUT_PER_M` for the evaluator |
| `SHADOW_EVAL_PROVIDER` | *(unset — off)* | provider to shadow-score with; ignored if it equals the serving provider. **Refused for `local-tutor`** (logged once, shadow skipped): a shadow row is a candidate evaluator's score, and the tutor may not be the evaluator (CCME R3). Backend also never picks a `local-tutor` shadow row as the Model Lock candidate (`coverage.shadow_ineligible` counts any that exist) |
| `SHADOW_EVAL_MAX_TOKENS` | `4096` | matches the served ceiling, so a truncation is the model's fault, not ours. The temperature is not tunable: the shadow sends the served evaluator's `0` (`rimpl/src/lib/decoding.js`; before 2026-10-15 it sent none, i.e. the candidate server's default) |
| `PROVIDER_SETTINGS_SOURCE` | `database` | `env` = ignore `app_settings` and route from the env chain only. **Development only — rimpl refuses to boot with it in production.** Used by the laptop smoke stack; `/health/deep` shows `routing.override: true` |
| `CHAT_FAILOVER_PROVIDER` | *(unset — dormant)* | if set, a **chat** turn whose primary provider is DOWN (connection refused/reset, timeout, 5xx) is retried once on this provider and the turn is marked `failed_over_from`. Never for evaluate/criteria/discuss, never on `queue_full`/abort/413. **CREC decision pending — research transcripts must not fall back to a cloud model without an ethics amendment; leave unset** |
| **backend** `EVAL_DRAIN_INTERVAL_MS` / `EVAL_DRAIN_CONCURRENCY` / `EVAL_LEASE_S` / `EVAL_MAX_ATTEMPTS` | `60000` / `1` / `600` / `20` | the evaluation drain (always running outside tests; the interval is only the fallback tick). The setting `eval_drain_concurrency` wins over the env when set. Lease must exceed `RIMPL_EVAL_TIMEOUT_MS` |
| **backend** `EVAL_DRAIN_ONLY_COUNCILS` | *(unset)* | dev-only include scope (council codes) for a laptop stack sharing the prod database — **refused in production**; prod uses the setting `eval_drain_exclude_councils` |
| **setting** `standard_usage_limit_tokens` / `auditor_standard_usage_limit_tokens` | `0` (no cap) | token ceilings per pool; per-user overrides on `professionals`. Set from the capacity report as `3 × p95(tokens per PLE) × 1.25` |
| **setting** `ple_max_transcript_tokens` / `ple_transcript_warn_pct` | `64000` (trial) / `80` | transcript cap on `ples.context_tokens` and the warn band |
| **setting** `eval_drain_concurrency` / `eval_p50_seconds` / `eval_drain_exclude_councils` | `1` / `90` / *(empty)* | live drain width, the eta multiplier shown to physicians, and the prod side of the council partition. Keep the width at 1 while `EVAL_CONSISTENCY=adaptive` unless the eval timeouts are re-sized (see above) |
| `EVAL_CONSISTENCY` / `EVAL_JSON_RETRIES` / `SHADOW_EVAL_CONSISTENCY` | `off` / `2` / `off` | rimpl: adaptive self-consistency for the **local** evaluator only (2 calls; a 3rd + per-domain median when any domain differs by >1; billed = call 1, extras in `provenance.consistency`); the served path may re-ask an unparseable reply up to 2×; the shadow path never re-asks, so its contract rate stays honest |

---

## G0 — Access and inventory  *(blocked on Aj. Chanvit)*

Facts, not decisions. Everything downstream waits on these.

1. **Tailnet access** to **`cme-dev`** (`100.68.210.69`) — the inference port, not just the UI port.
2. ~~**What `cme-dev` actually serves**~~ **ANSWERED 2026-09-05 — the inference servers exist, and
   every one of them is LAN-only.** Open WebUI's Connections panel names its upstreams:
   `http://cme-dgx:8888/v1` and `http://192.168.1.178:8000/v1` (OpenAI-compatible), plus
   `http://192.168.1.111:11434` and `http://192.168.1.177:11434` (Ollama, the second disabled).
   `cme-dev` is not itself the inference host — it is the gateway in front of them.

   All four were probed from the laptop: three time out, `cme-dev-dgx:8888` does not resolve. The
   reason is one line — `cme-dev` advertises `AllowedIPs: 100.68.210.69/32` and no subnet route, so
   `192.168.1.0/24` does not exist from outside. **No API key changes this**, which is worth stating
   plainly because "use the API key on that page" is the natural reading of the problem and it is the
   wrong layer: the connection never completes, so no key is ever presented.

   **This makes the D3 case stronger than the docs currently argue.** rimpl running *on* `cme-dev`
   would reach `192.168.1.178:8000/v1` directly over the LAN and skip Open WebUI entirely — which is
   exactly the "fewer hops, no per-user API-key semantics, no UI-layer throttling" this item asked
   for. Which of `:8000` and `:8888` serves `deepseek-v4-flash-dspark` is **inferred, not measured**:
   `:8000` is vLLM's default and the served `system_fingerprint` is `vllm-...-tp2` (§8.10), but the two
   cannot be told apart from outside the LAN.
3. **`sha256sum` of the evaluator weights**, and who can run it. It is the digest declared at
   `/admin/evaluator-lock` (P5), which fills `app_settings.evaluator_weights_sha256` (seeded null) —
   never set by hand. It is **not** readable over an inference API — it must be declared by someone
   with filesystem access.
4. ~~**Can rimpl be hosted on a tailnet node?**~~ **ANSWERED YES, 2026-09-05 — and it needs no
   firewall change.** A nine-port sweep from inside the Railway container, read by curl exit code,
   found `cme-dev:3003` **refused (RST)** rather than dropped: packets from production reach the box's
   TCP stack and it answers, so a rimpl listening there would be reachable by the backend. The block on
   `:3000` is source-scoped — the same ports return HTTP 200 from `napats-macbook-air` at the same
   minute — and stops mattering under D3, because the model becomes localhost to rimpl. GATE0 §8.9.
   What remains for D3 is a host and its owner's permission, not the network.
5. **Concurrency** available during a clinic-hours burst — physicians log in after clinic, so the load
   is bursty, not flat. Sets `LOCAL_MAX_CONCURRENCY`.
6. **Who operates the box**, and will they commit to **no evaluator changes between lock and study
   end**, with notice? (D15.)

**~~Owed on the box regardless: raise `OLLAMA_CONTEXT_LENGTH`.~~ RESOLVED 2026-09-02 — do not ask
for this.** Measured 2026-08-24, a 9,144-token evaluation returned `400 … exceeds the available
context size (4096)` and `options.num_ctx` was proven inert over the OpenAI-compatible endpoint. That
measurement was against an **Ollama** upstream. The backend actually serving today is **vLLM**
(`system_fingerprint: vllm-0.21.1rc1...-tp2`, GATE0 §8.5), and the capacity ramp found **no input
ceiling at all** — a sentinel was still recalled at **66,029 served tokens** (GATE0 §8.1). Two Ollama
hosts remain listed in Open WebUI's Connections panel, so the old finding was real for the upstream it
tested; it is simply not the one in the path. Asking for it now would cost the box owner time on a
setting that is not binding.

---

## P0 — Probe  *(½ day, no repo changes)*

Cheapest possible answer to "is this even viable". Harness is written: `scripts/probe/`
(`discover.mjs`, `json-contract.mjs`, `thai-probe.mjs`, `throughput.mjs`).

1. **JSON-contract probe.** Feed 10 real de-identified transcripts + `PIS7_EVALUATOR_PROMPT` to the
   local model. Count how many return parseable JSON with `d1..d7` all integers in 0–5 — the exact
   check `evaluate.js` enforces.
2. **Thai probe.** Chat turns in Thai: fluency, the `(Source, Year)` citation, the closing `❓`. Thai
   is where open models most often disappoint, and CLICS is bilingual.
3. **Throughput.** Establishes `LOCAL_MAX_CONCURRENCY` from measurement.
4. **Context.** Confirm the server-side context fix landed, ≥ `LOCAL_AI_MIN_CONTEXT`.

> ### 🚦 Gate 0 — JSON parse rate ≥ 95% AND Thai output clinically usable AND context ≥ 16k.
> Fail here and stop. Nothing downstream matters.

---

## P1 — Provider adapter  ✅ **done** (PR #61)

The seam exists. Routes name a purpose; the mapping lives in `services/ai.js` behind the superadmin
toggle. Retained here because the field mapping is the thing people re-derive:

| Anthropic | OpenAI-compatible |
|---|---|
| top-level `system` param | `{role:"system"}` as first message |
| `usage.input_tokens` / `output_tokens` | `usage.prompt_tokens` / `completion_tokens` |
| `stop_reason: "max_tokens"` / `"end_turn"` | `finish_reason: "length"` / `"stop"` |
| `content[]` blocks → join `.text` | `choices[0].message.content` (string) |
| `cache_control: {type:"ephemeral"}` | no equivalent — dropped on the local path |

`rimpl/tests/pii-leak-adversarial.test.js` must stay green — the PII boundary sits *upstream* of the
provider and must not move.

---

## P2 — rimpl relocation and the bridge

**D3: move rimpl on-prem onto a tailnet node.** rimpl is *defined* as the on-premise layer in
[architecture.md](architecture.md); this makes deployment match the design instead of contradicting
it. Backend stays on Railway.

| Option | Verdict |
|---|---|
| **Move rimpl on-prem** onto a tailnet node | **Chosen (D3). Unblocked 2026-09-05** — G0 item 4 answered yes; `:3003` is reachable from Railway with no firewall change (GATE0 §8.9) |
| **Tailscale userspace inside the Railway container** (`--tun=userspace-networking` + SOCKS5, or `tsnet`) | **Built and live**, but it is not a route to the model: the node joins **ephemerally**, drawing a new tailnet address every deploy, so it can never sit on the address allowlist that `:3000` is behind. Useful as the transport for D3, not as a substitute |
| **Expose the DGX publicly** (Funnel / reverse proxy) | **Reject.** Inverts the entire on-prem premise |

Work in this phase:

- **Backend → rimpl reachability.** `RIMPL_URL` stops being `rimpl.railway.internal:3003`. Whatever
  replaces it carries raw PII (see *The PII hop*) and must be authenticated end-to-end, not merely
  network-reachable — `INTERNAL_TOKEN` still applies. **The backend needs a Tailscale client of its
  own**, which it does not have today: the 2026-09-05 sweep that proved `:3003` reachable ran from the
  *rimpl* container, the only service whose image carries one. Copying `rimpl/Dockerfile`'s userspace
  sidecar into the backend is a prerequisite of this phase, and it is our work, not the box owner's.
  **🛑 Read [ADR 0001](adr/0001-d3-transport-topology.md) before building any of it.** That work is
  done and parked in PR #90; a GDCC VM would make its central mechanism unnecessary, so the standing
  decision is to build no further transport until the VM is provisioned or refused.
- **Deploy pipeline changes.** rimpl leaves the Railway CLI path. Document the replacement in
  [deployment.md](deployment.md); the `--service rimpl` gotcha becomes obsolete and should be struck
  rather than left to mislead.
- **Model-drift detection (D15).** `/health/deep` compares the box's reported model identity against
  the locked value and goes **degraded** on mismatch; the observed identity is stamped into
  `ai_evaluations.provenance` on every score, so drift is visible in the data even if nobody watched
  the health endpoint. This is the difference between §10.2 being provable and being asserted.
- **Already done:** provider-aware `ready()` and `/health/deep` routing report; context floor
  enforcement; timeouts unified at 150s under a 180s outer bound; embeddings moved onto the seam.

---

## G0.5 — Human-auditor ICC baseline  🚦 **programme go/no-go**

**This is the phase most likely to stop the programme, and it has nothing to do with the local model.**

Every ICC CLICS has ever recorded is **AI-vs-AI**. `scripts/calibration/prompt-versions.md`:

| Prompt version | ICC (95% CI) | n | Raters |
|---|---|---|---|
| v0 (original) | 0.377 (0.04–0.64) | 33 | simulated |
| v1 | 0.700 (0.47–0.84) | 33 | simulated |
| v2 (superseded) | 0.811 (0.64–0.91) | 30 | simulated |
| **v3 (current, `59561c292df0`)** | **never measured** | — | — |

Those raters are Claude agents with assigned stances (`scripts/soak/gen-auditor-wf.js:30-32`), not
humans. Two consequences:

- **The CI straddles the gate.** 0.64–0.91 at n=30 does not confidently clear 0.75.
- **These figures do not describe the shipping instrument.** `cd29df5` replaced the evaluator prompt
  with the CREC082 behavioural anchors and no calibration run has been made against it since, so
  0.811 measures a prompt that no longer ships ([ledger](../scripts/calibration/prompt-versions.md)).
- **Nothing here establishes human agreement.** Neither the size nor the direction of any difference
  between human and agent raters has been measured for this instrument.

So: measure Claude's ICC against **real human auditors** on the current prompt, before anything else.

> ### 🚦 Gate 0.5 — Claude ICC ≥ 0.75 against real human auditors.
> **If Claude misses, the credit gate fails for the incumbent and "local vs Claude" was never the
> interesting question.** Surface it to the research team immediately (D14). The fix is to retune the
> prompt against *human* divergence and re-baseline. The local model is then gated against the
> **retuned** prompt — never against one fitted to simulated raters, **which includes the prompt
> shipping today.** `cd29df5` added the CREC082 anchors on top of v2; it did not remove v2's brakes,
> which survive verbatim in v3 ("Penalize templated/scripted behaviour", the verbatim-turn cap on
> d2/d4, "If you cannot quote one, the score is at most 3", "Use the FULL scale"). So v3 carries the
> simulated-rater fitting *and* has no calibration of its own. Naming only v2 here would leave the
> live hazard unnamed — every D18 screening row already gated the local candidate against v3
> ([ledger](../scripts/calibration/prompt-versions.md)).

Because D1 puts this before the Pilot Study, you find this out while it is still fixable rather than
at analysis time with 225 PLEs already scored and locked.

**Measured starting point.** Re-checked against production and recorded in
[the human-rater checklist](G0.5-HUMAN-RATER-PREP.th.md) §0: **3 unscored assignment rows across 2
PLEs — one real, one sandbox — not the 5 this page used to record** — and 7 Internal Medicine
auditor *accounts* (every other specialty had 1), which was correct as an account count.

Seven accounts is not seven available raters; how many will actually take part is still unverified.
And recruiting is premature either way: the cohort has to clear the range-restriction gate first, and
§0 measured it failing (between-episode SD 2.44 against 4.66 required). Target
`min_auditors_per_cle = 3` and report the actual number of independent human ratings per PLE.

---

## P3 — Migrate the purposes

Order matters: cheapest and most reversible first.

1. **`embed`** — **free.** The `documents` corpus is **empty (0 rows)**, so `match_documents` returns
   nothing, retrieval is inert, and there is nothing to re-embed. `RAG_EMBED_DIM=1536` binds nothing
   today. (If the corpus is ever populated, moving `embed` afterwards *does* require a full re-embed.)
2. **`criteria`** — 200 tokens, booleans, no scoring impact.
3. **`discuss`** — auditor-facing, not scored, separate budget pool.
4. **`chat`** — the volume. Only once 1–3 have been stable for a week.
5. **`evaluate`** — **not here.** It moves at P5, behind Gate 4, and only if the gate passes.

**Apply `db/migration-shadow-evaluations.sql` at the start of this phase** — not before. It no-ops
without a second reachable provider, and applying it early just adds an unused table.

**⚠️ Cost accounting.** `pricing.js` is global — one input/output rate for the whole system. While
purposes are split across providers, per-user spend and per-council billing silently misreport. Pass a
per-call rate (or a provider tag) through `backend/src/lib/usage.js:111`, which already accepts `costOverride`. Do this
**before** the first split ships, not after.

---

## P4 — Calibrate the evaluator and run Gate 4

The instrument exists: `scripts/calibration/calibrate.js --mode rescore`, plus `three-way.js` for
Claude-vs-local-vs-auditor.

**Reserve the held-out split before the first tuning run (D13).** Everything else in this phase is
allowed to iterate; the gate run is not. Reserving it afterwards is indistinguishable from choosing
the split that passes.

1. Enable shadow (`SHADOW_EVAL_PROVIDER`) so every served evaluation also produces a local score on
   the **same transcript**. Paired data, out of normal operation — no separate rescore run, and no
   "did the harness reproduce the baseline?" step (D6).
2. Compare against the **G0.5 human-scored baseline** and the absolute gate.
3. Expect to retune. The v1 rules were written against *Claude's* failure mode (systematic leniency,
   +10.3, over-crediting templated structure). A different model will likely fail differently —
   possibly in the opposite direction.
4. ~~**`prompt-versions.md` needs a model axis.**~~ **Done** — the axis is at
   `scripts/calibration/prompt-versions.md:117` ("Model axis (local-model screening, D18)"), and every
   row there names the model pair that produced it. Kept, struck rather than deleted, because the
   reasoning stands: ICC is a property of (model × prompt × rubric), and a number recorded without its
   model is not reproducible.

> ### 🚦 Gate 4 — local ICC ≥ **0.75 absolute**, measured on the held-out cohort (D9, D13).
> Claude's figure is informational, not the comparator.
> **Pass → all purposes local (D8).** **Fail → retune against the local model's own divergence and
> re-gate on the held-out cohort (D10).**

---

## P5 — Model Lock and production posture

Runs immediately before the first participant.

- **Amend the Model Lock Record (D5)** to name the model `cme-dev` actually serves. The Record
  currently names a **DeepSeek**-based model; resolve against the G0 inventory. This is a protocol
  amendment note, not a code change.
- **Declare the lock at `/admin/evaluator-lock`** (superadmin; the page POSTs
  `/admin/evaluator-lock`) with the G0 weights digest, the inference engine, and the prompt and
  rubric versions. The declaration is refused unless the candidate cleared the **decisive** gate on
  exactly the declared prompt version, the candidate is the provider currently **serving
  `evaluate`** (switch `evaluate` to it first), and the declaration matches rimpl's checked-in model
  manifest (`GET /manifest`, code-matched). On success the backend writes the Model Lock Record row,
  freezes the manifest sha256, the expected half of the manifest and the **evaluator digest**, sets
  both settings, and writes the audit event. After that the backend refuses an evaluator provider
  change outright, and every score's provenance carries the digest.
- **Never set `evaluator_locked_at` or `evaluator_weights_sha256` by hand** (SQL, the Supabase
  console, or an old script). A hand-set lock has no Model Lock Record row and no frozen manifest,
  so nothing can say what was frozen: `/health/deep` reports `checks.model_lock` as
  `lock_not_bound_to_manifest` and stays **degraded until the lock is replaced through the
  endpoint** — and the scores issued under it carry a digest no record explains. The old quick-lock
  toggle on the AI provider panel is gone for the same reason (it answers 409 `use_model_lock`).
  Replacing or lifting a lock also goes through the endpoint and its typed confirmation phrase.
- **What the lock freezes is the evaluator only.** Tutor, router and chat changes after a lock are
  allowed and appear on `/health/deep` as a note (`tutor_or_router_changed_since_lock`); a change
  to any evaluator key (prompt or addendum, rubric, model-version prefix, evaluate decoding, the
  consistency reconciliation rules except the shadow's, the evaluate provider, or the declared block
  for the locked provider) degrades
  health and needs **REPLACE THE LOCK**. The exact key list is in [deployment.md](deployment.md)
  (the evaluator Model Lock section).
- **Disclose in the Record (D11, D12):** that a **shadow evaluator runs and does not serve**, and that
  **retrieval is inert** (empty corpus). Both must be stated, or §10.2 describes a system that does
  not exist and a later change looks like an undisclosed second scorer or a silent instrument swap.
- **Shadow survives the lock.** `evaluator_locked` guards the `{purpose:'evaluate', provider}` write;
  shadow is driven by `SHADOW_EVAL_PROVIDER` and never touches that path. `shadow_evaluations` is RLS
  deny-all, failures are swallowed, and it **sheds rather than queues** when the provider is busy — it
  can never cost a physician their credit.
- **Failover policy — differs by route, deliberately:**
  - `chat`: local down → fall back to Claude. A physician mid-session should never be blocked.
  - `evaluate`: **fail closed. Never fail over.** Silently scoring some PLEs on a different model
    reintroduces exactly the confound D1 exists to avoid. Queue and retry instead.
- **Capacity.** Size against the real shape: 75 physicians, bursty. The 2026-06 loadtest measured 200
  concurrent requests / 110 distinct users against the *cloud* path — re-run it against local before
  trusting it.
- **Docs to update:** [architecture.md](architecture.md) (the cloud leg disappears for AI processing),
  [deployment.md](deployment.md) (rimpl leaves Railway), [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md),
  [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) (ZDR/no-training becomes structural).

---

## Risks / ความเสี่ยง

| Risk | Severity | Mitigation |
|---|---|---|
| **Claude itself misses ≥0.75 against human auditors** | **Critical** | Gate 0.5, run *before* the study (D14). Retune against human divergence, re-baseline, then gate local against the retuned prompt |
| Model swapped mid-study → confounded outcome | **Critical** | Lock before participant 1 (D11); `evaluate` never fails over |
| Model silently updated on a box we do not operate | **Critical** | D15: written commitment **plus** weights-digest pin, `/health/deep` drift check, identity stamped into `provenance` |
| ~~rimpl cannot be hosted on the tailnet~~ **retired 2026-09-05** | — | G0 item 4 answered yes: `:3003` refuses rather than drops, so the backend can reach a rimpl on the box (GATE0 §8.9) |
| Local model cannot hold the PIS-7 JSON contract | High | Gate 0 before any further work |
| Thai output quality drops | High | Gate 0 Thai probe; physicians notice immediately |
| Overfitting the prompt to a small cohort | High | D13: held-out split reserved before the first tuning run |
| Hybrid mis-bills users/councils | Medium | Per-call cost rate before the first split ships |
| Single DGX = single point of failure | Medium | `chat` fails over to Claude; `evaluate` queues |
| Railway↔tailnet bridge breaks silently | Medium | Provider-aware `/health/deep` |
| "PII never leaves Thailand" claimed in a CREC document | Medium | It is false while Supabase is in Tokyo. See *The PII hop* |

---

## Open questions for Aj. Chanvit / คำถามที่ต้องถาม

Consolidated from G0 — these are the only things blocking the whole plan.

1. What does `cme-dev` serve — which models, what context length? Can we hit the inference server
   directly rather than through Open WebUI?
2. Can you run `sha256sum` on the evaluator model's weights, and share the digest?
3. ~~**Can rimpl be hosted on a tailnet node?**~~ **Reframed 2026-09-05 — this is no longer what
   blocks production, and the version of this line written earlier today was wrong.** A Railway
   container ALREADY reaches the box: `rimpl/Dockerfile` carries an optional userspace Tailscale
   client (`e7441dd`), and `531c80b` got a real completion back through it. The tailnet ACL is
   default allow-all. What is blocked is **port 3000 on `cme-dev`, dropped from the container while
   open from a laptop** — a rule scoped by source address, proven against a closed-port control
   (`d110a5f`). See GATE0 §5.1. The question to ask is now the one below, and it is much smaller.
   D3 (move rimpl on-prem) is still the architecture's answer, but it is no longer the thing standing
   between us and a reachable model.
4. Is the DGX dedicated to CLICS or shared? What concurrency during a clinic-hours burst?
5. Who operates the box, and can you commit to **no evaluator model changes between lock and study
   end**, with notice?
6. ~~Has `OLLAMA_CONTEXT_LENGTH` been raised?~~ **Withdrawn 2026-09-05** — the served backend is
   vLLM, not Ollama, and no input ceiling was found up to 66,029 tokens (GATE0 §8.1). See G0 above.
7. Can we have an API key that is **not tied to a personal Open WebUI account**? The current one
   carries that account's lifecycle and the UI layer's throttling; a nine-month study wants a service
   account, or the direct inference endpoint from question 1.
8. **THE ONE THAT BLOCKS PRODUCTION.** Either (a) allow our Railway node's tailnet address, or its
   tag, to reach **port 3000** on `cme-dev`, or (b) serve `deepseek-v4-flash-dspark` on **port
   11434**, which is already open to us. Either is sufficient. **(b) is not satisfied by what is on
   11434 today** — that port serves `qwen3.6-custom:latest` through Ollama, a different model from
   the one every study number was measured on, whose replies put the text under `reasoning` with
   `content` empty and would fail the PIS-7 JSON contract.
