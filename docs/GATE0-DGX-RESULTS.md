# Gate 0 — first measurement of the on-prem DGX

**Runs:** 2026-08-31 (round 1) · 2026-09-01 (round 2 — §7)
**Box:** `cme-dev` Open WebUI proxy at `100.68.210.69:3000` over the tailnet
**Model:** `deepseek-v4-flash-dspark` · **Harness:** `scripts/probe/*` (written 2026-08, never run until now)

Phase 0 of [LOCAL-MODEL-ROADMAP.md](LOCAL-MODEL-ROADMAP.md). This is the first time any of these
numbers have existed — the probe harness was authored while the tailnet was down and its README says
so. Everything below is measured, not estimated.

> **Gate 0 verdict: the model PASSES. The deployment does not.**
> PIS-7 output quality is not the problem. Capacity, latency and custody are.

---

## 1. What passed

### JSON contract — the gate

`scripts/probe/json-contract.mjs` ran `PIS7_EVALUATOR_PROMPT` over **26 real PLE transcripts**,
de-identified through the production filter, and applied the identical validation `evaluate.js`
applies.

| outcome | n | share |
|---|---|---|
| ok — parsed, all `d1..d7` valid | 25 | **96.2%** |
| `invalid_json` → `evaluate.js` 502 | 1 | 3.8% |

**PASS**, threshold 95%. Margin is one transcript: 24/26 would have failed.

- `finish_reason` was `stop` on **26/26**. Nothing truncated.
- Output tokens: min 446 · p50 595 · p95 897 · max 920, against a 4096 ceiling —
  **3176 tokens of headroom** at the longest reply. The `max_tokens` bumps recorded in
  `evaluate.js:48-56` are comfortably sufficient for this model.

The single failure is genuinely malformed JSON, not a cut-off. See §4.1 — it is probably recoverable.

### Thai output

`scripts/probe/thai-probe.mjs`, 6 Thai clinical turns under `RIMPL_SYSTEM_PROMPT_EXAMINER`:

| check | rate |
|---|---|
| answered in Thai | 6/6 |
| `(Source, Year)` citation present | 6/6 |
| closing `❓` (what `chat.js` enforces) | 6/6 |
| both, first pass | **6/6 — 0% would trigger `chat.js`'s retry** |

Thai-script share 54–77% (Latin drug and lab names are expected; the 54% turn is worth an eyeball).

**This half is not finished.** The probe says so itself: the automated checks cannot tell whether the
Thai is natural rather than translated, whether the clinical content is at senior-colleague level, or
**whether the cited sources are real**. `hasCitation` matches the *shape* `(Source, Year)` only — a
confidently fabricated reference scores 100%. A Thai-speaking clinician must read the replies.

---

## 2. What does not pass

### Capacity — the decisive result

`scripts/probe/throughput.mjs`, ramp 1→32 concurrent, fixed 150-char prompt, 512-token ceiling:

| conc | reqs | ok | fail | p50 | p95 | agg tok/s | per-req tok/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 6 | 6 | 0 | 51.7s | 55.3s | 9.6 | 9.6 |
| 2 | 6 | 6 | 0 | 67.3s | 72.4s | 14.9 | 7.5 |
| 4 | 12 | 12 | 0 | 86.8s | 94.7s | 21.9 | 5.6 |
| 8 | 24 | 24 | 0 | 126.7s | 145.7s | 30.8 | 3.9 |
| 16 | 48 | 48 | 0 | 150.9s | 285.2s | 41.4 | 3.0 |
| 32 | 96 | 28 | **68** | 279.6s | 297.2s | 15.7 | 2.5 |

Re-run at `--reqs 30` (5× the samples), which **disagrees with the table above**:

| conc | reqs | ok | fail | p50 | p95 | agg tok/s |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 30 | 30 | 0 | 55.1s | 82.9s | 8.3 |
| 2 | 30 | 30 | 0 | 70.8s | 101.9s | 12.9 |
| 4 | 30 | 30 | 0 | 120.0s | 136.3s | 16.5 |
| 8 | 30 | 30 | 0 | 149.1s | 169.3s | 25.6 |
| 16 | 30 | 20 | **10** | 176.8s | 270.2s | 17.7 |
| 32 | 30 | 20 | **10** | 156.1s | 298.4s | 33.2 |

**Knee ≈ 8 at n=30, not 16.** Three ways the two runs contradict each other:

- p95 at concurrency 1 rose from 55.3s (n=6) to **82.9s** (n=30) — the first run's low levels were
  optimistic, exactly the small-sample caveat the probe prints.
- Failures begin at concurrency 16 in the re-run (10/30) where the first run was 48/48 clean.
- The re-run reports `16 → 32` as "+88% scaling" *after* declaring the knee at 8. That is incoherent
  as capacity and reads as queueing plus noise.

**The disagreement is itself the finding: this box's behaviour is not stable across runs.** That is
consistent with another user on the machine, or with the proxy-and-wifi path being the bottleneck
rather than the GPU. Neither run is a number to size a pilot on.

Taking the conservative reading — **saturation knee ≈ 8**. Past the knee the server queues and then
breaks: the n=6 run lost 68 of 96 requests at concurrency 32 (`UND_ERR_HEADERS_TIMEOUT`) with
aggregate throughput *falling 62%*; the n=30 run lost a third of its requests at both 16 and 32.

Two things make this worse than the table looks:

