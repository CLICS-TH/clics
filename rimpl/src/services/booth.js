// Booth turn (#209/#211): a demo turn for the conference kiosk, never a PLE. routes/chat.js branches here
// right after de-identification, so the PII handling and the provider routing (purpose 'chat') are the
// PLE path's. It deliberately skips everything else a PLE turn does: no RAG, no rescue classifier, no
// router, no corrective retry and no streaming. Each exists to make a scored reply right, and a booth
// reply is three short fields nobody scores, read on a screen that needs it fast.

const { callAI } = require('./ai');
const { chatSystemPrompt } = require('../lib/prompts');
const { BOOTH_MAX_TOKENS } = require('../lib/turn-limits');
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

// A typed answer: the step's own bank as the yardstick, then the next step's bank under each tier. Thai text only.
const thBank = (bank) => ({
  variants: bank.variants.map((v) => ({ id: v.id, question: v.question.th })),
  options: bank.options.map((o) => ({ id: o.id, tier: o.tier, label: o.label.th, line: o.line.th })),
});
function withSort(messages, typed) {
  const block = JSON.stringify({
    current: thBank(typed.current),
    ...(typed.next ? { next: Object.fromEntries(Object.entries(typed.next).map(([tier, bank]) => [tier, thBank(bank)])) } : {}),
  });
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\nSORT: ${block}` }];
}

// The kiosk draws a reply's fields in this order, each under its own heading.
const REPLY_FIELDS = ['strength', 'weigh', 'safety'];

// rimpl only reads: the backend judges the fields (length, bold) and the pick (ids in the bank, one per tier,
// bridge). The prompt forbids artifacts; the strip makes sure no side panel opens if the model writes one anyway.
function readReply(text, { grill, typed }) {
  let obj = null;
  try { obj = parseJsonObject(text); } catch { obj = null; }
  const readable = obj && REPLY_FIELDS.some((k) => typeof obj[k] === 'string');
  // Half-written JSON or bare prose on the kiosk screen is worse than no reply: the backend shows its no-reply state.
  if (!readable) console.warn('[booth] output was not a readable JSON reply; reply and pick dropped');
  const o = readable ? obj : {};
  const reply = Object.fromEntries(REPLY_FIELDS.map((k) => [k, typeof o[k] === 'string' ? stripArtifactDelimiters(o[k]).trim() : '']));
  const { variant_id, option_ids, bridge, tier } = o;
  const picked = (grill || typed) && typeof variant_id === 'string'
    && Array.isArray(option_ids) && option_ids.every((id) => typeof id === 'string');
  return {
    // A missing bridge costs only the bridge, never the pick.
    reply, pick: picked ? { variant_id, bridge: typeof bridge === 'string' ? bridge : '', option_ids } : null,
    tier: typeof tier === 'string' ? tier : null,
  };
}

// `messages` must already be de-identified (routes/chat.js buildMessages of deidentifyTurn's output).
async function boothReply({ messages, bank, typed, signal }) {
  const systemPrompt = chatSystemPrompt({ booth: true, grill: Boolean(bank), typed: Boolean(typed) });
  const { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } = await callAI({
    purpose: 'chat', systemPrompt, signal,
    messages: typed ? withSort(messages, typed) : bank ? withBank(messages, bank) : messages,
    maxTokens: BOOTH_MAX_TOKENS,
  });
  const { reply, pick, tier } = readReply(text, { grill: Boolean(bank), typed: Boolean(typed) });
  return {
    reply,
    pick,
    ...(typed ? { tier } : {}),
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
