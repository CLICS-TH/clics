// Build the exact request rimpl's chat route (rimpl/src/routes/chat.js) would send for a bank item.
//
// WHAT IS IMPORTED vs WHAT IS REPLICATED
// --------------------------------------
// Imported from rimpl (via ./rimpl.mjs): the three system prompts and ARTIFACT_GUIDANCE, the PII
// filter (stripPii / stripHistoryPii / deriveHintTokens), the artifact-fence strip, and every
// predicate the retry decision is made of — meetsCitationRule, extractSocraticQuestion, isThaiMessage,
// isLanguageMismatch (services/post-filter.js) — plus promptLabel (the provenance hash).
//
// Replicated, because chat.js does not export them and requiring chat.js pulls express + zod:
//   * buildMessages()  — the chief-complaint prefix, physician→user role mapping, artifact strip.
//   * the ONE corrective retry (#109): how the two checks combine (citation/❓ and language), which
//     prompt each case gets, whether the artifact fence is kept, and that a FAILED language-only
//     retry keeps the first reply while a failed citation retry fails the turn. ≤ 2 calls per turn.
//   * the client's `language` rule — 'th' when the message holds ANY Thai codepoint
//     (physician-ui/public/js/ple-chat.js).
//   * CHAT_MAX_TOKENS  — max(1500, RIMPL_CHAT_MAX_TOKENS ?? 4000), defined in rimpl/src/lib/turn-limits.js.
// Each replica is pinned by a drift test (request.test.mjs) that reads chat.js as TEXT and fails if
// the production string or expression it copies is no longer there verbatim. Change chat.js, and
// the test tells you to change this file in the same PR.
//
// One deliberate difference: RAG. chat.js calls ragLookup(cleanMessage); here ragDocs is always [].
// That matches production today — the `documents` corpus is empty (docs/LOCAL-MODEL-ROADMAP.md P3,
// "retrieval is inert") — and keeps the audit off Supabase and off the embeddings API. If the corpus
// is ever populated, this audit no longer measures what physicians see, and the report says so
// (provenance.rag).

import {
  RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE,
  promptLabel, stripPii, stripHistoryPii, deriveHintTokens, stripArtifactDelimiters,
  meetsCitationRule, extractSocraticQuestion, isThaiMessage, isLanguageMismatch,
} from './rimpl.mjs';

export const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10));

export const RAG_NOTE = 'none — ragDocs=[] (production documents corpus is empty; docs/LOCAL-MODEL-ROADMAP.md P3)';

// Verbatim from routes/chat.js. Keyed [socratic][language].
export const RETRY_PROMPTS = {
  socratic: {
    th: 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) ที่ระบุชื่อเอกสารเฉพาะ เช่น ชื่อแนวทางเวชปฏิบัติ แถลงการณ์ หรือชื่อการศึกษา — หากไม่มั่นใจว่ามีแหล่งเฉพาะที่กล่าวเช่นนั้นจริง ให้เขียน (ไม่มีแหล่งอ้างอิงเฉพาะ) แทน ห้ามแต่งแหล่งอ้างอิงขึ้นเอง — และปิดท้ายด้วยคำถามชวนคิดขึ้นบรรทัดใหม่นำหน้าด้วย ❓ — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม',
    en: 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation that names a specific guideline, statement or trial — or, where you are not confident a specific source exists and says this, write (no specific source cited) instead of inventing one — and end with a ❓ question on its own line. Engage with the question — do not decline to answer.',
  },
  natural: {
    th: 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) ที่ระบุชื่อเอกสารเฉพาะ เช่น ชื่อแนวทางเวชปฏิบัติ แถลงการณ์ หรือชื่อการศึกษา — หากไม่มั่นใจว่ามีแหล่งเฉพาะที่กล่าวเช่นนั้นจริง ให้เขียน (ไม่มีแหล่งอ้างอิงเฉพาะ) แทน ห้ามแต่งแหล่งอ้างอิงขึ้นเอง — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม และไม่ต้องปิดท้ายด้วยคำถามชวนคิด',
    en: 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation that names a specific guideline, statement or trial — or, where you are not confident a specific source exists and says this, write (no specific source cited) instead of inventing one. Engage with the question — do not decline, and do not append a follow-up question.',
  },
};

// Verbatim from routes/chat.js buildMessages().
export const CC_PREFIX = 'ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ';

// Verbatim from routes/chat.js: appended to the citation retry when the language check ALSO failed,
// and the language-only rewrite prompt (two concatenated literals in chat.js).
export const LANGUAGE_SUFFIX = ' และเขียนคำตอบทั้งหมดเป็นภาษาไทย (Write the whole reply in Thai.)';
export const LANGUAGE_ONLY_PROMPT_TH = 'กรุณาเขียนคำตอบก่อนหน้านี้ใหม่เป็นภาษาไทย โดยคงเนื้อหาทางคลินิก การอ้างอิง (แหล่ง, ปี) และคำถามที่ขึ้นต้นด้วย ❓ (ถ้ามี) ไว้ตามเดิม และคงบล็อก :::artifact ทั้งบล็อก (ถ้ามี) ไว้ตามเดิมทุกประการ — ชื่อยา ตัวย่อ และชื่อแหล่งอ้างอิงเป็นภาษาอังกฤษได้ ';
export const LANGUAGE_ONLY_PROMPT_EN = '(Please rewrite your previous reply in Thai, keeping the same clinical content, (Source, Year) citations and any ❓ question on its own line. Keep any :::artifact block exactly as is, fence lines included. Drug names, abbreviations and source titles may stay in English.)';
export const LANGUAGE_ONLY_PROMPT = LANGUAGE_ONLY_PROMPT_TH + LANGUAGE_ONLY_PROMPT_EN;