1. **p95 at the knee (169s at n=30, 285s at n=6) exceeds `LOCAL_AI_TIMEOUT_MS` (150s) either way.** At the concurrency the
   box can sustain, requests time out before they finish. `LOCAL_MAX_CONCURRENCY=8` and a 150s
   timeout are mutually exclusive. Raising the timeout means raising the backend's
   `RIMPL_EVAL_TIMEOUT_MS` (180s) in the same change — raising one alone makes the outer timeout fire
   first and hides the cause.

2. **This prompt flatters the box.** 150 input chars, 512 output tokens. PIS-7 scoring sends a whole
   transcript — tens of thousands of input tokens, 4096 output. KV cache is consumed per token held,
   not per request, so the real ceiling for the production mix is materially lower than 8.

A single evaluation at concurrency 1 already takes 69s (§3). Realistic concurrent-physician capacity
on this box is **single digits**, against a protocol target of 75 physicians.

### Latency

| path | p50 | p95 | max | tok/s |
|---|---|---|---|---|
| PIS-7 evaluation (real transcripts) | 69.4s | 100.9s | 108.1s | 8.7 |
| Chat turn (Thai, examiner) | 38.7s | 54.6s | — | 8.4 |

~~Today's Anthropic path returns in seconds.~~ **Corrected in round 2:** measured head-to-head on the
same 26 transcripts, Sonnet's p50 is **21.6s**, not "seconds" (§7.1). Local is **3.2× slower**, not
the order of magnitude implied here. A physician ending a PLE would wait ~1.1 minutes for scoring
against ~22s today. Note `providers/local.js` already raised its ceiling from 85s to 150s because two earlier
DGX evaluations took 82.5s and 87.8s; three of the 26 runs here would have failed the original 85s.

---

## 3. Measurement caveats — read before quoting any number

Every figure above is bounded by things that are **not the GPU**:

- The path is WireGuard over laptop wifi, through an **Open WebUI proxy hop** on `cme-dev`, not a
  direct connection to the inference server. `discover.mjs` flagged this and named the costs: an
  extra hop per clinical turn, per-user API-key lifecycle, UI-layer throttling distorting throughput,
  and token accounting that rimpl bills on.
- Whether anyone else was using the box during the run is unknown.
- The first ramp's p95 came from one or two samples per level. The `--reqs 30` re-run corrected it
  and produced a *different* knee — see §2.

These caveats cut **in the box's favour** — the GPU may well be faster than this. But this is the
only measurement that exists, and it was taken the only way currently possible.

---

## 4. Actionable now, independent of the DGX owner

### 4.1 `502` should be retryable when the provider is local

`services/rimpl-client.js:27-29` classifies `502` as deterministic and never retries it:

```js
// 400/422/502 from RIMPL are deterministic (malformed request / validation /
// un-parseable or out-of-range model output).
const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 422, 502]);
```

That reasoning is correct **for Anthropic**: at temperature 0 the same input yields the same output,
so a retry re-pays for a guaranteed failure. It does **not** transfer to batched vLLM inference,
which is not bit-deterministic even at temperature 0 — the same transcript can parse on a second
attempt.

At the measured 3.8% failure rate that is roughly **6 of the 150 required PLEs** routed to manual QA
that one retry would likely recover. Proposal: retry `502` once when the serving provider is `local`,
keep it deterministic for `anthropic`.

### 4.2 `LOCAL_MAX_CONCURRENCY` default is above the measured knee

`providers/local.js:83` defaults it to 24. Round 2 measured the **real PIS-7 workload** rather than a
toy prompt (§7.4): concurrency 1 and 2 sit inside the 150s budget, concurrency 4 overshoots it by 4s.

**Set `LOCAL_MAX_CONCURRENCY=2.`** That is the highest level with p95 (114s) comfortably inside
`LOCAL_AI_TIMEOUT_MS` (150s), with 36s of headroom for the load variance documented in §7.6. Excess
then waits in rimpl's observable FIFO queue rather than invisibly inside the GPU scheduler.

Do **not** use the toy-prompt knee (8 at n=30, 16 at n=6) for this. It was measured with a 150-char
prompt and a 512-token ceiling; PIS-7 holds roughly 5.5× more KV cache per sequence.

### 4.3 The timeout chain has to move together

`LOCAL_AI_TIMEOUT_MS` (150s) → `RIMPL_EVAL_TIMEOUT_MS` (180s). Any change to sustain concurrency must
raise both, in one change, or the outer one fires first and the logs blame the wrong layer.

---

## 5. What only the box owner can answer

### 5.1 A production network path

CLICS runs on Railway. **Railway cannot reach `cme-dev`**, which is on a tailnet with no advertised
subnet routes, and `cme-dgx` is not a tailnet node at all — it exists only on `cme-dev`'s LAN.

Everything in this document went through a personal browser session token on someone else's machine.
That is a valid way to *measure*; it is not a path CLICS can ship on.

Smallest sufficient ask: `tailscale up --advertise-routes=192.168.1.0/24` on `cme-dev`, approved in
the tailnet admin console. One command. `providers/local.js` already documents that plain `http://`
is acceptable across the tailnet precisely because WireGuard encrypts it end to end.

### 5.2 Model Lock inputs — CREC082 §10.2

The Model Lock Record must exist **before the first participant**, and must name at least: project
model/build, exact DeepSeek base release/version, weight checksum (e.g. SHA-256), inference
engine/version, quantization, evaluator prompt version, PIS-7 rubric version, decoding parameters,
environment version.

