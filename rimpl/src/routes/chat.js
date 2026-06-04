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
});

async function buildMessages(history, message, ragDocs) {
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  const cleanHistory = stripHistoryPii(history).map(m => ({
    role: m.role === 'physician' ? 'user' : 'assistant',
    content: m.content,
  }));
  return [...cleanHistory, { role: 'user', content: stripPii(message) + context }];
}

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language } = parsed.data;

  try {
    const ragDocs = await ragLookup(message);
    const messages = await buildMessages(history, message, ragDocs);

    let { text, tokenCount } = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages });

    // Retry once if citation or socratic question missing
    if (!hasCitation(text) || !extractSocraticQuestion(text)) {
      const retryPrompt = language === 'th'
        ? 'กรุณาตอบใหม่ โดยต้องมี (แหล่งอ้างอิง, ปี) และคำถาม ❓ ท้ายคำตอบ'
        : 'Please revise: include at least one (Source, Year) citation and end with an ❓ question.';
      const retryMessages = [...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: retryPrompt },
      ];
      const retry = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages: retryMessages });
      text = retry.text;
      tokenCount += retry.tokenCount;
    }

    res.json({
      content: text,
      refs: extractReferences(text),
      socratic_question: extractSocraticQuestion(text),
      token_count: tokenCount,
    });
  } catch (err) {
    console.error('[RIMPL chat] error:', err);
    res.status(500).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }
});

module.exports = router;
