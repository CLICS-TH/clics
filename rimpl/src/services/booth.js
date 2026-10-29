// Booth turn (#209/#211): a demo turn for the conference kiosk, never a PLE. routes/chat.js branches here
// right after de-identification, so the PII handling and the provider routing (purpose 'chat') are the
// PLE path's. It deliberately skips everything else a PLE turn does: no RAG, no rescue classifier, no
// router, no corrective retry and no streaming. Each exists to make a scored reply right, and a booth
// reply is three sentences nobody scores, read on a screen that needs it fast.

const { callAI } = require('./ai');
const { chatSystemPrompt } = require('../lib/prompts');
const { BOOTH_MAX_TOKENS } = require('../lib/turn-limits');
const { stripArtifactDelimiters } = require('../lib/transcript');
const { promptLabel } = require('../lib/versions');

// `messages` must already be de-identified (routes/chat.js buildMessages of deidentifyTurn's output).
async function boothReply({ messages, signal }) {
  const systemPrompt = chatSystemPrompt({ booth: true });
  const { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } =
    await callAI({ purpose: 'chat', systemPrompt, messages, maxTokens: BOOTH_MAX_TOKENS, signal });
  return {
    // The prompt forbids artifacts; the strip makes sure no side panel opens if the model writes one anyway.
    content: stripArtifactDelimiters(text),
    refs: [],
    token_count: tokenCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    provider,
    model,
    prompt_version: promptLabel('chat', systemPrompt),
    failed_over_from: failed_over_from ?? null,
  };
}

module.exports = { boothReply };