| field | status |
|---|---|
| evaluator prompt version | ✅ `pis7-prompt-a849c6b2` |
| PIS-7 rubric version | ✅ `pis7-weights-08b0cb1a` |
| exact DeepSeek base release | ❌ not discoverable through the proxy |
| weight checksum | ❌ |
| inference engine + version | ❌ |
| quantization | ❌ |

`app_settings.evaluator_locked_at = 0` today. Enrolment has not started, so there is still time — but
none of the four missing fields can be obtained from outside that machine.

**`deepseek-v4-flash-dspark` is a custom build name.** §10.2 requires the exact base release it
derives from. Nobody outside the box can determine that.

### 5.3 Custody — the question that actually gates enrolment

CREC082 §10.1 requires inference inside a **project-controlled** environment (CCME v8.0 on GDCC).
`cme-dev` is administered by someone else and currently serves eight models unrelated to CLICS,
pulled by other users.

A Model Lock is a promise that the configuration is frozen from the first participant until the end
of primary analysis. **That promise cannot be made about a machine where another person can pull or
change models.** This is an organisational question, not a technical one, and it does not go away by
solving the network.

---

## 6. Summary

| | |
|---|---|
| PIS-7 JSON contract | ✅ 25/26 = 96.2% |
| Thai — automated checks | ✅ 6/6 |
| Thai — clinician review | ⏳ outstanding, incl. whether citations are real |
| Latency | ⚠️ eval p50 68s / p95 90s vs Sonnet p50 22s — **3.2× slower**, not 20× (§7.1) |
| Capacity — real PIS-7 load | ⚠️ conc 1–2 inside budget, conc 4 overshoots by 4s (§7.4) |
| Timeout chain | ✅ 150s/180s already sufficient at conc ≤ 2 — no change needed |
| Score reproducibility | ❌ **new blocker** — neither model reproducible (§7.3) |
| Load isolation | ❌ shared box; identical work took 57s and 956s (§7.6) |
| Production network path | ❌ none |
| Model Lock inputs | ❌ 4 of 6 unobtainable |
| Project control of the box | ❌ shared machine |

**The expensive question is answered: the model can do PIS-7 on real Thai transcripts.** Round 2 then
found a larger problem underneath it — **the PIS-7 evaluator does not produce reproducible scores
with _either_ model** (§7.3). That is not a local-vs-Claude finding and it is upstream of the
cutover: it questions the instrument, not the provider.

What remains, in the order it should be settled:

1. **Reproducibility of the instrument** (§7.3) — blocks the credit decision for the incumbent too.
2. **Custody** (§5.3) — no amount of engineering makes a shared machine lockable.
3. **A production network path** (§5.1) — one command, but not ours to run.
4. Capacity and latency, which are now the *least* worrying items on this list.

---

## 7. Round 2 — 2026-09-01: head-to-head, reproducibility, real-workload concurrency

Round 1 asked *can the local model do PIS-7 at all*. Round 2 asks the two questions that follow:
**would swapping the evaluator move the scores**, and **are the scores reproducible in the first
place**. The second question was not planned. It came out of an anomaly and it is now the most
important result in this document.

### 7.1 Head-to-head performance

26 de-identified PLE transcripts, identical `PIS7_EVALUATOR_PROMPT` imported from rimpl,
temperature 0 on both arms, concurrency 1. Cloud arm calls the same model production calls
(`anthropic.js:22`, `claude-sonnet-4-6`), read from the provider module so it cannot drift.

| | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|
| local — `deepseek-v4-flash-dspark` | 50.7s | **68.2s** | 90.3s | 101.9s | 69.0s |
| cloud — `claude-sonnet-4-6` | 16.0s | **21.6s** | 30.3s | 65.7s | 23.4s |

**Local is 3.2× slower at p50.** Round 1 implied "seconds vs 69s"; that was an assumption, not a
measurement, and it overstated the gap by roughly 6×.

Cost: cloud ≈ **$0.014 per PLE** (5.1k input + 1–3.2k output). Local is $0 marginal on owned hardware.

### 7.2 Do the two models agree?

| | |
|---|---|
| paired fixtures | 25 (PLE-045 dropped — cloud schema failure) |
| composite ICC(A,1) | **0.594** |
| bias (local − cloud) | **−2.20** on a 35-point composite |
| Bland–Altman limits of agreement | **−11.51 … +7.11** |

Per-domain ICC(A,1): d6 0.723 · d5 0.686 · d3 0.623 · d2 0.477 · d7 0.381 · d4 0.333 · **d1 0.252**.

**Do not read this as "Sonnet is better."** §7.3 shows the noise floor is the same size as the
signal, so most of what this table measures is the instrument, not the difference between two models.

### 7.3 Reproducibility — the finding that matters

Same fixture, same prompt, temperature 0, repeated. Five sessions across the day.

**Within a session**, the local model's Σ|Δ| across 5 repeats ranged **0 to 8** depending on fixture
and session. There is no reliably quiet regime — an early session that produced 0/3/2 looked stable
and was not representative.

**The cloud arm is not stable either, and fails on different transcripts.** On PLE-045:

| | local | cloud |
|---|---|---|
| composites over repeats | 16, 16, 16, 16, 17 | **12, 16, 21, 13** |
| schema failures | 0/5 | **2/6** |
| noise floor Σ\|Δ\| | **1** | **11** |

PLE-045 is the transcript that broke the cloud arm in §7.2 — and it is the one the local model
handles most consistently. **The two models' failure sets are largely disjoint**, which kills the
convenient explanation that "some transcripts are just hard."

