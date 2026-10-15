// Anthropic provider, STREAMED (`onDelta`): messages.stream() instead of messages.create().
//   * text pieces reach onDelta in order; the result keeps the non-streamed contract exactly;
//   * an error before any text is retried; after text has gone out it is terminal (noRetry).
process.env.CLAUDE_MAX_RETRIES = '3';
process.env.CLAUDE_RETRY_BASE_MS = '1';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.CLAUDE_TIMEOUT_MS;

const mockStream = jest.fn();   // per attempt: ({ pieces, message } | { pieces, error })
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: {
    create: (body, opts) => ({ withResponse: () => mockCreate(body, opts) }),
    stream: (body, opts) => {
      const plan = mockStream(body, opts);
      const handlers = [];
      return {
        on(ev, cb) { if (ev === 'text') handlers.push(cb); return this; },
        async finalMessage() {
          for (const p of plan.pieces || []) handlers.forEach((h) => h(p));
          if (plan.error) throw plan.error;
          return plan.message;
        },
      };
    },
  },
})));

const { call } = require('../src/services/providers/anthropic');
const MSG = { content: [{ text: 'Hello there' }], usage: { input_tokens: 5, output_tokens: 7 }, stop_reason: 'end_turn', model: 'claude-sonnet-4-6' };
const args = (onDelta) => ({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, purpose: 'chat', onDelta });

beforeEach(() => { mockStream.mockReset(); mockCreate.mockReset(); });

test('streams text pieces and returns the usual result', async () => {
  mockStream.mockReturnValueOnce({ pieces: ['Hello', ' there'], message: MSG });
  const pieces = [];
  const r = await call(args((t) => pieces.push(t)));
  expect(pieces).toEqual(['Hello', ' there']);
  expect(r).toEqual({ text: 'Hello there', inputTokens: 5, outputTokens: 7, tokenCount: 12, stopReason: 'end_turn', model: 'claude-sonnet-4-6' });
  expect(mockCreate).not.toHaveBeenCalled();
});

test('without onDelta it uses messages.create as before', async () => {
  mockCreate.mockResolvedValueOnce({ data: MSG, response: { headers: new Map() } });
  await call(args(undefined));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockStream).not.toHaveBeenCalled();
});

test('a 529 before any text is retried', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockStream.mockReturnValueOnce({ error: { status: 529 } }).mockReturnValueOnce({ pieces: ['Hello there'], message: MSG });
  const r = await call(args(() => {}));
  expect(r.text).toBe('Hello there');
  expect(mockStream).toHaveBeenCalledTimes(2);
  console.warn.mockRestore();
});

test('a 529 after text has gone out is terminal: no retry, noRetry set', async () => {
  mockStream.mockReturnValue({ pieces: ['Hel'], error: { status: 529 } });
  await expect(call(args(() => {}))).rejects.toMatchObject({ status: 529, noRetry: true });
  expect(mockStream).toHaveBeenCalledTimes(1);
});

// The fast/deep router (routes/chat.js) passes `thinking` only to a provider that honours it, but
// `onReasoning` to any streamed call with the router on — and a fail-over could hand either to this
// provider. A streamed Anthropic call must send exactly the body it always sent and never call the hook
// (no "thinking…" status for a model that was not asked to think, and no extended-thinking parameter).
test('streamed: `thinking` and `onReasoning` are ignored — same body, the hook never called', async () => {
  mockStream.mockReturnValueOnce({ pieces: ['Hello there'], message: MSG });
  const onReasoning = jest.fn();
  await call({ ...args(() => {}), thinking: true, onReasoning });
  const [body] = mockStream.mock.calls[0];
  expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
  expect(JSON.stringify(body)).not.toMatch(/thinking/);
  expect(onReasoning).not.toHaveBeenCalled();
});
