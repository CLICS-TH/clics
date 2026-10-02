const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, deriveHintTokens } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callAI } = require('../services/ai');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE } = require('../lib/prompts');
const { shouldAssess, rescueExhausted, assessQualifying, rescueDecision, checkRescueReply } = require('../services/rescue');
const { flattenForPrompt, stripArtifactDelimiters } = require('../lib/transcript');
const { requestSignal } = require('../lib/request-signal');
const { promptLabel } = require('../lib/versions');
const { sendAiError, logAiError, isAborted } = require('../lib/ai-errors');

const router = Router();

// Per-reply output ceiling. Raised from the historical 1500/2500 so a substantial clinical artifact
// (DDx table / care plan) plus the prose + citation + closing ❓ fit without truncation. Cost is the
// ACTUAL tokens used, not the ceiling; the per-user $0.50 cap still bounds total spend.
const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10));

const ChatSchema = z.object({
  ple_id: z.string(),
  history: z.array(z.object({ role: z.string(), content: z.string() })),
  message: z.string().min(1),
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
  // Socratic rescue state, forwarded by the backend from the `ples` row. RIMPL is stateless, so it
  // cannot know whether this session has already been rescued or has already qualified — and both
  // are latches (a session does not un-qualify). Without them the classifier would re-run on every
  // turn past the fourth, roughly doubling the AI cost of a long, good session.
  rescue_active: z.boolean().default(false),
  // Rounds this rescue has already run. RIMPL is stateless, so the spend cap cannot live here alone.
  rescue_rounds: z.number().int().min(0).default(0),
  already_qualified: z.boolean().default(false),
});

// `cleanMessage` MUST already be PII-stripped by the caller (see the route): the RAG embedding
// and the Claude call must use the same de-identified text, and PII must never reach either.
async function buildMessages(history, cleanMessage, ragDocs, chiefComplaint, hints = []) {
  // Ground every turn in the case the physician opened the session with, so the AI
  // never has to ask for patient details it was already given at creation.
  const cc = chiefComplaint
    ? `ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ${stripPii(chiefComplaint, undefined, hints)}\n\n`
    : '';
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  // Strip any clinical-artifact control syntax from prior turns before replaying them to the cloud:
  // the artifact body stays (clinical context the AI may need), but the `:::artifact{...}` fence never
  // re-enters the chat context — otherwise the model would see, and start mimicking, the literal delimiter.
  const cleanHistory = stripHistoryPii(history, hints).map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: stripArtifactDelimiters(m.content),
  }));
  return [...cleanHistory, { role: 'user', content: cc + cleanMessage + context }];
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

  const { history, message, language, chief_complaint, patient_ref, socratic, artifacts,
          rescue_active, already_qualified, rescue_rounds } = parsed.data;
  // KNOWN patient identifiers to scrub deterministically (closes the bare-unlabelled-name leak).
  const hints = deriveHintTokens(patient_ref);
  // Examiner mode (CLE2 / remediation) leads with Socratic questioning and MUST end on ❓; natural
  // mode (CLE1/CLE3) answers directly and must NOT force a ❓ — that's the experimental contrast.
  // Append the artifact guidance only when the superadmin toggle (forwarded as `artifacts`) is on.
  let systemPrompt = (socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL)
    + (artifacts ? ARTIFACT_GUIDANCE : '');
  // Fires if the physician's client (or the backend's deadline) hangs up: a queued call leaves the
  // queue and an in-flight one is cancelled, so a turn nobody is waiting for stops holding the model.
  const signal = requestSignal(req, res);

  try {
    // De-identify ONCE, up front: PII must never leave the on-prem boundary — not to Claude and
    // not to the OpenAI embeddings API behind RAG. ragLookup previously received the raw message.
    const cleanMessage = stripPii(message, undefined, hints);
    const ragDocs = await ragLookup(cleanMessage);
    const messages = await buildMessages(history, cleanMessage, ragDocs, chief_complaint, hints);

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
        const assessed = await assessQualifying(
          flattenForPrompt([...history, { role: 'physician', content: cleanMessage }], hints), { signal });
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

    let { text, tokenCount, inputTokens, outputTokens, provider, model, failed_over_from } =
      await callAI({ purpose: 'chat', systemPrompt, messages, maxTokens: CHAT_MAX_TOKENS, signal });
    // The call whose answer goes back: the retry below REPLACES these while the billing sums accumulate.
    // On a fail-over turn this result already is the fail-over call's, so these are its figures.
    let lastInputTokens = inputTokens;
    let lastOutputTokens = outputTokens;

    // A rescue turn asks questions and deliberately gives no answer, so it has nothing to cite and
    // the citation retry does not apply — running it would prompt the model to answer, which is the
    // one thing the rescue must not do.
    const rescuing = !!rescue?.rescuing;   // EVERY rescue round, not only the first

    // Retry once if a citation is missing (both modes), or — examiner mode only — the ❓ is missing.
    if (!rescuing && (!hasCitation(text) || (socratic && !extractSocraticQuestion(text)))) {
      const retryPrompt = socratic
        ? (language === 'th'
          ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) และปิดท้ายด้วยคำถามชวนคิดขึ้นบรรทัดใหม่นำหน้าด้วย ❓ — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม'
          : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation and end with a ❓ question on its own line. Engage with the question — do not decline to answer.')
        : (language === 'th'
          ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม และไม่ต้องปิดท้ายด้วยคำถามชวนคิด'
          : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation. Engage with the question — do not decline, and do not append a follow-up question.');
      const retryMessages = [...messages,
        // Strip the artifact fence from the just-produced reply before feeding it back as context, so
        // the corrected reply doesn't echo the literal delimiter.
        { role: 'assistant', content: stripArtifactDelimiters(text) },
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
      const retry = await callAI({ purpose: 'chat', provider, systemPrompt, messages: retryMessages, maxTokens: CHAT_MAX_TOKENS, signal });
      text = retry.text;
      tokenCount += retry.tokenCount;
      inputTokens += retry.inputTokens;
      outputTokens += retry.outputTokens;
      lastInputTokens = retry.inputTokens;
      lastOutputTokens = retry.outputTokens;
    }

    res.json({
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
      // Advisory, for the backend to persist: which turn the rescue fired on, why, and whether the
      // reply actually honoured the protocol's constraints. The SAP analyses trigger rate and
      // activation point, so an unrecorded rescue is a lost data point.
      // Post-checked on every round that ran under the rescue prompt. Checking only the first round
      // left rounds two onward of a rescued session governed by no constraint at all.
      rescue: rescue && { ...rescue, reply_check: rescue.rescuing ? checkRescueReply(text) : null },
    });
  } catch (err) {
    logAiError('[RIMPL chat]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'AI service temporarily unavailable. Please try again.');
  }
});

module.exports = router;