**The error is majority common-mode.** Removing a single per-run level term from each 7-domain vector
explains **59% of run-to-run variance pooled** (range 14–82% by fixture). The seven domains move
together more often than not, so summing them does not average the error away — it largely multiplies
it. PLE-051's composite standard deviation is 3.1 on a 35-point scale, i.e. a ~12-point 2σ spread
from re-running an identical prompt.

> **Consequence.** The PIS-7 composite is the *least* reliable summary of the seven domains, not the
> most. Any credit threshold applied to it inherits that spread.

A caveat on method, recorded because it changed the conclusion twice: a "uniform ±1 shift across all
seven domains between sessions" looked like a clean systematic offset on three fixtures and did not
survive a fourth and fifth session. Each cross-session row is a *mode*, and when within-session
spread is large the mode is itself a noisy estimate. Only PLE-002 replicated a genuine uniform −1
three times.

**Not yet tested:** every session above shares one box-day. Cross-day drift — the case Model Lock
§10.2 actually cares about — needs a cold run on a later date.

### 7.4 Concurrency on the real PIS-7 workload

Round 1's ramp used a 150-char prompt with a 512-token ceiling. PIS-7 sends whole transcripts
(p50 ~2,435 input tokens, max ~7,346) and generates ~595, so it holds ~5.5× more KV cache per
sequence. Re-measured with real fixtures and the real prompt, on a quiet box:

| conc | n | ok | p50 | p95 | agg tok/s | vs `LOCAL_AI_TIMEOUT_MS` 150s |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 4 | 4/4 | 65s | 95s | 9.0 | ✅ 55s headroom |
| 2 | 4 | 4/4 | 88s | 114s | 13.2 | ✅ 36s headroom |
| 4 | 8 | 8/8 | 119s | 154s | 18.7 | ❌ over by 4s |

Aggregate throughput was still rising +42% at concurrency 4 — **no knee was found in the tested
range**. A prediction that KV-cache pressure would force a knee at 3–4 was not borne out.

**Recommendation: `LOCAL_MAX_CONCURRENCY=2`.** The existing 150s/180s timeout chain is already
sufficient at that level and needs no change.

**Capacity is not the constraint.** 168 PLEs at concurrency 2 ≈ 2.1 hours for the entire pilot corpus.

### 7.5 `max_tokens` is oversized but harmless

Across 26 real evaluations: output min 446 · p50 595 · p95 897 · **max 920**, against a 4096 ceiling,
with `finish_reason: stop` on 26/26. Nothing ever approached the limit.

Trimming to 1536 would keep 1.67× headroom over the largest observed reply, but **would not reduce
latency** — generation already stops on its own. It helps only if the server reserves KV cache by
`max_tokens` rather than paging on demand, which is untested. Low priority.

### 7.6 The box is shared, and it shows

The same concurrency ramp run twice, two hours apart:

| | 14:05 | 14:44 (quiet) |
|---|---|---|
| conc 1, serial PIS-7 | p50 57s, **p95 956s**, **2/4 failed** | p50 65s, p95 95s, 4/4 ok |
| tiny completion, same box | — | **0.4s** ×3 |

The endpoint was healthy throughout. The most likely explanation is another user's workload — the box
serves models unrelated to CLICS, pulled by other people (§5.3) — but this cannot be confirmed from
outside, and that is the point.

One anomaly is unexplained: a call recorded 956s against its own 600s abort. Either the abort did not
fire or elapsed time is measured across something the timeout does not cover. Flagged, not resolved.

**No `LOCAL_MAX_CONCURRENCY` or timeout value protects against a neighbour's job.** A latency SLA on
local evaluation is unenforceable while CLICS is a guest on this machine. This is the same custody
problem as §5.3, arriving through a different door.

### 7.7 Corrections to earlier claims

Recorded because each was stated confidently before being checked:

| claim | status |
|---|---|
| "Anthropic returns in seconds" | ✗ measured 21.6s p50; gap is 3.2×, not ~20× |
| "cloud arm is essentially deterministic" | ✗ tested only easy fixtures; PLE-045 ranges 12–21 |
| "local is stable within a session" | ✗ generalised from one quiet session; Σ\|Δ\| reaches 8 |
| "uniform ±1 shift is not sampling noise" | ✗ over-fit to n=3; broke at n=5 |
| first variance decomposition | ✗ vacuous — `composite = 7 × level` is an identity |
| `LOCAL_AI_TIMEOUT_MS` = 85s in the concurrency probe | ✗ real value is 150s; every "exceeds timeout" verdict was wrong by 65s |
| `model-agreement.mjs` anti-drift guard | ✗ bare `require` in ESM threw, was swallowed by `catch`, fell through to a hardcoded default — fixed; the value happened to match, so the comparison was valid |

### 7.8 Reproduce

```
node scripts/probe/model-agreement.mjs      --out agreement.json
node scripts/probe/repeat-consistency.mjs   --arm local|cloud|both --repeats 5 --only PLE-045
node scripts/probe/compare-sessions.mjs     s1=agreement.json s2=noise.json ...
node scripts/probe/pis7-concurrency.mjs     --levels 1,2,4 --max-tokens 4096
```

None prints transcript text. `pis7-concurrency.mjs` reads the timeout budgets out of
`providers/local.js` and `rimpl-client.js` rather than hardcoding them, after the §7.7 error.

The plain-language summary for a non-technical reader is built by
`scripts/probe/report/local-ai-summary.py` (docx + html) and
`scripts/probe/report/local-ai-summary-pdf.mjs` (A4 PDF), output to `docs/reports/`. The PDF step
fails the build if TH Sarabun New does not resolve, rather than silently printing Thai in a
fallback face.

