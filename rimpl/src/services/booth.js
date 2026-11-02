// Booth turn (#209/#211): a demo turn for the conference kiosk, never a PLE. routes/chat.js branches here
// right after de-identification, so the PII handling and the provider routing (purpose 'chat') are the
// PLE path's. It deliberately skips everything else a PLE turn does: no RAG, no rescue classifier, no
// router, no corrective retry and no streaming. Each exists to make a scored reply right, and a booth
// reply is three sentences nobody scores, read on a screen that needs it fast.

const { callAI } = require('./ai');
const { chatSystemPrompt } = require('../lib/prompts');
const { BOOTH_MAX_TOKENS, BOOTH_GRILL_MAX_TOKENS } = require('../lib/turn-limits');
const { stripArtifactDelimiters } = require('../lib/transcript');
const { promptLabel } = require('../lib/versions');
const { parseJsonObject } = require('../lib/parse');

// The bank goes after the (already de-identified) last user turn only, so it is never part of the history
// the backend replays. Thai text only: the reply's language rule decides the bridge's language.
function withBank(messages, bank) {
  const block = JSON.stringify({
    variants: bank.variants.map((v) => ({ id: v.id, question: v.question.th })),
    options: bank.options.map((o) => ({ id: o.id, tier: o.tier, label: o.label.th, line: o.line.th })),
  });
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\nBANK: ${block}` }];
}

// rimpl only reads the pick; the backend judges whether it is valid (ids in the bank, one per tier, bridge).
function readGrill(text) {
  let obj = null;
  try { obj = parseJsonObject(text); } catch { obj = null; }
  if (obj && typeof obj.reply === 'string') {
    const { variant_id, option_ids } = obj;
    // A missing bridge costs only the bridge, never the pick.
    const bridge = typeof obj.bridge === 'string' ? obj.bridge : '';
    const typed = typeof variant_id === 'string'
      && Array.isArray(option_ids) && option_ids.every((id) => typeof id === 'string');
    return { content: stripArtifactDelimiters(obj.reply), pick: typed ? { variant_id, bridge, option_ids } : null };
  }
  console.warn('[booth] grill output was not a readable JSON reply; pick dropped');
  // Half-written JSON on the kiosk screen is worse than no reply: the backend shows its no-reply state.
  return { content: /[{}]/.test(text) ? '' : stripArtifactDelimiters(text), pick: null };
}

// `messages` must already be de-identified (routes/chat.js buildMessages of deidentifyTurn's output).
async function boothReply({ messages, bank, signal }) {
  const systemPrompt = chatSystemPrompt({ booth: true, grill: Boolean(bank) });
  const { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } = await callAI({
    purpose: 'chat', systemPrompt, signal,
    messages: bank ? withBank(messages, bank) : messages,
    maxTokens: bank ? BOOTH_GRILL_MAX_TOKENS : BOOTH_MAX_TOKENS,
  });
  // The prompt forbids artifacts; the strip makes sure no side panel opens if the model writes one anyway.
  const { content, pick } = bank ? readGrill(text) : { content: stripArtifactDelimiters(text), pick: null };
  return {
    content,
    pick,
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
