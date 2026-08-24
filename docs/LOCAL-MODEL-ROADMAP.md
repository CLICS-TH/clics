# Local-Model Roadmap — เชื่อม CLICS กับ on-prem LLM

Plan for moving CLICS's AI calls from the Anthropic cloud API to a self-hosted model on the
`cme8.org.github` Tailscale network (`cme-dgx`, `100.119.96.52`).

**Status:** proposed, not started. **Author date:** 2026-08-24.

---

## 0. The timing constraint — read this first / ข้อจำกัดด้านเวลา

**We are inside the pilot study window.** [`pilot-timeline.md`](pilot-timeline.md) puts the Pilot
Study at **Aug–Sep 2026** (75 physicians × 3 CLEs = 225 CLEs), and live scoring is demonstrably
running (CLE-052, a 130k-token transcript, was evaluated 2026-08-17).

Swapping the model mid-pilot would split the cohort across two scoring systems — some CLEs scored by
`claude-sonnet-4-6`, some by a local model — which confounds the study's primary outcome. The
protocol already anticipates this: §10.2 requires a **locked** model + prompt + rubric per
evaluation, and `rimpl/src/lib/versions.js` records all three per row.

The same argument applies to `chat`: the CLE1/2/3 Socratic experiment (NATURAL vs EXAMINER) is an
active manipulation. Changing the underlying model mid-experiment confounds that too.

> **Therefore: build and validate during the pilot; cut over at a clean boundary (target Oct 2026).**
> This is not a delay — the pilot generates 225 scored transcripts, a far better calibration corpus
> than the 10-CLE soak cohort the current ICC figure rests on.

---

## Why do this at all / เหตุผล

| Driver | Assessment |
|---|---|
| **Data sovereignty** | **Strong.** Today Critical Rule #1 holds because de-identification runs before a cloud hop. On-prem inference removes the cloud leg entirely — de-id becomes defence-in-depth rather than the sole barrier. Much better PDPA posture for a licensing body. |
| **Cost** | **Modest at pilot scale.** ~$0.012/turn against a $0.50/user cap ⇒ 225 CLEs is low hundreds of USD. Becomes material only at national scale (tens of thousands of physicians). |
| **Latency / rate limits** | **Real but secondary.** `CLAUDE_MAX_CONCURRENCY=12` exists because bursts tripped Anthropic's rate limit (~33% success at 40 concurrent). A local box is bounded by VRAM, not by someone else's quota. |
| **No-training / ZDR** | Currently satisfied by an org-level DPA, not by code (see `rimpl/src/services/claude.js:4-9`). On-prem makes it structural. |

---

## The seam is already clean / จุดเชื่อมพร้อมแล้ว

Every AI call funnels through **one function** — `callClaude()`, `rimpl/src/services/claude.js:86`:

| Call site | Job | max_tokens | Migration risk |
|---|---|---|---|
| `routes/evaluate-criteria.js:29` | C4–C6 booleans | 200 | **Low** — tiny fixed JSON |
| `routes/chat.js:75,94` | CLE dialogue | `RIMPL_CHAT_MAX_TOKENS` | **Medium** — highest volume; already retries on format violation (`chat.js:78`) |
| `routes/audit-discuss.js:68` | auditor calibration tutor | `RIMPL_DISCUSS_MAX_TOKENS` | **Medium** |
| `routes/evaluate.js:38` | **PIS-7 scoring** | 4096 | **High — ICC-gated, drives CME credit** |

Cost accounting is likewise one file: `backend/src/lib/pricing.js` (`CLAUDE_INPUT_PER_M` /
`CLAUDE_OUTPUT_PER_M`). Provenance auto-derives: `versions.js:14` computes
`MODEL_VERSION = CCME_LLM_v8.0+${MODEL}`, so a model swap **automatically** bumps the recorded
version and the DB can tell the two populations apart with no extra work.

---

## Phase 0 — Probe / สำรวจ  *(½ day, no repo changes)*

Cheapest possible answer to "is this even viable".

1. **Access.** Tailscale invite to `cme8.org.github`, or an Open WebUI API key from `cme-dev:3000`.
2. **Find the real endpoint.** Open WebUI is a chat UI that proxies. For server-to-server, hit the
   inference server on `cme-dgx` directly (vLLM / SGLang / Ollama, typically `:8000/v1`) — fewer
   hops, no per-user API-key semantics, no UI-layer throttling. Confirm what's actually running.
