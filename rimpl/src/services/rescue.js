// Socratic rescue — CREC082 PLE Instruction Sheet §4.
//
// "If 4 physician-AI exchanges have completed and the conversation is still not qualifying as a PLE
// or is still off-topic, the system may open Socratic rescue mode to ask 1-2 non-leading questions
// per round. The purpose is to help structure thinking, not to answer for the physician; it is not
// an examination and not an experimental arm."
//
// Two properties matter more than the mechanics:
//
//   It is MID-SESSION. Nothing about which episode this is, or who the physician is, may influence
//   it. An earlier build allocated Socratic mode to one of the physician's three episodes at
//   creation time, which made it a randomised arm — the thing the protocol tells the ethics
//   committee the study does not do. The decision has to come from the conversation in front of it.
//
//   It is CHEAP. The qualifying test is a model call, and running one per turn would roughly double
//   the AI cost of every session for a signal that cannot change until the physician has said
//   something new. The deterministic gate below skips it in the common case.

const { callAI } = require('./ai');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt } = require('../lib/transcript');
const { CRITERIA_DECODING } = require('../lib/decoding');

// The protocol's threshold, in physician turns. Four exchanges means the physician has had four
// goes at making this a learning conversation; intervening earlier would cut across a session that
// is simply still warming up.
const RESCUE_AFTER_EXCHANGES = 4;

// How many rounds a rescue may keep re-assessing before it stops paying to ask.
//
// Re-assessing every round is what makes recovery observable, but on its own it is unbounded: a
// session that never qualifies keeps buying an ever-larger classifier call on every turn, and under
// a hybrid deployment (paid classifier, free on-prem chat) nothing else in the system is spending,
// so no budget ever stops it. A rescue that has not worked after this many rounds is not going to.
//
// Hitting the cap ENDS the rescue, and says so. Two weaker options were both wrong: leaving the
// session in rescue without re-assessing makes recovery permanently unobservable (nothing can ever
// set exchanges-after), and simply not assessing dropped the session back to the general examiner
// prompt — the exact hand-off to a different instrument that the per-round rescue exists to stop,
// reappearing silently at round nine. A bounded intervention has to end somewhere; it ends here,
// recorded as `exhausted` rather than as nothing.
const MAX_RESCUE_ROUNDS = Math.max(1, parseInt(process.env.MAX_RESCUE_ROUNDS || '8', 10));

// A physician turn is one exchange. The backend labels its own side 'physician' and the model's
// 'assistant'; some callers use the OpenAI-style 'user'. Accept both rather than silently counting
// zero, which would mean the rescue never fires and nothing in the logs would say why.
function countExchanges(history = []) {
  return history.filter(m => m.role === 'physician' || m.role === 'user').length;
}

// Should we spend a model call deciding whether to rescue? Deterministic, no I/O.
//
// ONE latch remains, and it is the one that is actually monotonic: a session that has shown
// reflective synthesis does not stop having shown it, so once `alreadyQualified` is true there is
// nothing left to re-ask and a long good session never pays for another classifier call.
//
// `rescueActive` used to be a latch too, and that was the bug. It meant a rescued session was
// assessed exactly once, on the round the rescue fired — after which nothing could observe it
// recovering, so the rescue never ended and "did this conversation return to being a learning
// episode?" had no answer in the data. The protocol describes the rescue as applying EACH ROUND
// until the session qualifies, which is a loop, not a one-shot. So a session in rescue and not yet
// qualified is re-assessed every round; that is the cost of being able to see it recover.
//
// `socraticActive` without `rescueActive` is examiner mode entered for some other reason. It is not
// a rescue and must not be assessed as one.
function shouldAssess({ history, socraticActive = false, rescueActive = false, alreadyQualified = false, rescueRounds = 0 } = {}) {
  if (alreadyQualified) return false;
  if (rescueActive) return rescueRounds < MAX_RESCUE_ROUNDS;
  if (socraticActive) return false;
  return countExchanges(history) >= RESCUE_AFTER_EXCHANGES;
}

// Has this rescue run its course? Separate from shouldAssess deliberately: shouldAssess answers
// "spend a model call?", and at the cap the answer is no for two OPPOSITE reasons — the session
// already qualified, or the rescue is giving up. Collapsing them into one false is what let the
// second case look like nothing having happened.
function rescueExhausted({ rescueActive = false, rescueRounds = 0 } = {}) {
  return !!rescueActive && rescueRounds >= MAX_RESCUE_ROUNDS;
}

