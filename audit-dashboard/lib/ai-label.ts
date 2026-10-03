// The words that tell a reader "an AI produced this". ONE place, so the wording can be changed once
// when the owner / ethics committee decide it, and so no component carries a private variant.
//
// Approved by the product owner 2026-10-03 — neutral wording. It names the source and makes
// no claim about what the AI does or does not decide. Do NOT add a governance statement here (for
// example "the AI does not score" or "not a verdict"): that is false for CLICS, whose evaluator
// produces a PIS-7 score that the ICC pipeline compares with the human raters.
export const AI_LABEL = {
  /** Small chip on an AI-authored message or block. */
  chip: 'AI',
  /** Heading label on the AI score card. */
  score: 'คะแนนจาก AI / AI score',
} as const;