3. **JSON-contract probe.** Feed 10 real de-identified transcripts + `PIS7_EVALUATOR_PROMPT` to the
   local model. Count how many return parseable JSON with `d1..d7` all integers in 0–5 (the exact
   check `evaluate.js:24-27` enforces).
4. **Thai probe.** Run a few chat turns in Thai. Check fluency, the `(Source, Year)` citation, and
   the closing `❓`. Thai is where open models most often disappoint, and CLICS is bilingual.

> ### 🚦 Gate 0 — JSON parse rate ≥ 95% AND Thai output is clinically usable.
> Fail here and stop. Nothing downstream matters.

---

## Phase 1 — Provider adapter / ตัวแปลง  *(1–2 days)*

Introduce a provider seam without changing any caller.

- New `rimpl/src/services/provider.js` exposing the **same** `callClaude({systemPrompt, messages,
  maxTokens})` signature and the same return shape
  `{text, inputTokens, outputTokens, tokenCount, stopReason}`.
- `AI_PROVIDER=anthropic|local`, **defaulting to `anthropic`**.
- Keep `MODEL` exported — `versions.js` imports it for provenance.
- Reuse the concurrency limiter and retry/backoff wholesale; they are provider-agnostic. Retune the
  constants: a local box is GPU/batch-bound, not quota-bound, so `CLAUDE_MAX_CONCURRENCY` and
  `RETRYABLE_STATUS` mean different things.
- `logRateLimit()` goes quiet (no `anthropic-ratelimit-*` headers). Fine — but replace it with a
  local queue-depth log so capacity is still observable.

**Field mapping (Anthropic → OpenAI-compatible):**

| Anthropic | OpenAI-compatible |
|---|---|
| top-level `system` param | `{role:"system"}` as first message |
| `usage.input_tokens` / `output_tokens` | `usage.prompt_tokens` / `completion_tokens` |
| `stop_reason: "max_tokens"` / `"end_turn"` | `finish_reason: "length"` / `"stop"` |
| `content[]` blocks → join `.text` | `choices[0].message.content` (string) |
| `cache_control: {type:"ephemeral"}` | no equivalent — drop when `AI_PROVIDER=local` |

**Tests:** mirror `rimpl/tests/claude.test.js` for the local path (retry, non-retry, concurrency
queue). `rimpl/tests/pii-leak-adversarial.test.js` must stay green — the PII boundary sits *upstream*
of the provider and must not move.

Precedent for the HTTP shape already exists in-repo: `rimpl/src/services/rag.js` does bearer + fetch
against an OpenAI-compatible endpoint.

---

## Phase 2 — Network bridge / เชื่อมเครือข่าย  *(parallel with Phase 1)*

**The problem:** rimpl runs on Railway. `cme-dgx` is a Tailscale CGNAT address. Railway is not on
that tailnet and won't be by default.

| Option | Verdict |
|---|---|
| **Move rimpl on-prem** onto a tailnet node | **Preferred.** rimpl is *defined* as the on-premise layer ([architecture.md](architecture.md)); this makes deployment match the design instead of contradicting it. |
| **Tailscale userspace inside the Railway container** (`--tun=userspace-networking` + SOCKS5, or `tsnet`) | Workable bridge. Costs an auth key in Railway env and one more failure mode. |
| **Expose the DGX publicly** (Funnel / reverse proxy) | **Reject.** Inverts the entire on-prem premise. |

Also in this phase:

- **Readiness.** `isAnthropicClientReady()` (`claude.js:129`) becomes provider-aware — for local,
  ping `/v1/models` instead of checking for an API key. Feeds `/health/deep`.
- **Timeouts.** The 85s SDK timeout and backend's `RIMPL_EVAL_TIMEOUT_MS` (100s) were tuned to
  Claude's generation speed on a 130k-token transcript. Local time-to-first-token and tokens/sec
  will differ — re-measure, don't assume.

---

## Phase 3 — Migrate the low-risk paths / ย้ายทางที่เสี่ยงต่ำ  *(1 day, post-pilot)*

Order matters. Cheapest and most reversible first.

1. `evaluate-criteria` — 200 tokens, three booleans, no scoring impact.
2. `audit-discuss` — auditor-facing, not scored, separate budget pool.
3. `chat` — the volume. Do it only once 1 and 2 have been stable for a week.

