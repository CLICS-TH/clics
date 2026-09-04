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
| **$0** | move `chat`, `criteria`, `discuss` to the local provider | A superadmin toggle, no deploy. This is where the money actually goes: chat is nearly all the token volume, and none of it is ICC-exposed. |
| **~$2** | smoke test after the switch | Do not switch a production provider blind. |
| **~$2.8** | reserve | `evaluate` stays on Sonnet, plus headroom. |

**Effect:** per-PLE cost falls from **$0.103** to about **$0.028** (evaluate + criteria only), so $5
covers roughly **175 PLEs** instead of ~48.

This is not a retreat. It is exactly the Track A / Track B split decided on 2026-08-24: Track A (chat,
criteria, discuss) goes local for the volume; Track B (`evaluate`) stays on `claude-sonnet-4-6`, locked
for the pilot's duration, with local running in shadow to build the calibration corpus.

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

Not fixed here because it needs a design decision: a real probe costs tokens on every health check.
The cheap alternative is to surface the provider's **last observed error** — the information already
exists in the provider's runner stats and needs no extra call.
