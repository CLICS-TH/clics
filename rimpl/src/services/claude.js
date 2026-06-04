// rimpl/src/services/claude.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30000 });
const MODEL = 'claude-sonnet-4-6';

async function callClaude({ systemPrompt, messages, maxTokens = 1500 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  const text = response.content[0]?.text ?? '';
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return { text, tokenCount: inputTokens + outputTokens };
}

module.exports = { callClaude };
