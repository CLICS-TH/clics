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

// The protocol's threshold, in physician turns. Four exchanges means the physician has had four
// goes at making this a learning conversation; intervening earlier would cut across a session that
// is simply still warming up.
const RESCUE_AFTER_EXCHANGES = 4;

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
function shouldAssess({ history, socraticActive = false, rescueActive = false, alreadyQualified = false } = {}) {
  if (alreadyQualified) return false;
  if (rescueActive) return true;
  if (socraticActive) return false;
  return countExchanges(history) >= RESCUE_AFTER_EXCHANGES;
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
async function assessQualifying(transcriptText) {
  const { text, inputTokens, outputTokens, provider, model } = await callAI({
    purpose: 'criteria',
    systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
    maxTokens: 200,
  });
  const r = parseJsonObject(text); // throws on malformed output; the caller decides what that means
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
  RESCUE_AFTER_EXCHANGES, MAX_RESCUE_QUESTIONS,
  countExchanges, shouldAssess, assessQualifying, rescueDecision, checkRescueReply,
  flattenForPrompt, // re-exported so the chat route builds its transcript the same way
};
