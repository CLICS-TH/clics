# The $5 plan — what to spend it on, and why not on measurement

**Written 2026-09-04, while the Anthropic account sits at zero credit.** Nothing can run until it is
topped up; this document says what should run when it is, and what deliberately should not.

## The arithmetic that decides the plan

D18 requires the **lower bound** of ICC(A,1) ≥ 0.75. `screening-verdict.mjs` prints how many paired
fixtures that needs at a given point estimate:

| if the true ICC is | pairs needed |
|---|---|
| 0.95 | 9 |
| 0.92 | 14 |
| 0.90 | 19 |
| 0.88 | **27** |
| 0.85 | 51 |

> **Correction, 2026-10-01 — this table was built on a Fisher-z interval that `icc.js` no longer
> uses.** `icc.js` now uses the exact F-based McGraw & Wong interval (the one R's `irr` and
> pingouin use). The two differ by only 1–2 pairs here (F-based: 0.95→7, 0.92→12, 0.90→17,
> 0.88→26, 0.85→50, 0.82→116, 0.80→245). The larger correction is what the table *means*. Each
> row is the n at which an interval centred on the true value just clears 0.75, which is roughly a
> **coin-flip chance of `pass`**, not power. Simulated 80% power (no rater bias, 600 reps): 0.95 →
> ~14, 0.92 → ~26, **0.90 → ~36, 0.88 → ~60**, 0.85 → ~110. Any rater bias raises these. Plan
> cohorts on the 80% figures.

> Against the 26 fixtures this conclusion still holds: 26 is a coin flip at 0.88, and the corpus's
> narrow range (see `METHODOLOGY §6.4`) is the binding problem anyway.

**26 fixtures exist in total** — 18 tuning + 8 held-out (`scripts/probe/SPLIT.json`). The best clean
estimate measured so far is **~0.74**, on the fixtures common to two runs of the same configuration;
the 0.803 that one run reported was inflated by survivorship (see below). At 0.74, the ladder does not
have a rung.

**So D18 cannot be passed with the fixtures that exist, at any budget.** More agreement runs would
refine a point estimate we already know is unstable — the same configuration produced 0.619 and 0.803
ninety minutes apart — and could not change the verdict. That is the whole reason this plan spends
almost nothing on measurement.

Two facts about that instability, both worth carrying forward:

- **Lost fixtures bias ICC upward.** Six fixtures lost in one run averaged Σ|Δ| 5.2 against 3.6 for
  those that survived: harder transcripts are longer, so they are more exposed to a flaky box and a
  rate-limited API, and they are also the ones the two models disagree about. Left unretried, the
  metric improves as the infrastructure degrades. Fixed in `9ea5636`, but every number recorded before
  that commit carries the bias.
- **Per-domain ICC at this n is not a finding.** d1 read 0.055 → 0.663 → 0.294 across three runs.

## What the $5 buys

| spend | item | why |
|---|---|---|
| **$0.21** | one held-out run (8 fixtures) + `screening-verdict` | Produces the formal `insufficient` verdict with its arithmetic, for the CREC082 §10.2 record: it documents *why* `evaluate` stays on Sonnet, rather than leaving the question open. Run it ONCE — the split is spent after that. |
| **$0** | ~~move `chat`, `criteria`, `discuss` to the local provider~~ — **BLOCKED, see below** | Intended as a superadmin toggle with no deploy. Not executable: production cannot reach the box. |
| **~$2** | smoke test after the switch | Do not switch a production provider blind. |
| **~$2.8** | reserve | `evaluate` stays on Sonnet, plus headroom. |

**Effect:** per-PLE cost falls from **$0.103** to about **$0.028** (evaluate + criteria only), so $5
covers roughly **175 PLEs** instead of ~48.

This is not a retreat. It is exactly the Track A / Track B split decided on 2026-08-24: Track A (chat,
criteria, discuss) goes local for the volume; Track B (`evaluate`) stays on `claude-sonnet-4-6`, locked
for the pilot's duration, with local running in shadow to build the calibration corpus.

## Correction, 2026-09-05 — the $0 line cannot be taken

**Railway cannot reach the model's port.** `rimpl` runs on Railway
(`RIMPL_URL=http://rimpl.railway.internal:3003`) and joins the tailnet as an ephemeral node; from
there `cme-dev:3000` — Open WebUI, and the only path to `deepseek-v4-flash-dspark` — is **silently
dropped**. Setting `ai_provider_chat = local` in production would point chat at an endpoint the
deployment cannot open, and `CHAT_FAILOVER_PROVIDER` ships unset — a deliberate CREC ethics decision,
not an oversight — so chat would **fail outright**, not degrade.

