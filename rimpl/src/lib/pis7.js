// PIS-7 scoring: turn an evaluator model's raw text into validated domain scores + a composite.
//
// Extracted from routes/evaluate.js so the SERVED evaluation and the SHADOW evaluation apply
// byte-for-byte the same contract. If they diverged, the November head-to-head would be comparing
// two models under two different validators — which is not a comparison at all.
const { z } = require('zod');
const { parseJsonObject } = require('./parse');
const { WEIGHTS } = require('./versions');

// The evaluator's d1..d7 drive CME credit and are persisted into smallint CHECK(0..5) columns
// downstream. Validate the model's parsed output HERE so a malformed/out-of-range/NaN score fails
// fast instead of poisoning the composite or throwing a CHECK violation in persistEvaluation that
// the 6h reconcile sweep then retries forever (a paid call each time).
const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
//
// .strict(): the prompt asks for exactly the seven scores and the rationale object, nothing else.
// An extra top-level key is the other half of a score forgery (see parse.js): an injected quotation
// can wrap the model's real keys inside an object it invents, leaving only forged d1..d7 at the top.
const DomainScoresSchema = z.object({
  ...Object.fromEntries(DOMAIN_KEYS.map((k) => [k, z.number().int().min(0).max(5)])),
  rationale: z.record(z.string(), z.unknown()).optional(),
}).strict();

// `kind` lets callers distinguish the two failures without string-matching a message:
//   'invalid_json'   — no parseable {...} in the reply at all
//   'invalid_scores' — parsed, but a domain score is missing / non-integer / outside 0–5
class Pis7ScoreError extends Error {
  constructor(kind, message, parsed) {
    super(message);
    this.name = 'Pis7ScoreError';
    this.kind = kind;
    this.parsed = parsed;
  }
}

// ×20 gives a 0–100 range: max = 5 × 1.0 × 20 = 100.
function compositeOf(scores) {
  const raw = Object.entries(WEIGHTS).reduce((acc, [key, w]) => acc + scores[key] * w, 0) * 20;
  return Math.round(raw * 100) / 100;
}

// Throws Pis7ScoreError on either failure; returns { scores, composite, rationale } on success.
function scoreFromText(text) {
  let parsed;
  try {
    parsed = parseJsonObject(text);
  } catch {
    throw new Pis7ScoreError('invalid_json', 'Evaluator returned invalid JSON');
  }
  const checked = DomainScoresSchema.safeParse(parsed);
  if (!checked.success) {
    // `{}` here means parseJsonObject's no-match fallback found no {...} at all — could be
    // truncation (stopReason 'max_tokens') or the model never attempting JSON (stopReason
    // 'end_turn'). The caller's diagnostic tells those apart.
    throw new Pis7ScoreError('invalid_scores', 'Evaluator returned out-of-range or missing domain scores', parsed);
  }
  const scores = checked.data;
  return { scores, composite: compositeOf(scores), rationale: scores.rationale ?? {} };
}

module.exports = { DOMAIN_KEYS, DomainScoresSchema, scoreFromText, compositeOf, Pis7ScoreError };
