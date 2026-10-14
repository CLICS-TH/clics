const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, deriveHintTokens, makeRegistry } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callAI } = require('../services/ai');
const { hasCitation, extractSocraticQuestion, extractReferences, extractEvidenceLevel, thaiShare, stripNonProse, isLanguageMismatch, isThaiMessage } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE, EVIDENCE_GUIDANCE, EVIDENCE_RETRY_PROMPT } = require('../lib/prompts');
const { shouldAssess, rescueExhausted, assessQualifying, rescueDecision, checkRescueReply, RESCUE_RETRY_PROMPT } = require('../services/rescue');
const { formatDeidentified, stripArtifactDelimiters } = require('../lib/transcript');
const { requestSignal } = require('../lib/request-signal');
const { promptLabel } = require('../lib/versions');
const { sendAiError, logAiError, isAborted } = require('../lib/ai-errors');
const { sseStream } = require('../lib/sse');

const router = Router();

// Per-reply output ceiling. Raised from the historical 1500/2500 so a substantial clinical artifact
// (DDx table / care plan) plus the prose + citation + closing ❓ fit without truncation. Cost is the
// ACTUAL tokens used, not the ceiling; the per-user $0.50 cap still bounds total spend.
const { CHAT_MAX_TOKENS, MAX_TURN_CHARS } = require('../lib/turn-limits'); // RIMPL_CHAT_MAX_TOKENS, default 4000

const ChatSchema = z.object({
  ple_id: z.string(),
  // Per-turn cap: see lib/turn-limits.js (sized so no real physician or assistant turn can hit it).
  history: z.array(z.object({ role: z.string(), content: z.string().max(MAX_TURN_CHARS) })),
  message: z.string().min(1).max(MAX_TURN_CHARS),
  language: z.enum(['th', 'en']).default('th'),
  chief_complaint: z.string().optional(),
  // The physician's structured patient identifier (ple_patient_refs), passed on-prem SOLELY so RIMPL
  // can deterministically scrub it from the narrative before any cloud call — it is never forwarded.
  // nullish (not optional): the backend sends `?? null` when there is no patient_ref — null must pass.
  patient_ref: z.string().nullish(),
  // CLICS §6.4: true → Socratic clinical-examiner mode (CLE2 / Tier-1 remediation); false → natural.
  socratic: z.boolean().default(false),
  // Superadmin `clinical_artifacts` setting (the backend forwards it): true → allow the AI to emit
  // `:::artifact{...}` side-panel blocks. Default false; the transcript strip runs regardless.
  artifacts: z.boolean().default(false),
  // App setting `chat_evidence_marker` (the backend forwards it; CCME R5): true -> every non-rescue reply
  // must carry exactly one GRADE evidence-level line (lib/prompts.js EVIDENCE_GUIDANCE), checked below.
  // Default false. An older backend never sends it; an older RIMPL strips it (zod drops unknown keys).
  evidence_marker: z.boolean().default(false),
  // Socratic rescue state, forwarded by the backend from the `ples` row. RIMPL is stateless, so it
  // cannot know whether this session has already been rescued or has already qualified — and both
  // are latches (a session does not un-qualify). Without them the classifier would re-run on every
  // turn past the fourth, roughly doubling the AI cost of a long, good session.
  rescue_active: z.boolean().default(false),
  // Rounds this rescue has already run. RIMPL is stateless, so the spend cap cannot live here alone.
  rescue_rounds: z.number().int().min(0).default(0),
  already_qualified: z.boolean().default(false),
  // Stream the reply as server-sent events (lib/sse.js). Honoured on every turn EXCEPT a rescue turn,
  // which is answered whole as before: its post-check may rewrite the reply, and a physician who had
  // watched the first draft arrive would already have read the answer the rescue exists to withhold.
  stream: z.boolean().default(false),
});