---

*Reproduce: `scripts/probe/{discover,json-contract,thai-probe,throughput}.mjs`. Fixtures are built by
`scripts/probe/build-fixtures.mjs` from real PLEs through the production PII filter; `fixtures/` is
ignored via the NESTED `scripts/probe/.gitignore` (`fixtures/*`), not the root one — `git check-ignore`
on the directory reports "not ignored", which is misleading; check a file inside it. Only `.gitkeep` is
tracked, and no fixture has ever been committed. No script here prints transcript text.*


## 8. What was built from these numbers (2026-09-02)

The measurements above became design constraints the next day; the record of what each number forced is
in [LOCAL-MODEL-ROADMAP → The capacity layer](LOCAL-MODEL-ROADMAP.md) and the honest reading of the
15 September milestone in [LOCAL-MODEL-CUTOVER → Measured position 2026-09-02](LOCAL-MODEL-CUTOVER.md).
In one line each: the concurrency knee (§7.4) → `LOCAL_MAX_CONCURRENCY=2` and a two-lane bounded runner;
the 68 s p50 and the 57 s → 956 s swing (§7.6) → a durable FIFO evaluation queue with a lease and backoff,
and a physician-visible *queued → scoring* state; the $0 price → token-denominated budgets; the unknown
input ceiling → a 64k transcript-cap **trial** plus `context-limit.mjs --synthetic` to measure the real
one; and the non-reproducibility (§7.3) → adaptive self-consistency gated by D18 on a held-out split
reserved before any prompt was touched (`scripts/probe/SPLIT.json`).

### 8.1 Capacity ramp, 2026-09-02 — the input ceiling is not the constraint; chat decode is

`context-limit.mjs --synthetic --sizes 8k…96k --shape both --repeats 2` (synthetic clinical filler with a
sentinel token, `PROBE_TIMEOUT_MS=600000`, shared box, early afternoon). "served" = the server's own
`usage.prompt_tokens` — the unit every setting below is expressed in; the probe's size labels are chars/4.

| probe size | eval served | eval p50 / p95 | chat served | chat p50 / p95 | sentinel |
|---|---|---|---|---|---|
| 8k | 6,593 | 59 s / 181 s | 6,153 | 60 s / 78 s | 2/2 · 2/2 |
| 16k | 12,001 | 76 s / 204 s | 11,561 | 54 s / 74 s | 2/2 · 2/2 |
| 24k | 17,396 | 48 s / 78 s | 16,956 | 79 s / 83 s | 2/2 · 2/2 |
| 32k | 22,804 | 48 s / 52 s | 22,364 | 76 s / 97 s | 2/2 · 2/2 |
| 48k | 33,607 | 44 s / 78 s | 33,167 | 67 s / 94 s | 2/2 · 2/2 |
| 64k | 44,410 | 38 s / 102 s | 43,970 | **107 s / 107 s** | 2/2 · 2/2 |
| 96k | 66,029 | 48 s / 124 s | 65,589 | 91 s / 92 s | 2/2 · 2/2 |

Three readings, in order of importance:

1. **No input ceiling was found.** The sentinel was recalled in every repeat of every size, up to 66,029
   served tokens — three times the 22,804 verified in §7. The "silent truncation" failure mode this
   probe exists to catch did not occur.
2. **Chat latency does not scale with the transcript; it is decode-bound and noisy.** A chat-shaped turn
   took 54–107 s whether the prompt was 6k or 66k tokens, and the 8k *eval* call had a 181 s p95 while
   the 96k one had 124 s. That is the shared box (§7.6), not the prompt. The plan's rule "cap = largest
   size with chat p95 < 0.6 × `RIMPL_CHAT_TIMEOUT_MS` (60 s)" therefore verifies **nothing** — it fails at
   8k. What the numbers do say: with the 100 s chat timeout inherited from Claude, a turn at ~44k
   served tokens (the 64k row) times out at p50, and turns at every size sit within a few seconds of it.
3. **Working recommendation** (superadmin settings + laptop `.env`, all in server tokens):
   `ple_max_transcript_tokens = 64000` — keep the agreed trial; the box holds it and evaluation at that
   size is 48 s p50. `RIMPL_CHAT_TIMEOUT_MS = 150000` on the local stack (matching `LOCAL_AI_TIMEOUT_MS`):
   a 100 s deadline throws away turns the box finishes at 107 s and the physician still waited.
   `LOCAL_AI_MAX_PROMPT_TOKENS = 66000` — the largest served size verified, as the backstop. The
   physician-facing cost is unchanged by any of this: **a chat turn on `cme-dev` takes a minute or more
   today at any transcript length**, which is a box/custody problem (§5.3), not a setting.

### 8.2 Concurrency on the real PIS-7 workload, 2026-09-02 — the box scales to 3

`pis7-concurrency.mjs --levels 1,2,3` (26 real de-identified fixtures cycled, warm-up discarded, right after
the ramp above, same shared box):

| concurrent | n | ok | p50 | p95 | aggregate | vs previous level |
|---|---|---|---|---|---|---|
| 1 | 4 | 4/4 | 62 s | 84 s | 8.9 tok/s | — |
| 2 | 4 | 4/4 | 82 s | 104 s | 13.1 tok/s | +47 % throughput, p95 +25 % |
| 3 | 6 | 6/6 | 94 s | 109 s | 17.2 tok/s | +31 % throughput, p95 +4 % |