**Per-route provider selection must be a first-class feature, not a hack:** `RIMPL_CHAT_PROVIDER`,
`RIMPL_EVAL_PROVIDER`, etc. A permanent hybrid (chat local, scoring on Claude) is a legitimate and
possibly final end state.

**⚠️ Cost-accounting design point.** `pricing.js` is global — one input/output rate for the whole
system. Under a hybrid, per-user spend and per-council billing would silently misreport. Fix by
passing a per-call rate (or a provider tag) through `usage.js:65`, which already accepts a
`costOverride`. Do this *before* the first hybrid route ships, not after.

---

## Phase 4 — Calibrate the evaluator / สอบเทียบ  *(the real gate)*

This is the phase that decides whether PIS-7 scoring ever moves.

The instrument already exists: `scripts/calibration/calibrate.js --mode rescore` re-scores a fixed
cohort through live rimpl and computes ICC against the human auditors.

1. Point rimpl at the DGX, run `--mode baseline` first to confirm the harness reproduces ≈0.662.
2. Run `--mode rescore` on the local model. Compare against the Claude figure **and** the ≥0.75 gate.
3. Expect to re-tune the prompt. The v1 calibration rules were written against *Claude's* failure
   mode (systematic leniency, +10.3, over-crediting templated structure). A different model will
   likely fail differently — possibly in the opposite direction.
4. **`prompt-versions.md` needs a model axis.** It currently versions prompts only; ICC is a property
   of (model × prompt × rubric), and the file must say which model produced each number.
5. Use the **pilot's 225 CLEs**, not the 10-CLE soak cohort. The README's own caveats — overfitting,
   and a 95% CI of ~0.40–0.83 at n≈30 — are exactly why the current figure is a directional signal
   rather than a passed gate.

> ### 🚦 Gate 4 — local ICC ≥ the Claude ICC measured on the same cohort.
> If it comes in lower, **the evaluator stays on Claude.** That is a perfectly good outcome: chat
> moves local (where the cost and volume are), scoring stays cloud (where the credibility is).

---

## Phase 5 — Production posture / เตรียมขึ้นจริง

- **Failover policy — differs by route, deliberately:**
  - `chat`: local down → fall back to Claude. A physician mid-session should never be blocked.
  - `evaluate`: **fail closed.** Never fail over. Silently scoring some CLEs on a different model
    would reintroduce the exact confound Phase 0 exists to avoid. Queue and retry instead.
- **Provenance** needs no work — `versions.js:14` already derives `MODEL_VERSION` from `MODEL`, so
  every row self-labels which system scored it.
- **Capacity.** Size the DGX against the real shape: 75 physicians, bursty (they log in after
  clinic). The 2026-06 loadtest measured 200 concurrent requests / 110 distinct users against the
  cloud path — re-run `scripts/` loadtest against local before trusting it.
- **Docs to update:** [architecture.md](architecture.md) (the cloud leg disappears),
  [deployment.md](deployment.md) (new env + the rimpl hosting decision),
  [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md),
  [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) (the ZDR/no-training item becomes structural).

---

## Risks / ความเสี่ยง

| Risk | Severity | Mitigation |
|---|---|---|
| Model swapped mid-pilot → confounded study | **Critical** | Cut over only at a cohort boundary (Phase 0 above) |
| Local model can't hold the PIS-7 JSON contract | High | Gate 0 — probe before writing any adapter |
| Thai output quality drops | High | Gate 0 Thai probe; physicians notice immediately |
| ICC falls below the CME credit gate | High | Gate 4; hybrid fallback is an acceptable end state |
| Hybrid mis-bills users/councils | Medium | Per-call cost rate before the first hybrid route |
| Single DGX = single point of failure | Medium | Chat fails over to Claude; eval queues |
| Railway↔tailnet bridge breaks silently | Medium | Provider-aware `/health/deep` |

---

## Open questions for Dr. Chanvit / คำถามที่ต้องถาม

1. What inference server actually runs on `cme-dgx` — vLLM, SGLang, Ollama? Can we hit it directly
   rather than through Open WebUI?
2. Is the DGX dedicated to CLICS, or shared? What concurrency can we assume during a clinic-hours
   burst?
3. Can rimpl be hosted on a tailnet node, or must it stay on Railway?
4. Who operates the box — patching, model updates, uptime? A model silently updated underneath a
   locked `MODEL_VERSION` would break §10.2 provenance.
