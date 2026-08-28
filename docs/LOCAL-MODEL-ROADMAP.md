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

## Status

| Phase | State |
|---|---|
| **G0 — Access + inventory** | **partly done.** Tailnet reachable, inventory taken 2026-08-26: three machines, and no `cme-dgx`. Still owed from the box: context length, the declared model + its checksum, the embeddings service, concurrency, an operator |
| **P0 — Probe** | **partly run, outside this harness.** Eight models were benchmarked on `cme-dev` 25–26 Aug on one clinical prompt. [`scripts/probe/`](../scripts/probe/README.md) is still unrun, so the JSON-contract and Thai-citation checks that `evaluate.js` actually enforces remain untested |
| **P1 — Provider adapter** | **done**, shipped dark (PR #61) |
| **P1.5 — Readiness gate** | **done** (#71). A switch to a provider that cannot serve is refused with the measured value; unknown counts as unfit |
| **P2 — rimpl relocation + bridge** | **not started** — needs G0 item 4 |
| **G0.5 — Human-auditor ICC baseline** | **not started. This is still the programme go/no-go** |
| **P3 — Migrate purposes** | shadow evaluator code **done** (PR #65); `db/migration-shadow-evaluations.sql` **NOT applied** — shadow silently no-ops until it is |
| **P4 — Calibrate + Gate 4** | **instrument done** (#74): every arm carries a verdict, and `insufficient` is distinct from `fail`. The gate itself is blocked on G0.5 |
| **P5 — Model Lock** | **mechanism done** (#75): the declaration form is closed until the decisive verdict passes, and the freeze is enforced. Blocked on P4 for the verdict that opens it |

Nothing is live. Every purpose resolves to `anthropic` (`openai` for embeddings), so with the toggles
untouched, `AI_PROVIDER` unset and `SHADOW_EVAL_PROVIDER` unset, every call still goes to the cloud
and no shadow evaluation runs.

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
| **D2** | ~~Target box is **`cme-dgx`** (100.119.96.52)~~ → **superseded 2026-08-28: the target is `cme-dev` (100.68.210.69)** | A tailnet inventory on 26 Aug found three machines and **no `cme-dgx`**. `cme-dev` is the only box that can be the target, and it is the one every model benchmark actually ran on. Read any earlier "measured on the DGX" as "measured on `cme-dev`" |
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

Under **D3**, `rimplEvaluate({ cle_id, transcript, patient_ref, … })` carries the **raw** transcript
and `patient_ref` from Railway to the on-prem node; rimpl is what strips them
(`rimpl/src/routes/chat.js:79`, `rimpl/src/routes/evaluate.js:22`). Today that hop is private Railway
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
| `LOCAL_AI_TIMEOUT_MS` | `150000` | must stay under backend's `RIMPL_EVAL_TIMEOUT_MS` (180s) |
| `LOCAL_AI_MIN_CONTEXT` | `16384` | `/health/deep` reports the box **down** below this — a PLE transcript cannot be scored at 4096 |
| `LOCAL_AI_NUM_CTX` | *(unset)* | opt-in per-request `num_ctx`. **The authoritative fix is server-side** |
| `CLAUDE_TIMEOUT_MS` | `150000` | Anthropic SDK ceiling, matched to the local one |
| `RAG_EMBED_DIM` | `1536` | the corpus's embedding width. A provider returning a different width fails loudly |
| `LOCAL_MAX_CONCURRENCY` | `24` | in-flight cap. Set from a P0 measurement, not a guess |
| `LOCAL_MAX_RETRIES` / `LOCAL_RETRY_BASE_MS` | `3` / `500` | our own request timeout is never retried |
| `LOCAL_INPUT_PER_M` / `LOCAL_OUTPUT_PER_M` | `0` / `0` | set only to put hardware amortisation on the meter |
| `SHADOW_EVAL_PROVIDER` | *(unset — off)* | provider to shadow-score with; ignored if it equals the serving provider |
| `SHADOW_EVAL_MAX_TOKENS` | `4096` | matches the served ceiling, so a truncation is the model's fault, not ours |

---

## G0 — Access and inventory  *(blocked on Aj. Chanvit)*

Facts, not decisions. Everything downstream waits on these.

1. **Tailnet access** to `cme8.org.github`.
2. **What `cme-dgx` actually serves** — confirmed Ollama, but: which models, at what context length,
   and is the inference server reachable directly (`:11434` / `:8000/v1`) rather than through Open
   WebUI? Server-to-server wants the inference server: fewer hops, no per-user API-key semantics, no
   UI-layer throttling.
3. **`sha256sum` of the evaluator weights**, and who can run it. This fills
   `app_settings.evaluator_weights_sha256`, which is seeded and null. It is **not** readable over an
   inference API — it must be declared by someone with filesystem access.
4. **Can rimpl be hosted on a tailnet node?** **D3 assumes yes.** If the answer is no, D3 and D7 both
   need revisiting and P2 falls back to a Tailscale userspace sidecar inside the Railway container.
5. **Concurrency** available during a clinic-hours burst — physicians log in after clinic, so the load
   is bursty, not flat. Sets `LOCAL_MAX_CONCURRENCY`.
6. **Who operates the box**, and will they commit to **no evaluator changes between lock and study
   end**, with notice? (D15.)

**Owed on the box regardless:** raise `OLLAMA_CONTEXT_LENGTH`. Measured 2026-08-24 against the DGX, a
9,144-token evaluation returned `400 … exceeds the available context size (4096)`. `options.num_ctx`
over the OpenAI-compatible endpoint is proven inert, so the fix is server-side. A creditable PLE
transcript runs to 10,000+ tokens and one hit 130k on 2026-08-17.

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
| **Move rimpl on-prem** onto a tailnet node | **Chosen (D3).** Pending G0 item 4 |
| **Tailscale userspace inside the Railway container** (`--tun=userspace-networking` + SOCKS5, or `tsnet`) | **Fallback** if G0 item 4 comes back no. Costs an auth key in Railway env and one more failure mode |
| **Expose the DGX publicly** (Funnel / reverse proxy) | **Reject.** Inverts the entire on-prem premise |

Work in this phase:

- **Backend → rimpl reachability.** `RIMPL_URL` stops being `rimpl.railway.internal:3003`. Whatever
  replaces it carries raw PII (see *The PII hop*) and must be authenticated end-to-end, not merely
  network-reachable — `INTERNAL_TOKEN` still applies.
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
| **v2 (current)** | **0.811 (0.64–0.91)** | 30 | **simulated** |

Those raters are Claude agents with assigned stances (`scripts/soak/gen-auditor-wf.js:30-32`), not
humans. Two consequences:

- **The CI straddles the gate.** 0.64–0.91 at n=30 does not confidently clear 0.75.
- **Human auditors disagree with each other more** than agent-raters with assigned stances do, so the
  honest expectation is that the human-scored figure comes in **lower**, not higher.

So: measure Claude's ICC against **real human auditors** on the current prompt, before anything else.

> ### 🚦 Gate 0.5 — Claude ICC ≥ 0.75 against real human auditors.
> **If Claude misses, the credit gate fails for the incumbent and "local vs Claude" was never the
> interesting question.** Surface it to the research team immediately (D14). The fix is to retune the
> prompt against *human* divergence — the v1/v2 rules were fitted to simulated-rater divergence — and
> re-baseline. The local model is then gated against the **retuned** prompt, never against
> Claude-fitted v2.

Because D1 puts this before the Pilot Study, you find this out while it is still fixable rather than
at analysis time with 225 PLEs already scored and locked.

**Cheapest path to a first human-scored cohort:** the 5 unscored assignments already in the auditor
queue, plus recruiting toward `min_auditors_per_cle = 3` on **Internal Medicine only** — it has 7
auditors; every other specialty currently has exactly 1.

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
per-call rate (or a provider tag) through `usage.js:65`, which already accepts `costOverride`. Do this
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
4. **`prompt-versions.md` needs a model axis.** It versions prompts only. ICC is a property of
   (model × prompt × rubric), and the file must record which model produced each number.

> ### 🚦 Gate 4 — local ICC ≥ **0.75 absolute**, measured on the held-out cohort (D9, D13).
> Claude's figure is informational, not the comparator.
> **Pass → all purposes local (D8).** **Fail → retune against the local model's own divergence and
> re-gate on the held-out cohort (D10).**

---

## P5 — Model Lock and production posture

Runs immediately before the first participant.

- **Amend the Model Lock Record (D5)** to name the model `cme-dgx` actually serves. The Record
  currently names a **DeepSeek**-based model; resolve against the G0 inventory. This is a protocol
  amendment note, not a code change.
- **Set `evaluator_weights_sha256`** from the G0 digest, then **set `evaluator_locked_at`**. After
  that the backend refuses an evaluator provider change outright.
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
| rimpl cannot be hosted on the tailnet | High | G0 item 4. Fallback is the Railway userspace sidecar; D3 and D7 both revisited |
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

1. What does `cme-dgx` serve — which models, what context length? Can we hit the inference server
   directly rather than through Open WebUI?
2. Can you run `sha256sum` on the evaluator model's weights, and share the digest?
3. **Can rimpl be hosted on a tailnet node?** (Determines P2's shape.)
4. Is the DGX dedicated to CLICS or shared? What concurrency during a clinic-hours burst?
5. Who operates the box, and can you commit to **no evaluator model changes between lock and study
   end**, with notice?
6. Has `OLLAMA_CONTEXT_LENGTH` been raised? At the default 4096 every evaluation fails.