Unlike §7.4 (p95 154 s at 4, over the timeout), every level here finished inside `LOCAL_AI_TIMEOUT_MS`
(150 s) with zero failures, and throughput kept scaling. The rule in the plan — the largest level with
p95 < 0.8 × 150 s = 120 s — gives **`LOCAL_MAX_CONCURRENCY = 3`**, with `LOCAL_INTERACTIVE_RESERVE = 1`
(two background evaluations + one chat slot always reachable). Two caveats before treating 3 as settled:
the sweep ran at one time of day on a box whose latency swung 57 s → 956 s last week (§7.6), and while
`EVAL_CONSISTENCY=adaptive` is on the drain should stay at width 1 (one evaluation = 2–3 serial calls
against a 480 s deadline; see deployment.md), so the extra slots mostly buy chat headroom. Re-run the
sweep from the smoke's `capacity` scenario on the day the settings are actually set.

### 8.3 The evaluator's noise floor, measured — and what it does to the D18 gate (2026-09-02 evening)

`repeat-consistency.mjs --arm local --split tuning --fixtures 18 --repeats 5`, single calls,
temperature 0, the identical prompt every time. Per fixture, Σ over d1..d7 of (max − min) across its
five runs — the most that arm alone can move:

| fixtures with ≥2 parsed runs | Σ\|Δ\| per fixture | median | max | at or below the D18 bar of 2 |
|---|---|---|---|---|
| 10 of 18 (the box degraded mid-run) | 1, 1, 1, 3, 5, 7, 8, 8, 9, 10 | **6** | 10 | **3 / 10** |

Beside it, the same day, the local-vs-Sonnet agreement on the tuning split (n=16 pairs):
Σ\|Δ\| median **4**, composite ICC(A,1) **0.578** weighted / 0.591 unweighted, bias −2.50.

**Read those two lines together.** Over five runs of the same transcript the local model moves by a
median of five to six rubric points; between one local run and one Sonnet run the gap is four. **The
model disagrees with itself about as much as it disagrees with the incumbent**, so the agreement
number is largely measuring noise, and the D18 screening gate cannot be reached by collecting more
pairs: `screening-verdict.mjs` reports `insufficient` and, at a point estimate of 0.578, no number of
pairs clears a 0.75 lower bound.

Two things this rules out and one it does not:
- **Adaptive self-consistency as configured does not fix it.** ICC with the rule ON (0.578) matches
  the single-call measurement (0.594), because the pair test asks only that no single domain differ
  by more than one — and the drift is a near-uniform ±1 shift across five or six domains at once,
  which passes. Σ\|Δ\| between the two calls is 5–6 while max \|Δ\| is 1.
- **More data does not fix it.** The point estimate, not the interval, is the obstacle.
- **Not yet ruled out:** the two levers built today and still unmeasured — `median3` (always three
  calls) or `adaptive` with `EVAL_CONSISTENCY_MAX_SUM_DELTA=2`, which sends exactly the uniform-shift
  pair to a third call, and the local prompt addendum aimed at d1 (ICC 0.06) and the −2.5 bias.

**Custody, again.** Ten of eighteen fixtures produced usable runs: from about 16:50 the box began
failing large-context calls, and by 23:20 a 30-token prompt answered in **1 second** while the
smallest tuning transcript exceeded **10 minutes**. Nothing in CLICS changed in between; two probe
runs sharing the box started it, and it did not recover when they stopped. A measurement programme
cannot be scheduled against a machine whose large-context latency moves by two orders of magnitude
without notice (§5.3, §7.6).

### 8.4 The prompt addendum measured — the noise floor is reducible, and the prompt is the lever (2026-09-03/04)

§8.3 left the addendum unmeasured. Measuring it needed one tooling change first: `repeat-consistency.mjs`
gained `--addendum on|off`, because the v0 baseline in §8.3 predates `PIS7_LOCAL_ADDENDUM` and comparing
against it with the addendum on would have moved two variables at once. `off` reproduces the pre-addendum
prompt; `on` is what rimpl ships today.

Three runs, same design throughout — same transcript ×5 repeats, temperature 0, identical prompt each time,
tuning split, single calls:

| run | box condition | addendum | n (≥2 parsed) | Σ\|Δ\| per fixture | median | max | ≤ D18 bar of 2 |
|---|---|---|---|---|---|---|---|
| v0 (§8.3) | contended | off | 10 of 18 | 1, 1, 1, 3, 5, 7, 8, 8, 9, 10 | 6.0 | 10 | 3 / 10 |
| 2026-09-03 | quiet | **off** | 11 of 18 | 0, 0, 0, 1, 3, 5, 7, 7, 8, 11, 12 | 5 | 12 | 4 / 11 |
| 2026-09-03/04 | overnight | **on** | **18 of 18** | 0,0,0,0,0,0,0,1,1,1,1,1,2,2,6,7,7,7 | **1.0** | 7 | **14 / 18** |

**Row 1 → row 2 answers §8.3's open question about the box:** with the addendum still off and the box quiet
(68–76 s per call across the first eleven fixtures), the distribution keeps its shape — median 6.0 → 5, max
10 → 12. Contention was not what produced the noise floor.

**Row 2 → row 3 is the result.** Paired over the eleven fixtures that completed in both of today's runs, so
the fixture set is held constant:

| direction | fixtures | detail |
|---|---|---|
| improved | 6 | PLE-005 12→0 · PLE-012 11→0 · PLE-011 8→1 · PLE-002 7→0 · PLE-001 5→0 · PLE-008 3→2 |
| unchanged | 3 | PLE-007 7→7 · PLE-006 1→1 · PLE-032 0→0 |
| **worse** | **2** | **PLE-030 0→7 · PLE-037 0→2** |

