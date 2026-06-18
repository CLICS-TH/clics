const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii, deriveHintTokens } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callClaude } = require('../services/claude');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER } = require('../lib/prompts');

const router = Router();

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
  const cleanHistory = stripHistoryPii(history, hints).map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: m.content,
  }));
  return [...cleanHistory, { role: 'user', content: cc + cleanMessage + context }];
}

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, chief_complaint, patient_ref, socratic } = parsed.data;
  // KNOWN patient identifiers to scrub deterministically (closes the bare-unlabelled-name leak).
  const hints = deriveHintTokens(patient_ref);
  // Examiner mode (CLE2 / remediation) leads with Socratic questioning and MUST end on ❓; natural
  // mode (CLE1/CLE3) answers directly and must NOT force a ❓ — that's the experimental contrast.
  const systemPrompt = socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL;

  try {
    // De-identify ONCE, up front: PII must never leave the on-prem boundary — not to Claude and
    // not to the OpenAI embeddings API behind RAG. ragLookup previously received the raw message.
    const cleanMessage = stripPii(message, undefined, hints);
    const ragDocs = await ragLookup(cleanMessage);
    const messages = await buildMessages(history, cleanMessage, ragDocs, chief_complaint, hints);

    let { text, tokenCount, inputTokens, outputTokens } = await callClaude({ systemPrompt, messages, maxTokens: 2500 });

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
        { role: 'assistant', content: text },
        { role: 'user', content: retryPrompt },
      ];
      // Cheaper than the first call: the answer target is "<400 words", so a 1500-token cap is ample
      // for a corrected reply and roughly halves the retry's load on the Anthropic rate limit.
      const retry = await callClaude({ systemPrompt, messages: retryMessages, maxTokens: 1500 });
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
