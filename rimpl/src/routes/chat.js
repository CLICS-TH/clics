const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, deriveHintTokens } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callClaude } = require('../services/claude');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, ARTIFACT_GUIDANCE } = require('../lib/prompts');
const { stripArtifactDelimiters } = require('../lib/transcript');

const router = Router();

// Per-reply output ceiling. Raised from the historical 1500/2500 so a substantial clinical artifact
// (DDx table / care plan) plus the prose + citation + closing ❓ fit without truncation. Cost is the
// ACTUAL tokens used, not the ceiling; the per-user $0.50 cap still bounds total spend.
const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10));

const ChatSchema = z.object({
  cle_id: z.string(),
  history: z.array(z.object({ role: z.string(), content: z.string() })),
  message: z.string().min(1),
  language: z.enum(['th', 'en']).default('th'),
  chief_complaint: z.string().optional(),
  // The physician's structured patient identifier (cle_patient_refs), passed on-prem SOLELY so RIMPL
  // can deterministically scrub it from the narrative before any cloud call — it is never forwarded.
  // nullish (not optional): the backend sends `?? null` when there is no patient_ref — null must pass.
  patient_ref: z.string().nullish(),
  // CLICS §6.4: true → Socratic clinical-examiner mode (CLE2 / Tier-1 remediation); false → natural.
  socratic: z.boolean().default(false),
  // Superadmin `clinical_artifacts` setting (the backend forwards it): true → allow the AI to emit
  // `:::artifact{...}` side-panel blocks. Default false; the transcript strip runs regardless.
  artifacts: z.boolean().default(false),
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

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, chief_complaint, patient_ref, socratic, artifacts } = parsed.data;
  // KNOWN patient identifiers to scrub deterministically (closes the bare-unlabelled-name leak).
  const hints = deriveHintTokens(patient_ref);
  // Examiner mode (CLE2 / remediation) leads with Socratic questioning and MUST end on ❓; natural
  // mode (CLE1/CLE3) answers directly and must NOT force a ❓ — that's the experimental contrast.
  // Append the artifact guidance only when the superadmin toggle (forwarded as `artifacts`) is on.
  const systemPrompt = (socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL)
    + (artifacts ? ARTIFACT_GUIDANCE : '');

  try {
    // De-identify ONCE, up front: PII must never leave the on-prem boundary — not to Claude and
    // not to the OpenAI embeddings API behind RAG. ragLookup previously received the raw message.
    const cleanMessage = stripPii(message, undefined, hints);
    const ragDocs = await ragLookup(cleanMessage);
    const messages = await buildMessages(history, cleanMessage, ragDocs, chief_complaint, hints);

    let { text, tokenCount, inputTokens, outputTokens } = await callClaude({ systemPrompt, messages, maxTokens: CHAT_MAX_TOKENS });

    // Retry once if a citation is missing (both modes), or — examiner mode only — the ❓ is missing.
    if (!hasCitation(text) || (socratic && !extractSocraticQuestion(text))) {
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
      const retry = await callClaude({ systemPrompt, messages: retryMessages, maxTokens: CHAT_MAX_TOKENS });
      text = retry.text;
      tokenCount += retry.tokenCount;
      inputTokens += retry.inputTokens;
      outputTokens += retry.outputTokens;
    }

    res.json({
      content: text,
      refs: extractReferences(text),
      socratic_question: extractSocraticQuestion(text),
      token_count: tokenCount,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (err) {
    console.error('[RIMPL chat] error:', err);
    res.status(500).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }
});

module.exports = router;