// De-identify everything one outbound call carries under ONE registry, so a token means one person
// (or phone, HN, ...) across the whole prompt: `[NAME-1]` in the history and `[NAME-1]` in the
// current message are the same referent, and one person never gets two tokens. Separate registries
// (as here before) numbered each piece from 1, so two different patients could share `[NAME-1]`.
//
// ORDER IS LOAD-BEARING. Tokens are numbered by first appearance in processing order, and a name part
// seen earlier is also caught bare later (the filter's bare-name pass). The order is the order the
// session happened in: chief complaint (given at creation) -> stored history, oldest first -> the
// current message. That makes the numbering prefix-stable: turn N numbers every earlier turn exactly
// as turn N-1 did, so the tokens the model wrote into its own stored replies keep meaning the same
// person on later turns. POST /deidentify (the auditor's view) uses the same order for the same reason.
//
// Returns the pieces still separate: the caller embeds `cleanMessage` for RAG and sends the very same
// string to the model (the RAG lookup and the AI call must see identical de-identified text).
function deidentifyTurn({ chiefComplaint, history, message, hints }) {
  const registry = makeRegistry();
  const cleanChiefComplaint = chiefComplaint ? stripPii(chiefComplaint, registry, hints) : '';
  const cleanHistory = stripHistoryPii(history, hints, registry);
  const cleanMessage = stripPii(message, registry, hints);
  return { cleanChiefComplaint, cleanHistory, cleanMessage };
}

// Every input here MUST already be PII-stripped by deidentifyTurn (see the route): this function only
// assembles the prompt and masks nothing.
function buildMessages(cleanHistory, cleanMessage, ragDocs, cleanChiefComplaint) {
  // Ground every turn in the case the physician opened the session with, so the AI
  // never has to ask for patient details it was already given at creation.
  const cc = cleanChiefComplaint
    ? `ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ${cleanChiefComplaint}\n\n`
    : '';
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  // Strip any clinical-artifact control syntax from prior turns before replaying them to the cloud:
  // the artifact body stays (clinical context the AI may need), but the `:::artifact{...}` fence never
  // re-enters the chat context — otherwise the model would see, and start mimicking, the literal delimiter.
  const history = cleanHistory.map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: stripArtifactDelimiters(m.content),
  }));
  return [...history, { role: 'user', content: cc + cleanMessage + context }];
}