/** The chat route's `language` as the physician-ui client sets it: 'th' when the message holds ANY
 *  Thai codepoint, else 'en' (ple-chat.js / guest-chat.js). So a code-mixed turn is 'th'. */
export function routeLanguage(message) {
  return /[\u0E00-\u0E7F]/.test(String(message ?? '')) ? 'th' : 'en';
}

/** The language a bank item's reply is EXPECTED in: the language of the physician's latest turn. */
export function expectedReplyLanguage(item) {
  return routeLanguage(item.turns[item.turns.length - 1].content);
}

/** Replica of chat.js buildMessages(history, cleanMessage, ragDocs=[], chiefComplaint, hints). */
export function buildMessages(history, cleanMessage, chiefComplaint, hints = []) {
  const cc = chiefComplaint ? `${CC_PREFIX}${stripPii(chiefComplaint, undefined, hints)}\n\n` : '';
  const context = ''; // ragDocs = [] — see header
  const cleanHistory = stripHistoryPii(history, hints).map((m) => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: stripArtifactDelimiters(m.content),
  }));
  return [...cleanHistory, { role: 'user', content: cc + cleanMessage + context }];
}

/**
 * Everything the chat route would decide for this item, before the model call.
 * @param {object} item  a validated bank item
 * @param {{artifacts?: boolean}} opts
 */
export function buildChatRequest(item, { artifacts = false } = {}) {
  const turns = item.turns;
  const history = turns.slice(0, -1);
  const message = turns[turns.length - 1].content;
  const hints = deriveHintTokens(item.patient_ref ?? null);
  const socratic = item.mode === 'examiner';
  const rescuing = item.mode === 'rescue';
  // chat.js: mode prompt (+ artifact guidance), and the rescue REPLACES it wholesale.
  const systemPrompt = rescuing
    ? RIMPL_SYSTEM_PROMPT_RESCUE
    : (socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL) + (artifacts ? ARTIFACT_GUIDANCE : '');
  const cleanMessage = stripPii(message, undefined, hints);
  const messages = buildMessages(history, cleanMessage, item.chief_complaint, hints);
  const sentText = messages.map((m) => m.content).join('\n');
  return {
    socratic,
    rescuing,
    artifacts: artifacts && !rescuing,
    language: routeLanguage(message),
    message,                                  // RAW: chat.js runs isThaiMessage on the un-stripped message
    systemPrompt,
    promptVersion: promptLabel('chat', systemPrompt),
    messages,
    // Which of the item's synthetic identifiers survived the production PII filter into the bytes a
    // model receives. Non-empty = a FILTER gap, independent of anything the model then does.
    identifiersSent: (item.identifiers || []).filter((id) => includesLoose(sentText, id)),
  };
}

/**
 * chat.js's ONE corrective retry decision, composed from production's own predicates.
 *   needCitation      neither a citation nor a no-source note (both modes) or ❓ missing (examiner); never on a rescue turn
 *   languageMismatch  the physician wrote substantially Thai (isThaiMessage on the RAW message, with
 *                     language === 'th') and the reply is not (isLanguageMismatch). Applies to rescue
 *                     turns too — it asks for a rewrite, not a new answer.
 */
export function retryDecision(text, { socratic, rescuing, language, message }) {
  const needCitation = !rescuing && (!meetsCitationRule(text) || (socratic && !extractSocraticQuestion(text)));
  const physicianWroteThai = language === 'th' && isThaiMessage(message);
  const languageMismatch = physicianWroteThai && isLanguageMismatch(text, language);
  return { fire: needCitation || languageMismatch, needCitation, languageMismatch, physicianWroteThai };
}

/** The retry prompt chat.js sends for a decision. */
export function retryPrompt(decision, { socratic, language }) {
  if (decision.needCitation) {
    const p = RETRY_PROMPTS[socratic ? 'socratic' : 'natural'][language === 'th' ? 'th' : 'en'];
    return decision.languageMismatch ? p + LANGUAGE_SUFFIX : p;
  }
  return LANGUAGE_ONLY_PROMPT;
}

/** Retry messages: a citation retry re-ANSWERS (fence stripped from the fed-back reply); a
 *  language-only retry REWRITES and keeps the fence, but only when artifacts are on. */
export function retryMessages(messages, firstText, decision, { socratic, language, artifacts = false }) {
  const keepFence = !decision.needCitation && artifacts;
  return [...messages,
    { role: 'assistant', content: keepFence ? firstText : stripArtifactDelimiters(firstText) },
    { role: 'user', content: retryPrompt(decision, { socratic, language }) },
  ];
}

/** Case-insensitive, whitespace- and hyphen-tolerant containment — "081-234-5678" matches
 *  "081 234 5678" and "0812345678", which is how an identifier actually gets echoed back. */
export function includesLoose(haystack, needle) {
  const norm = (s) => String(s).toLowerCase().replace(/[\s\-–—.()]/g, '');
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}
