const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callClaude } = require('../services/claude');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT } = require('../lib/prompts');

const router = Router();

const ChatSchema = z.object({
  ple_id: z.string(),
  history: z.array(z.object({ role: z.string(), content: z.string() })),
  message: z.string().min(1),
  language: z.enum(['th', 'en']).default('th'),
  chief_complaint: z.string().optional(),
});

async function buildMessages(history, message, ragDocs, chiefComplaint) {
  // Ground every turn in the case the physician opened the session with, so the AI
  // never has to ask for patient details it was already given at creation.
  const cc = chiefComplaint
    ? `ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ${stripPii(chiefComplaint)}\n\n`
    : '';
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  const cleanHistory = stripHistoryPii(history).map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: m.content,
  }));
  return [...cleanHistory, { role: 'user', content: cc + stripPii(message) + context }];
}

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language, chief_complaint } = parsed.data;

  try {
    const ragDocs = await ragLookup(message);
    const messages = await buildMessages(history, message, ragDocs, chief_complaint);

    let { text, tokenCount, inputTokens, outputTokens } = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages, maxTokens: 2500 });

    // Retry once if citation or socratic question missing
    if (!hasCitation(text) || !extractSocraticQuestion(text)) {
      const retryPrompt = language === 'th'
        ? 'ช่วยตอบคำถามเดิมให้ครบถ้วนและเป็นประโยชน์อีกครั้ง โดยใส่การอ้างอิงอย่างน้อยหนึ่งแห่งในรูปแบบ (แหล่ง, ปี) และปิดท้ายด้วยคำถามชวนคิดขึ้นบรรทัดใหม่นำหน้าด้วย ❓ — ตอบให้จริง ไม่ต้องปฏิเสธคำถาม'
        : 'Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation and end with a ❓ question on its own line. Engage with the question — do not decline to answer.';
      const retryMessages = [...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: retryPrompt },
      ];
      // Cheaper than the first call: the answer target is "<400 words", so a 1500-token cap is ample
      // for a corrected reply and roughly halves the retry's load on the Anthropic rate limit.
      const retry = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages: retryMessages, maxTokens: 1500 });
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