// What the model LAST saw plus what it said, for the ONE call whose answer is returned — as a plain
// integer, or null. The backend stores this as ples.context_tokens for its transcript cap; the
// input_tokens / output_tokens it also receives are BILLING figures and are summed over every call in
// the turn, so on a citation-retry turn they run ~2x the real context and the 64k cap fired at ~32k.
// null, never 0, when the provider reported no usage at all: the backend then falls back to its own
// sum instead of storing a zero that would let the cap never fire.
function contextTokens(inputTokens, outputTokens) {
  if (inputTokens == null && outputTokens == null) return null;
  const n = Number(inputTokens ?? 0) + Number(outputTokens ?? 0);
  return Number.isInteger(n) ? n : null;
}

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, chief_complaint, patient_ref, socratic, artifacts, evidence_marker,
          rescue_active, already_qualified, rescue_rounds, stream } = parsed.data;
  // KNOWN patient identifiers to scrub deterministically (closes the bare-unlabelled-name leak).
  const hints = deriveHintTokens(patient_ref);
  // Examiner mode (CLE2 / remediation) leads with Socratic questioning and MUST end on ❓; natural
  // mode (CLE1/CLE3) answers directly and must NOT force a ❓ — that's the experimental contrast.
  // Append the artifact guidance only when the superadmin toggle (forwarded as `artifacts`) is on, and
  // the evidence-marker guidance (its placement differs by mode) only when `evidence_marker` is on. A
  // rescue turn REPLACES all of this below, so the rescue prompt never carries either.
  let systemPrompt = (socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL)
    + (artifacts ? ARTIFACT_GUIDANCE : '')
    + (evidence_marker ? EVIDENCE_GUIDANCE[socratic ? 'examiner' : 'natural'] : '');
  // Fires if the physician's client (or the backend's deadline) hangs up: a queued call leaves the
  // queue and an in-flight one is cancelled, so a turn nobody is waiting for stops holding the model.
  const signal = requestSignal(req, res);
  // Set once the rescue decision is known (below). Until a first delta is sent the route answers in
  // plain JSON, so every early failure keeps its usual status and body.
  let sse = null;

  try {
    // De-identify ONCE, up front, under one shared registry (deidentifyTurn): PII must never leave
    // the on-prem boundary — not to Claude and not to the OpenAI embeddings API behind RAG.
    // ragLookup previously received the raw message.
    const { cleanChiefComplaint, cleanHistory, cleanMessage } =
      deidentifyTurn({ chiefComplaint: chief_complaint, history, message, hints });
    const ragDocs = await ragLookup(cleanMessage);
    const messages = buildMessages(cleanHistory, cleanMessage, ragDocs, cleanChiefComplaint);

    // Socratic rescue (CREC082 PLE Instruction Sheet §4). Decided HERE, from the conversation, on
    // the turn it applies to — never from which episode this is or who the physician is.
    //
    // Failure is silent by design. If the classifier errors or returns malformed JSON, the turn
    // proceeds as a normal reply: a missed rescue costs one scaffolding nudge, whereas failing the
    // request would cost the physician their turn over an advisory signal. It is logged, not raised.
    let rescue = null;
    const exchangesSoFar = history.filter(m => m.role === 'physician' || m.role === 'user').length;

    // The rescue has run its round cap. It ends HERE, under the rescue prompt one last time — the
    // constraint holds for the turn the physician is already mid-way through — and the backend is
    // told so it can close the rescue out and record why it ended. Falling through to the block
    // below instead would have produced a turn on the general examiner prompt, which is the
    // instrument swap the per-round rescue exists to prevent.
    if (rescueExhausted({ rescueActive: rescue_active, rescueRounds: rescue_rounds })) {
      systemPrompt = RIMPL_SYSTEM_PROMPT_RESCUE;
      rescue = {
        activated: false, rescuing: true, recovered: false, exhausted: true,
        reason: 'rescue round cap reached without the session qualifying',
        elements: null, on_topic: null, qualifying: null,
        exchanges_before: exchangesSoFar,
        // No classifier ran, so there is nothing to bill. Reported as zero rather than omitted, so
        // the backend's spend path sees the same shape on every round.
        assessment: { input_tokens: 0, output_tokens: 0, provider: null },
      };
    } else if (shouldAssess({ history, socraticActive: socratic, rescueActive: rescue_active, alreadyQualified: already_qualified, rescueRounds: rescue_rounds })) {
      try {
        // Include the turn just sent — the physician may have qualified the session WITH this
        // message, and rescuing them for a gap they have already closed would be plainly wrong.
        // The turns already stripped above, under the SAME registry, so the classifier reads the
        // tokens the chat call reads (re-stripping here used a fresh registry: a second numbering).
        const assessed = await assessQualifying(
          formatDeidentified([...cleanHistory, { role: 'physician', content: cleanMessage }]), { signal });
        const decision = rescueDecision(assessed);
        rescue = {
          // First activation, distinct from a later round of an ongoing rescue. The backend stamps
          // the activation POINT from this and must never move it, so the two cannot share a flag.
          activated: decision.rescue && !rescue_active,
          // This round actually ran under the rescue prompt — the condition the post-check and the
          // citation skip both key off, and true on continuing rounds as well as the first.
          rescuing: decision.rescue,
          // The session came back. This is the "return to PLE eligibility" the analysis plan asks
          // for, and it was unobservable while a rescued session was assessed only once.
          recovered: rescue_active && !decision.rescue,
          // Only the cap-reached branch above sets this.
          exhausted: false,
          reason: decision.reason,
          elements: assessed.elements,
          on_topic: assessed.onTopic,
          qualifying: assessed.qualifying,
          exchanges_before: exchangesSoFar,
          // Reported so the backend can charge it to the STUDY rather than the physician. These
          // tokens were returned by the classifier all along and simply thrown away, which made the
          // spend invisible — fine at one call per session, not fine at one per round.
          assessment: {
            input_tokens: assessed.inputTokens ?? 0,
            output_tokens: assessed.outputTokens ?? 0,
            provider: assessed.provider ?? null,
          },
        };
        if (decision.rescue) systemPrompt = RIMPL_SYSTEM_PROMPT_RESCUE;
      } catch (e) {
        // The client has hung up: there is no turn to deliver, so do not buy the reply either.
        if (isAborted(e)) throw e;
        console.error('[RIMPL chat] rescue assessment failed, continuing as a normal turn:', e.message);
        // A malformed classifier reply was still BILLED. Report the usage even though the assessment
        // is unusable, or the study's cost record drifts below what was actually spent — and under
        // an active rescue the next turn buys another one.
        if (e.usage) {
          rescue = {
            activated: false, rescuing: false, recovered: false, exhausted: false, reason: null,
            elements: null, on_topic: null, qualifying: null,
            exchanges_before: exchangesSoFar,
            assessment: {
              input_tokens: e.usage.inputTokens ?? 0,
              output_tokens: e.usage.outputTokens ?? 0,
              provider: e.usage.provider ?? null,
            },
          };
        }
      }
    }

    // A rescue turn asks questions and deliberately gives no answer, so it has nothing to cite and
    // the citation retry does not apply — running it would prompt the model to answer, which is the
    // one thing the rescue must not do.
    const rescuing = !!rescue?.rescuing;   // EVERY rescue round, not only the first

    // Streaming: known only now, because a rescue turn is never streamed (see the schema).
    if (stream && !rescuing) sse = sseStream(res);
    let shown = false;   // text of the CURRENT call has reached the caller
    const onDelta = sse ? (t) => { shown = true; sse.send('delta', { text: t }); } : undefined;

    let { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } =
      await callAI({ purpose: 'chat', systemPrompt, messages, maxTokens: CHAT_MAX_TOKENS, signal, onDelta });
    // The call whose answer goes back: the retry below REPLACES these while the billing sums accumulate.
    // On a fail-over turn this result already is the fail-over call's, so these are its figures.
    let lastInputTokens = inputTokens;
    let lastOutputTokens = outputTokens;

    // ONE corrective retry, whatever is wrong. Independent checks decide whether it fires, and a turn
    // that fails several gets a SINGLE retry whose prompt asks for every fix, so a turn never makes
    // more than two AI calls in total (and the billing sums below stay a plain two-call sum).
    //   - citation missing (both modes), or — examiner mode only — the ❓ missing. Not on a rescue turn.
    //   - LANGUAGE: the physician wrote substantially in Thai and the reply is mostly-not-Thai
    //     (post-filter's isLanguageMismatch, which ignores code, URLs, citations, :::artifact blocks
    //     and a trailing References list). `language === 'th'` alone is NOT enough: the client sets it
    //     when the message contains ANY Thai codepoint, so "What is first-line for CAP? ครับ" is 'th'.
    //     We therefore also require the physician's own message to be >= THAI_MIN_SHARE Thai, so a
    //     physician who wrote in English is never forced into Thai (an English turn is never policed
    //     either). That share is computed here, on-prem; only the boolean outcome is used. This check
    //     DOES apply to a rescue turn: it asks for a rewrite, not a fresh answer, so it cannot make a
    //     rescue reply answer the question it is deliberately withholding.
    const needCitation = !rescuing && (!hasCitation(text) || (socratic && !extractSocraticQuestion(text)));
    const physicianWroteThai = language === 'th' && isThaiMessage(message);
    const languageMismatch = physicianWroteThai && isLanguageMismatch(text, language);
    // RESCUE: a rescue reply with no question, more than the allowed questions, or a diagnosis/plan breaks
    // the rescue (rescue.js checkRescueReply). It gets the same single retry — a REWRITE into questions.
    const needRescue = rescuing && !checkRescueReply(text).ok;
    // EVIDENCE MARKER (evidence_marker on): exactly one parseable evidence-level line, outside any fence
    // (post-filter extractEvidenceLevel). Not on a rescue turn: the rescue prompt replaced the guidance
    // and a rescue reply recommends nothing to grade.
    const needEvidence = evidence_marker && !rescuing && extractEvidenceLevel(text) == null;
    let languageRetried = false;   // the retry's reply is the one being returned
    let rescueRetried = false;
    let evidenceRetried = false;
    // A streamed first draft that the retry below replaces. The physician watched it arrive, so the
    // record keeps it (the backend stores it beside the reply it was replaced by); never set on a
    // non-streamed turn, where nobody saw it.
    let supersededDraft = null;
    let supersededReason = null;
    if (needCitation || languageMismatch || needRescue || needEvidence) {
      let retryPrompt;
      if (needCitation) {
        retryPrompt = socratic
          ? (language === 'th'
            ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) และปิดท้ายด้วยคำถามชวนคิดขึ้นบรรทัดใหม่นำหน้าด้วย ❓ — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม'
            : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation and end with a ❓ question on its own line. Engage with the question — do not decline to answer.')
          : (language === 'th'
            ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม และไม่ต้องปิดท้ายด้วยคำถามชวนคิด'
            : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation. Engage with the question — do not decline, and do not append a follow-up question.');
        // Both checks failed: the same single retry also pins the language.
        if (languageMismatch) retryPrompt += ' และเขียนคำตอบทั้งหมดเป็นภาษาไทย (Write the whole reply in Thai.)';
        // A re-answer that must also carry the evidence line.
        if (needEvidence) retryPrompt += EVIDENCE_RETRY_PROMPT.suffix[language];
      } else if (needRescue) {
        retryPrompt = language === 'th' ? RESCUE_RETRY_PROMPT.th : RESCUE_RETRY_PROMPT.en;
        if (languageMismatch) retryPrompt += ' และเขียนเป็นภาษาไทย (Write it in Thai.)';
      } else if (languageMismatch) {
        // Language (and perhaps the evidence line): the reply is otherwise acceptable, so ask for a
        // rewrite that keeps its content, citations, any ❓ and any :::artifact block — not a new answer.
        retryPrompt = 'กรุณาเขียนคำตอบก่อนหน้านี้ใหม่เป็นภาษาไทย โดยคงเนื้อหาทางคลินิก การอ้างอิง (แหล่ง, ปี) และคำถามที่ขึ้นต้นด้วย ❓ (ถ้ามี) ไว้ตามเดิม และคงบล็อก :::artifact ทั้งบล็อก (ถ้ามี) ไว้ตามเดิมทุกประการ — ชื่อยา ตัวย่อ และชื่อแหล่งอ้างอิงเป็นภาษาอังกฤษได้ '
          + '(Please rewrite your previous reply in Thai, keeping the same clinical content, (Source, Year) citations and any ❓ question on its own line. Keep any :::artifact block exactly as is, fence lines included. Drug names, abbreviations and source titles may stay in English.)';
        if (needEvidence) retryPrompt += EVIDENCE_RETRY_PROMPT.suffix[language];
      } else {
        // Evidence line only: a REWRITE that adds the one line and keeps everything else, like the
        // language-only rewrite above — not a new answer.
        retryPrompt = EVIDENCE_RETRY_PROMPT.only[language];
      }
      // A citation retry re-ANSWERS, so the artifact fence is stripped from the just-produced reply
      // before it is fed back, and the corrected reply doesn't echo the literal delimiter. A
      // language-only (or evidence-only) retry REWRITES and must keep the fence the side panel depends
      // on, so it sees the reply intact — but only when artifacts are on (the system prompt then
      // explains the fence); with them off a stray fence is stripped as before.
      const keepFence = !needCitation && !needRescue && artifacts;
      const retryMessages = [...messages,
        { role: 'assistant', content: keepFence ? text : stripArtifactDelimiters(text) },
        { role: 'user', content: retryPrompt },
      ];
      // Same ceiling as the first call — a corrected reply may itself carry an artifact, so a LOWER retry
      // cap would truncate it worse than the original (the old 1500 cap assumed a "<400 words" reply).
      //
      // PINNED to whichever provider served the first call. Now that the provider is a live setting
      // rather than an env var, a superadmin flipping `chat` between these two calls would otherwise
      // have ONE physician turn written half by Claude and half by the DGX — and `messages` has no
      // model column, so nothing would record that it happened. `provider` is undefined only when a
      // caller mocked callAI without it, in which case this falls back to normal resolution.
      const firstText = text;
      const firstShown = shown;
      const reason = needCitation ? 'citation' : needRescue ? 'rescue' : languageMismatch ? 'language' : 'evidence';
      // Tell the caller the text it is showing is about to be replaced. The retry itself is NOT streamed:
      // a retry that failed half-way would leave words on screen that no record holds (and a failed
      // language-only retry keeps the first reply). Its finished text goes out in one piece below.
      if (sse && firstShown) { sse.send('replace', { reason }); shown = false; }
      let retry;
      try {
        retry = await callAI({ purpose: 'chat', provider, systemPrompt, messages: retryMessages, maxTokens: CHAT_MAX_TOKENS, signal });
      } catch (err) {
        // The client is gone, or the retry was needed for a missing citation/❓ (that reply was not
        // deliverable, and failing closed there is the existing behaviour): propagate.
        if (isAborted(err) || needCitation) throw err;
        // A LANGUAGE-only (or rescue / evidence-line) retry is a nicety on top of a reply that was
        // already deliverable. Losing the physician's turn (and, on a rescue turn, the rescue activation
        // riding on this response) to a queue_full / 413 / 5xx on it would be worse than the first
        // answer. Keep the first reply and its token sums; log the code only, never content.
        console.warn(`[RIMPL chat] ${reason} retry failed (${err?.code ?? err?.status ?? 'error'}) — delivering the first reply`);
        retry = null;
      }
      // An evidence-line-ONLY rewrite exists to add one line to a reply that already passed every other
      // check. If it came back still without a single parseable marker — or lost something the first
      // reply had (its citation, its ❓ in examiner mode, Thai on a Thai turn) — it made the turn worse:
      // keep the first reply, as a failed language-only retry does. Never thrown. The call is still billed.
      const keepFirst = !!retry && reason === 'evidence' && (extractEvidenceLevel(retry.text) == null
        || !hasCitation(retry.text) || (socratic && !extractSocraticQuestion(retry.text))
        || (physicianWroteThai && isLanguageMismatch(retry.text, language)));
      if (retry) {
        tokenCount += retry.tokenCount;
        inputTokens += retry.inputTokens;
        outputTokens += retry.outputTokens;
      }
      if (keepFirst) {
        // context_tokens stays the first call's: the first reply is the one stored and replayed next turn.
        console.warn('[RIMPL chat] evidence retry rejected (no single evidence line, or it dropped the citation, ❓ or Thai) — delivering the first reply');
      } else if (retry) {
        text = retry.text;
        lastInputTokens = retry.inputTokens;
        lastOutputTokens = retry.outputTokens;
        languageRetried = languageMismatch;
        rescueRetried = needRescue;
        evidenceRetried = needEvidence;
        if (firstShown) { supersededDraft = firstText; supersededReason = reason; }
        if (sse) sse.send('delta', { text });
        // The one retry is all there is. If the reply is STILL not Thai, deliver it (a late English
        // answer beats a 502) but leave a trace with the measured share only — never the content.
        if (languageMismatch && isLanguageMismatch(text, language)) {
          console.warn(`[RIMPL chat] language retry did not produce Thai (share ${thaiShare(stripNonProse(text)).toFixed(2)}) — delivering as-is`);
        }
      }
    }

    (sse ? sse.out() : res).json({
      content: text,
      refs: extractReferences(text),
      socratic_question: extractSocraticQuestion(text),
      token_count: tokenCount,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      // The returned call's own in+out (see contextTokens above) — NOT the two-call sums above it.
      context_tokens: contextTokens(lastInputTokens, lastOutputTokens),
      // Which vendor actually served this turn — the backend prices per provider (local = $0), so
      // omitting it under a hybrid would bill on-prem tokens at cloud rates.
      provider,
      model,
      // Which instructions produced this reply: the hash of the system prompt actually sent on the
      // returned call (mode prompt, rescue prompt if the rescue took over, plus artifact guidance).
      prompt_version: promptLabel('chat', systemPrompt),
      // Set only when the primary provider was down and CHAT_FAILOVER_PROVIDER answered instead
      // (services/ai.js; dormant — unset — by default). Null on every ordinary turn. The citation
      // retry above is pinned to `provider`, so the whole turn came from the provider named above.
      failed_over_from: failed_over_from ?? null,
      // True when the language guard fired AND its retry's reply is the one returned. False when the
      // guard did not fire, or when its retry failed and the first reply was kept. Advisory and
      // rimpl-local: the backend whitelists its response to the physician and does not forward this.
      language_retry: languageRetried,
      // True when the rescue rules failed on the first reply AND the rewrite is the reply returned.
      rescue_retry: rescueRetried,
      // CCME R5 evidence marker: the level the returned reply's ONE evidence line states — 'high' |
      // 'moderate' | 'low' | 'expert' — or null: setting off, a rescue turn, or no single parseable
      // line even after the retry (the reply is delivered regardless; this field is how that shows).
      // Advisory, like language_retry: the backend whitelists its physician response and does not
      // forward either field.
      evidence_level: evidence_marker && !rescuing ? extractEvidenceLevel(text) : null,
      // True when the evidence check fired on the first reply AND the retry's reply is the one returned.
      evidence_retry: evidenceRetried,
      // Advisory, for the backend to persist: which turn the rescue fired on, why, and whether the
      // reply actually honoured the protocol's constraints. The SAP analyses trigger rate and
      // activation point, so an unrecorded rescue is a lost data point.
      // Post-checked on every round that ran under the rescue prompt. Checking only the first round
      // left rounds two onward of a rescued session governed by no constraint at all.
      rescue: rescue && { ...rescue, reply_check: rescue.rescuing ? checkRescueReply(text) : null },
      // Streamed turns only (absent otherwise, so a non-streamed body is unchanged): the draft the
      // physician saw before the retry replaced it, and which check replaced it.
      ...(sse ? { superseded_draft: supersededDraft, superseded_reason: supersededReason } : {}),
    });
  } catch (err) {
    logAiError('[RIMPL chat]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    // Once a stream is open the error becomes its final event, with the status and body it would
    // have had (lib/sse.js out()).
    const out = sse ? sse.out() : res;
    sendAiError(out, err, 'AI service temporarily unavailable. Please try again.');
    if (sse?.open && isAborted(err) && !res.writableEnded) res.end();
  }
});

module.exports = router;