Mean change **−3.09**. Net improvement is large and not attributable to sampling: the same fixtures, the
same rule, one variable changed.

**The box-quietness confound is separately excluded, because latency and noise are uncorrelated in row 3.**
PLE-002 was the slowest fixture at 175 s and scored Σ\|Δ\| 0; PLE-030 was among the fastest at 65 s and
scored 7 — the maximum. Were the variance driven by contention, the slow fixtures would be the noisy ones.
They are the opposite (latency range 59.4–176.9 s, mean 88.9 s).

What this does **not** establish:
- **It is not uniform.** Two fixtures moved from perfectly stable to noisy. Nothing yet explains what they
  share, and "the addendum is safe on every transcript" is not supported by this data.
- **Self-consistency is not agreement.** A model can become perfectly repeatable and stay systematically
  apart from the incumbent — these are different properties. The ICC(A,1) of 0.578 in §8.3 was measured
  *before* the addendum existed (`tuning-agreement-v0.json` records `git_head 496ad1d`, which predates
  `330dc9a`/`04d2db7`); re-measuring it with the addendum on is the run that decides whether D18 is reachable,
  and an early in-run example already shows the distinction: on PLE-002 the two local calls agreed with each
  other exactly (max Δ 0) while the local-vs-Sonnet gap was Σ\|Δ\| 10.
- **The held-out split is still untouched.** No variant has been taken to `screening-verdict.mjs`.

**Custody, for the third time — and one good sign.** Both daytime runs lost the box partway (10 and 11 of 18
fixtures). The overnight run completed **18 of 18** with only three fixtures showing any transport failure.
The box can sustain a full 90-call workload when nothing else is on it; it cannot when something is. That is
a scheduling constraint, not a model property.

Data: `scripts/probe/report/noise-2026-09-03-noaddendum.json`, `noise-2026-09-03-addendum.json`, against
`tuning-repeat-v0.json`.

### 8.5 Connecting to the box — the API path, and what is actually behind cme-dev (2026-09-04)

Three wrong diagnoses in one morning are worth recording, because each failure mode reads like a broken box:

| call | result | what it actually means |
|---|---|---|
| `POST /v1/chat/completions` | **405** | wrong path, not a blocked route. `discover.mjs` recommends `/v1`; that advice is wrong for this Open WebUI gateway, which serves only `/api/v1` |
| `POST /api/v1/chat/completions`, no key | **401** | missing auth, not a dead endpoint |
| any path, short `--max-time` | curl **000** / **28** | the model takes 60–180 s **even for a two-token reply** (measured 99 s). Anything under ~240 s times out on a healthy box |

The working target is `LOCAL_AI_BASE_URL=http://100.68.210.69:3000/api/v1` **with `LOCAL_AI_API_KEY` set**.
The gitignored `~/.clics-dgx.env` holds that credential under a *different* variable name (`OPENWEBUI_KEY`),
so sourcing it alone sets nothing the probes read. A working browser chat at `:3000` proves the model is
alive and proves nothing about the API path — the UI uses its own internal route.

**`cme-dgx` exists.** §5.1 already had this right ("not a tailnet node at all — it exists only on `cme-dev`'s
LAN"); `docs/domain-concepts.md` did not, and asserted the box "does not exist" / "points at nothing",
reasoning from its absence on the tailnet. That inference was wrong and is now corrected there. Open WebUI's own
Connections panel lists the real upstreams behind the gateway:

| connection | kind | note |
|---|---|---|
| `http://cme-dgx:8888/v1` | OpenAI-compatible | resolves only inside the box's LAN |
| `http://192.168.1.178:8000/v1` | OpenAI-compatible | `:8000` is the vLLM/SGLang default — the likely real inference server |
| `http://192.168.1.111:11434` | Ollama | enabled |
| `http://192.168.1.177:11434` | Ollama | disabled |

The served backend is vLLM, confirmed by `system_fingerprint: vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2` in
the response body. These hosts sit on a private `192.168.1.0/24` that cme-dev does **not** advertise as a
subnet route (`tailscale status --json` → `PrimaryRoutes: None`, `AllowedIPs` only its own /32), so they are
unreachable from the tailnet today — verified by timeout to the IP and DNS failure on the hostname.

This adds a deploy option that did not exist while `cme-dgx` was believed fictional: `tailscale up
--advertise-routes=192.168.1.0/24` on cme-dev plus route approval in the Tailscale console would let rimpl
reach the inference server directly, dropping the Open WebUI hop — the hop that costs an extra network leg
per clinical turn, applies its own queueing to any throughput measurement, ties access to one human's API
key, and produced the path confusion above. It needs shell on cme-dev, which is the same ask as §5.1.

### 8.6 Both levers measured against the incumbent — the blocker moved, twice (2026-09-04)

§8.4 measured the addendum's effect on *repeatability*. This section measures what it, and the
`median3` rule, do to *agreement with Sonnet* — the number D18 actually gates on. Three runs on the
tuning split, same fixtures, same cloud arm:

| run | prompt | rule | n pairs | ICC(A,1) weighted (95% CI) | bias | Σ\|Δ\| median | JSON % |
|---|---|---|---|---|---|---|---|
| v0 (§8.3) | base only | adaptive | 16 | 0.578 (0.116–0.835) | −2.50 | 4 | 100.0% |
| 2026-09-04 | base + addendum | adaptive | 14 | 0.735 (0.335–0.910) | +0.79 | 2 | 94.4% |
| 2026-09-04 | base + addendum | **stamped `median3`, ran adaptive** | 15 | 0.762 (0.410–0.917) | +0.00 | 2 | 94.4% |

**Rows 2 and 3 are the same configuration.** `model-agreement.mjs` hardcoded `mode: 'adaptive'` from
`a79f4d3` until 2026-09-04 while stamping the `--consistency` flag into the report, so the run labelled
`median3` ran adaptive. Both logs agree call-for-call: 15 rows at `calls 2` and 2 at `calls 2+1 re-ask`,
where a real `median3` cannot short-circuit and must show `calls 3` on every row. **The 0.735 → 0.762
difference is re-run variance on n=14/15, not a rule effect, and `median3` remains unmeasured.**

**What improved.** The addendum carries the gain: 0.578 → 0.735, and −2.50 of harshness down to +0.79.
Read alongside §8.4's repeatability result (Σ|Δ| median 6 → 1, `screening-verdict` now reports
repeatability **ok**), the blocker §8.3 identified — a model that disagreed with itself as much as with
the incumbent — is cleared. **The second run adds nothing to that**: it was the same configuration, so
0.762 and a bias of exactly zero are what a re-run of the same setup produced on a different 15 fixtures.
Two draws from one configuration landing at 0.735/+0.79 and 0.762/+0.00 is itself the sharpest available
evidence for how wide the sampling noise is at this n.