// Run the CREC §1 qualifying test over the conversation so far.
//
// Uses the SAME classifier that decides whether the finished session counts as a PLE. That is
// deliberate: the protocol's trigger is "still not qualifying", so the rescue must fire on exactly
// the criteria the session will later be judged by. Two different definitions of "qualifying" would
// mean rescuing sessions that would have passed, and not rescuing ones that will fail.
//
// `transcriptText` must already be PII-stripped by the caller — this function makes a cloud-capable
// call and performs no de-identification of its own.
//
// `signal` is the request's client-gone signal (lib/request-signal.js): a physician who closes the
// tab mid-assessment frees the classifier's queue slot for the next physician.
async function assessQualifying(transcriptText, { signal } = {}) {
  const { text, inputTokens, outputTokens, provider, model } = await callAI({
    purpose: 'criteria',
    systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
    maxTokens: CRITERIA_DECODING.maxTokens,   // the same classifier call as /evaluate-criteria (lib/decoding.js)
    temperature: CRITERIA_DECODING.temperature,
    signal,
  });
  const ELEMENTS = ['c4', 'c5', 'c6', 'c7'];
  let r;
  try {
    r = parseJsonObject(text);
    // parseJsonObject returns {} when it finds no JSON at all — by design, and harmless for callers
    // that treat an empty object as "no answer". It is NOT harmless here: {} reads as all four
    // elements absent, which is indistinguishable from a genuine "this is not yet a learning
    // episode", so a classifier that replied in prose would RESCUE the physician for no reason.
    // Per-round assessment turns that from a one-off into every single turn.
    if (!ELEMENTS.some((k) => typeof r[k] === 'boolean')) {
      throw new Error('classifier returned no qualifying elements');
    }
  } catch (e) {
    // The call was BILLED before the parse failed. Dropping it loses that spend from the study's
    // accounting, and under an active rescue the next turn buys another one — so actual cost can
    // drift arbitrarily far above what is recorded. Carry the usage out on the error.
    e.usage = { inputTokens, outputTokens, provider, model };
    throw e;
  }
  const elements = { c4: !!r.c4, c5: !!r.c5, c6: !!r.c6, c7: !!r.c7 };
  return {
    elements,
    onTopic: r.on_topic !== false, // absent → assume on-topic; only an explicit false redirects
    qualifying: elements.c4 && elements.c5 && elements.c6 && elements.c7,
    inputTokens, outputTokens, provider, model,
  };
}

// Decide, and say why. `off_topic` and `not_qualifying` are recorded distinctly because the SAP
// analyses trigger reasons, and because they are different failures: one wandered away from
// clinical learning, the other never got deep enough.
function rescueDecision(assessment) {
  if (!assessment.onTopic) return { rescue: true, reason: 'off_topic' };
  if (!assessment.qualifying) return { rescue: true, reason: 'not_qualifying' };
  return { rescue: false, reason: null };
}

// Post-check on the generated rescue reply. The prompt forbids diagnosing and caps the questions at
// two, but a prompt is a request and this is a protocol commitment, so verify the output.
//
// Deliberately conservative: it reports what it found and does not rewrite the reply. A rescue turn
// that quietly drops the physician's answer would be worse than one that asked three questions.
const DIAGNOSIS_MARKERS = [
  /\bdifferential\b/i, /\bmost likely diagnosis\b/i, /\bI would (?:diagnose|treat|start|give|order)\b/i,
  /\brecommend(?:ed|ation)?\b/i, /\bmanagement plan\b/i, /\byou should (?:start|give|order|treat)\b/i,
  /การวินิจฉัย(?:แยกโรค)?ค?ือ/, /แนะนำให้(?:เริ่ม|ให้|ตรวจ|รักษา)/, /ควรเริ่มยา/, /แผนการรักษา/,
];
const MAX_RESCUE_QUESTIONS = 2;

// The ONE corrective retry for a rescue reply that broke the rescue rules (no question, too many, or
// a diagnosis/plan). Measured 2026-10-03 on the local model: a rescue system prompt alone was ignored on
// 6/12 then 10/18 turns — the model answered the lookup it was asked for. The instruction rides in the
// LAST user turn, which the model follows far more reliably than a system prompt. It asks for a
// REWRITE into questions, so it can never make the rescue answer what it deliberately withholds.
const RESCUE_RETRY_PROMPT = {
  th: 'ในข้อความนี้ยังไม่ต้องให้คำตอบ การวินิจฉัย หรือแผนการรักษา — ช่วยเขียนข้อความก่อนหน้าใหม่ให้เป็นคำถามเปิด 1–2 ข้อ ที่ชวนให้แพทย์อธิบายการคิดของตนเอง (กำลังชั่งน้ำหนักอะไร ไม่แน่ใจตรงไหน หรือจะหาและตรวจสอบคำตอบอย่างไร) และลงท้ายแต่ละคำถามด้วยเครื่องหมาย ?',
  en: 'Do not give the answer, a diagnosis or a plan in this reply. Rewrite your previous reply as one or two open questions that ask the physician to explain their own thinking (what they are weighing, what they are unsure of, or how they would find and check the answer). End each question with a question mark.',
};

function checkRescueReply(text = '') {
  // '?' and the Thai/full-width '？', plus the ❓ the examiner prompt uses.
  const questions = (text.match(/[?？❓]/g) || []).length;
  const diagnostic = DIAGNOSIS_MARKERS.some(re => re.test(text));
  return {
    ok: questions >= 1 && questions <= MAX_RESCUE_QUESTIONS && !diagnostic,
    questions,
    tooManyQuestions: questions > MAX_RESCUE_QUESTIONS,
    noQuestion: questions === 0,
    diagnostic,
  };
}

module.exports = {
  RESCUE_AFTER_EXCHANGES, MAX_RESCUE_QUESTIONS, MAX_RESCUE_ROUNDS,
  countExchanges, shouldAssess, rescueExhausted, assessQualifying, rescueDecision, checkRescueReply, RESCUE_RETRY_PROMPT,
  flattenForPrompt, // re-exported so the chat route builds its transcript the same way
};
