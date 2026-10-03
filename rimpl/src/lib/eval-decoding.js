// The evaluator's REQUESTED decoding parameters, in ONE place, shared by the served evaluation
// (routes/evaluate.js) and the shadow evaluation (services/shadow.js). A shadow scored under a smaller
// ceiling would look like a model failure when it was really our own budget.
//
// §10.2 requires these frozen and recorded. What is RECORDED is what the provider reports it actually
// sent (`decoding` on the call result), not this object: claude-sonnet-5-5 rejects a non-default
// temperature with a 400, so the anthropic provider sends none and provenance reads null there.

// temperature 0: the scoring instrument must be reproducible, and a sampled score is not. The local
// provider sends it. Anthropic's current model cannot take it (see lib/anthropic-request.js).
const EVAL_DECODING = Object.freeze({ temperature: 0, maxTokens: 4096 });

// max_tokens PER PROVIDER, because thinking only exists on one of them.
//
// anthropic 16000 (claude-sonnet-5-5, 2026-10-03). The evaluator now runs adaptive thinking at effort
// high, and thinking counts toward max_tokens. The visible JSON alone needed 4096 on 4-6: PLE-052
// (2026-08-17), a 130k-token transcript, truncated the JSON mid-rationale at BOTH 2000 and 3000, and
// earlier 1000 truncated on ~46k-token transcripts. Sonnet 5.5's tokenizer also counts ~30% more tokens
// for the same text, so that JSON is now ~5.3k tokens. 16000 leaves ~10k for thinking above it. A reply
// that still hits the ceiling arrives as unparseable/incomplete JSON and fails closed (502), never as a
// silently wrong score. max_tokens is a ceiling, not a spend: an unused allowance costs nothing.
//
// local stays 4096. Raising it would move every local fingerprint (max_tokens is in it), and on the
// on-prem server prompt + max_tokens must fit the served context window. A transcript that fits today
// could be refused tomorrow for a budget the local model, which sends no thinking, does not use.
const EVAL_MAX_TOKENS_BY_PROVIDER = Object.freeze({ anthropic: 16000 });
const evalMaxTokensFor = (provider) => EVAL_MAX_TOKENS_BY_PROVIDER[provider] ?? EVAL_DECODING.maxTokens;

module.exports = { EVAL_DECODING, EVAL_MAX_TOKENS_BY_PROVIDER, evalMaxTokensFor };