**Why it is still `insufficient`, and why that is a different problem.** 0.762 clears the 0.75
threshold as a point estimate for the first time, but the interval is 0.410–0.917 on 15 pairs. The
tool computes **4,899 pairs** to lift the lower bound past 0.75 at that point estimate. §8.3's "more
data does not fix it" therefore still holds, for the same reason: the point estimate has to rise
(0.90 → 19 pairs, 0.92 → 14). What changed is that it is now within sight rather than out of reach.

**A second constraint, and three wrong answers about it in one day.** The honest number is **94.4%**
valid JSON, below the 98% bar, down from **97.4%** before the addendum. Getting there took two
retractions worth recording, because each error had a different shape:

| reading | basis | verdict |
|---|---|---|
| 95.4% (103/108) | fixtures, charging transport failures and cloud-arm failures to the model | wrong — pessimistic |
| 100% (86/86) | replies only, but excluding `Pis7ScoreError` and counting one fixture as one call | **wrong — optimistic, and worse** |
| **94.4% (34/36)** | every local CALL, excluding only transport, counting re-asks | current |

The second reading is the dangerous one and it was mine. It excluded `Pis7ScoreError` on the theory
that it meant "timeout", when `rimpl/src/lib/pis7.js` throws it for `invalid_json` and
`invalid_scores` and `consistency.js` re-raises it only after the re-ask budget is spent — the model
failing its contract N+1 times, which is precisely what this bar exists to catch. It also counted an
adaptive row as one attempt when the row is 2–3 calls plus re-asks. Both errors pushed the same way.
**A measurement error that flatters the model is not symmetric with one that libels it:** the second
gets caught by the next run, the first ships.

The underlying ambiguity is real and cannot be fixed by inspecting error strings. `chatCompletion`
never throws — a timeout returns `{ ok:false, text:'' }`, the empty string parses to `{}`, the schema
fails, and the result is a `Pis7ScoreError` indistinguishable from genuine garbage. Fixed 2026-09-04
at the call sites, where `ok` is still visible: transport is stamped there, both probe scripts now
persist the error kind, and both consumers count calls rather than fixtures. Reports written earlier
cannot be re-scored and are flagged as a floor rather than a rate.

**So the addendum is implicated after all** — 97.4% → 94.4% is the only change alongside it, and
04d2db7 already had to move the output contract to the end of the prompt once for this exact failure.
Worth fixing before another agreement run: bad parses cost pairs, and pairs are what the interval needs.

**Do not report the per-domain ICCs from these runs as findings.** d1 reads 0.055 → 0.663 → 0.294
across the three runs. At n = 14–15 the per-domain intervals are wide enough that a swing of that
size is what chance produces; the tempting story ("the addendum rescued d1, at d6's expense") does
not survive the third measurement, in which d6 recovers to 0.745 and d1 collapses. One signal is
stable enough to act on:

| | v0 | addendum | median3 |
|---|---|---|---|
| **d4 Iterative Inquiry** (weight 0.15) | 0.425 | 0.552 | 0.530 |

**d4 is the weakest domain in all three runs**, and it is the hardest kind of weak: the two models'
means agree (Δ −0.07) while their per-case ranking does not. There is no offset to subtract, so
calibration cannot touch it — only the domain's criterion or its prompt text can. If the point
estimate has to rise, d4 is where the headroom is.

**`median3` is still unmeasured.** The run that carried its name did not use it. The latency figures
first attributed to it (p50 193 s, range 173–686 s, 3 of 18 fixtures lost) are therefore the cost of a
second *adaptive* run on a slow afternoon — a real datum about the box, and no datum at all about the
rule. A true `median3` makes three calls on every fixture with no short-circuit, so its cost against the
480 s eval deadline at `eval_drain_concurrency=1` is strictly worse than anything measured here, and
still unknown.

Data: `scripts/probe/report/tuning-agreement-{v0,addendum,median3}.json`; rows recorded in
`scripts/calibration/prompt-versions.md`. Held-out split still untouched.