**Refined 2026-09-05 (GATE0 §8.9).** The mechanism named here first — "a tailnet advertising no subnet
routes", `PrimaryRoutes: None` — was a true observation but not the operative one: `cme-dev` is a
direct tailnet peer, so no subnet route is needed to address it. The nine-port sweep found the block is
**source-scoped and port-specific**: `80`, `3000` and `3001` drop for the container while returning
HTTP 200 to `napats-macbook-air` in the same minute, and `22`, `443`, `11434`, `3003`, `8080` and the
unused control port are all reachable from both. The conclusion is unchanged and the line still cannot
be taken; what changed is that the fix is an address on an allowlist, not a routing change.

Checked against prod on 2026-09-05: all five purposes still resolve to `anthropic` (`embed` →
`openai`), `routing.source = "database"`, `evaluator_locked_at` null.

The saving of $0.103 → $0.028 per PLE is real but **not available**, and it is gated on the same item
as everything else in this programme — either

- an allowlist entry on `cme-dev` for a **stable** tailnet address of ours (needs shell on a machine
  we do not have — and a non-ephemeral node on our side first, so the address stops changing every
  deploy), or
- **P2, rimpl relocation** onto a tailnet-joined host — which as of 2026-09-05 needs **no firewall
  change at all**: `:3003` refuses rather than drops, so the backend can reach a rimpl running on the
  box (GATE0 §8.9). Not started, but no longer gated on anyone else.

Until one lands, the real spend is everything on Anthropic at $0.103 per PLE, so $5 covers roughly
**48 PLEs**, not 175. None of the arithmetic that closes D18 changes; that was never a money question.

**Writing this down because the omission was structural, not careless.** The plan reasoned about cost
and about the ICC gate and never asked whether the cheaper path was reachable — the network constraint
was already documented, in a different file, and no step in the plan crossed it.

## Deliberately not doing

- **A real `median3` run** (~$0.47, ~2h box). The rule has never actually run — `model-agreement.mjs`
  hardcoded `mode: 'adaptive'` until `8d36492` — but measuring it now cannot move a gate that the
  fixture count already closes.
- **More adaptive replications.** We have two draws from one configuration; a third refines nothing.
- **Touching the held-out split more than once.**

## Budget enforcement — read this before trusting any number on a dashboard

**`api_budget_pool_usd` is display-only.** It is stored by `PATCH /admin/usage-settings`, read back by
the settings endpoints, rendered on the admin overview and users pages, and asserted in
`backend/tests/superadmin-usage.test.js` — and **enforced nowhere**. Setting it to 5 displays a 5 and
stops nothing.

**`evaluate` is uncapped.** `eval-drain` performs no budget check at all. The only enforced limits are
the per-user chat pool (`usage_limit_usd`, default $0.50) and the auditor pool.

**Therefore the only reliable cap is the Anthropic account balance itself.** Fund it with the intended
amount and let the API's own hard stop be the ceiling — the 400 `credit balance is too low` observed
on 2026-09-04 is a real, unbypassable limit, unlike the setting that claims to be one.

## Also open, and cheap to fix

`/health/deep` reports `ok` while the API key cannot serve a single request. `ready()` in
`rimpl/src/services/providers/anthropic.js` checks only that `ANTHROPIC_API_KEY` is set and that the
SDK client constructs — explicitly "WITHOUT making a completion call (zero token spend)". So an
exhausted balance, a revoked key, and a hard rate limit all read as healthy. This is the same shape as
the outage that left production broken for three days with both operator screens showing success.

**Fixed 2026-09-05 (PR #85).** The cheap alternative was described here as surfacing "the provider's
last observed error — the information already exists in the provider's runner stats". **That was
wrong.** `createRunner`'s `stats()` reported only `{provider, active, queued, maxConcurrency, lanes}`;
nothing recorded outcomes at all, so the information had to be captured before it could be surfaced.

The runner now records the last terminal outcome (`lastOk`, `lastError`) — no extra call, no token
spend — and clears `lastError` on the next success, so an operator who fixes a key sees green without
a restart. `ready()` adds an `anthropic_serving` check over it.

The predicate is deliberately narrow, and "non-retryable" is **not** it: a 400 caused by one
over-long prompt is non-retryable and must not take the deployment down. Only credential and account
conditions count — 401, 403, 402, and 400 whose body names credit, billing or quota. A 429 is a rate
limit, is retryable, and never reaches the verdict. Nine tests pin each of those distinctions.
