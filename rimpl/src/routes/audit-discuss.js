const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, deriveHintTokens } = require('../services/pii-filter');
const { callAI } = require('../services/ai');
const { RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS } = require('../lib/prompts');
const { requestSignal } = require('../lib/request-signal');
const { promptLabel } = require('../lib/versions');
const { sendAiError, logAiError } = require('../lib/ai-errors');

const router = Router();

// A calibration-chat reply is short prose (no tables/artifacts); keep the ceiling modest — the
// auditor's separate $0.50 pool bounds total spend, but the transcript context per turn is large.
const DISCUSS_MAX_TOKENS = Math.max(800, parseInt(process.env.RIMPL_DISCUSS_MAX_TOKENS || '1200', 10));

const DOMAINS = [
  ['d1', 'Clinical Question Intelligence'], ['d2', 'Reasoning Depth'], ['d3', 'Contextual Integration'],
  ['d4', 'Iterative Inquiry'], ['d5', 'Critical Appraisal'], ['d6', 'Reflective Synthesis'],
  ['d7', 'AI Literacy & Prompt Skill'],
];

const Scores = z.record(z.any());
const DiscussSchema = z.object({
  history: z.array(z.object({ role: z.string(), content: z.string() })).default([]),
  message: z.string().min(1),
  language: z.enum(['th', 'en']).default('th'),
  // The PLE transcript, sent on-prem so RIMPL can de-identify it before any cloud call (it is stored
  // RAW in the backend DB). Never forwarded to the cloud un-stripped.
  transcript: z.array(z.object({ role: z.string(), content: z.string() })).default([]),
  ai_scores: Scores.nullish(),       // { d1..d7, composite_score }
  ai_rationale: Scores.nullish(),    // { d1..d7: "<text>" }
  auditor_scores: Scores.nullish(),  // { d1..d7, composite_score }
  // patient identifier → scrub hints only (never forwarded to the cloud).
  patient_ref: z.string().nullish(),
});

function scoresBlock(ai, auditor, rationale) {
  const lines = DOMAINS.map(([k, label]) => {
    const r = rationale && rationale[k] ? ` — AI rationale: ${rationale[k]}` : '';
    return `- ${label} (${k}): AI ${ai?.[k] ?? '—'} vs Auditor ${auditor?.[k] ?? '—'}${r}`;
  });
  return `PIS-7 SCORES (0–5 per domain):\n${lines.join('\n')}\n` +
    `Composite (out of 100): AI ${ai?.composite_score ?? '—'} vs Auditor ${auditor?.composite_score ?? '—'}.`;
}

router.post('/', async (req, res) => {
  const parsed = DiscussSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref } = parsed.data;
  const hints = deriveHintTokens(patient_ref);
  // Fires if the auditor's client hangs up: the queued or in-flight call is released.
  const signal = requestSignal(req, res);

  try {
    const cleanMessage = stripPii(message, undefined, hints);
    // De-identify the transcript BEFORE it reaches the cloud (it is stored raw on-prem). Each turn
    // re-sends it as grounding — the auditor's separate budget pool bounds the cost.
    const cleanTranscript = stripHistoryPii(transcript, hints)
      .map(m => `${m.role === 'assistant' ? 'AI' : 'Physician'}: ${m.content}`).join('\n');
    const context =
      `\n\n=== PLE TRANSCRIPT (de-identified) ===\n${cleanTranscript || '(empty)'}\n\n` +
      `=== ${scoresBlock(ai_scores, auditor_scores, ai_rationale)} ===`;
    // Grounding lives in the system prompt; the conversation stays a clean Q&A so history isn't bloated.
    const systemPrompt = RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS + context;
    const cleanHistory = stripHistoryPii(history, hints).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    const messages = [...cleanHistory, { role: 'user', content: cleanMessage }];

    const { text, tokenCount, inputTokens, outputTokens, provider, model } =
      await callAI({ purpose: 'discuss', systemPrompt, messages, maxTokens: DISCUSS_MAX_TOKENS, signal });

    // prompt_version hashes the fixed instructions only — the transcript/scores block appended to the
    // system prompt is per-episode data, and hashing it would give every episode its own "version".
    res.json({ content: text, token_count: tokenCount, input_tokens: inputTokens, output_tokens: outputTokens, provider, model,
      prompt_version: promptLabel('discuss', RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS) });
  } catch (err) {
    logAiError('[RIMPL audit-discuss]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'AI service temporarily unavailable. Please try again.');
  }
});

module.exports = router;
