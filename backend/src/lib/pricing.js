// Single source of truth for AI token pricing -> USD cost, PER PROVIDER.
//
// The AI seam is provider-aware (rimpl services/ai.js routes each purpose to the Anthropic cloud or
// to the on-prem model), so a single global rate pair is a billing bug: a turn served on-prem would
// be priced at Anthropic rates, throttling physicians against the $0.50 cap for tokens that cost
// nothing and invoicing councils for compute they already own. Every call is therefore priced
// against the provider that ACTUALLY served it — rimpl reports that on each response.
//
// Rates are USD per 1M tokens.
//  * anthropic — the published claude-sonnet-4-6 rates; override with CLAUDE_INPUT_PER_M /
//    CLAUDE_OUTPUT_PER_M (unchanged, existing deployments set these).
//  * local     — 0/0 on purpose: the DGX is a sunk capital cost, so the MARGINAL cost of a token is
//    zero. If a council ever wants hardware amortisation on the meter instead, set
//    LOCAL_INPUT_PER_M / LOCAL_OUTPUT_PER_M and it flows through every caller with no code change.
//  * local-tutor — the on-prem TUTOR model (rimpl providers/local-tutor.js; chat / discuss), a second
//    on-prem endpoint beside the evaluator. Same reasoning, same 0/0 default, its own override pair
//    LOCAL_TUTOR_INPUT_PER_M / LOCAL_TUTOR_OUTPUT_PER_M. It MUST be listed: an unknown name is billed
//    at anthropic rates below, which would throttle physicians against the cap for free tokens.
const num = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };

const INPUT_PER_M = num(process.env.CLAUDE_INPUT_PER_M, 3);
const OUTPUT_PER_M = num(process.env.CLAUDE_OUTPUT_PER_M, 15);

// The provider assumed when none is reported. Deliberately the PAID one — see ratesFor().
const DEFAULT_PROVIDER = 'anthropic';

const RATES = {
  anthropic: { in: INPUT_PER_M, out: OUTPUT_PER_M },
  local: { in: num(process.env.LOCAL_INPUT_PER_M, 0), out: num(process.env.LOCAL_OUTPUT_PER_M, 0) },
  'local-tutor': { in: num(process.env.LOCAL_TUTOR_INPUT_PER_M, 0), out: num(process.env.LOCAL_TUTOR_OUTPUT_PER_M, 0) },
};

// An UNKNOWN provider name must never be zero-rated: adding a vendor to rimpl before adding its rates
// here would otherwise silently stop metering real spend (budget cap defeated, councils under-billed).
// Fail toward over-billing instead, and say so loudly once per unknown name.
const _warned = new Set();
function ratesFor(provider) {
  const name = provider || DEFAULT_PROVIDER;
  const r = RATES[name];
  if (r) return r;
  if (!_warned.has(name)) {
    _warned.add(name);
    console.warn(`[pricing] unknown AI provider "${name}" — billing at ${DEFAULT_PROVIDER} rates until a rate table entry exists`);
  }
  return RATES[DEFAULT_PROVIDER];
}

// Cost in USD for a call that billed `inputTokens` input + `outputTokens` output on `provider`.
// The 2-arg form is unchanged (anthropic rates) — every pre-existing caller keeps its exact behaviour.
function costUsd(inputTokens = 0, outputTokens = 0, provider = DEFAULT_PROVIDER) {
  const inT = Number(inputTokens) || 0;
  const outT = Number(outputTokens) || 0;
  const { in: inRate, out: outRate } = ratesFor(provider);
  return (inT / 1e6) * inRate + (outT / 1e6) * outRate;
}

// Reconcile a per-turn RESERVATION to the real, provider-priced cost — the signed amount still owed
// on the meter, to hand to usage.accrueUsage()'s `costOverride`.
//
//   applied = true  → reserveUsage already added `estimate`, so we owe (actual − estimate).
//   applied = false → reserveUsage failed open and added NOTHING, so we owe the full actual.
//
// This mirrors usage.settleUsage(), which prices at anthropic rates unconditionally. It lives here,
// beside the rate table, because it is pure arithmetic over those rates — no I/O, no pool wiring —
// which keeps usage.js's meter mechanics (RPC, pools, fail-open) free of any vendor pricing, and
// stops a second copy of the rate table from drifting into it.
//
// CRITICAL for the local provider: a free turn settles to −estimate, which RELEASES the reservation.
// "It's free, skip the settle" is the tempting shortcut and it is wrong — the reservation would stay
// on the meter forever, so ~25 free turns would pin a physician at the $0.50 cap having spent $0.
function settlementDelta({ estimate, inputTokens = 0, outputTokens = 0, applied = true, provider = DEFAULT_PROVIDER } = {}) {
  const actual = costUsd(inputTokens, outputTokens, provider);
  return applied ? actual - (Number(estimate) || 0) : actual;
}

module.exports = { INPUT_PER_M, OUTPUT_PER_M, DEFAULT_PROVIDER, RATES, costUsd, settlementDelta };
