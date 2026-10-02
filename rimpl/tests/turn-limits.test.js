// Per-turn length caps on /chat and /audit-discuss (lib/turn-limits.js). Defence in depth against an
// oversize turn pinning the event loop in the PII filter (review of PR #114): over the cap is a 400
// that never reaches the filter or a model; a turn the size of a real reply is still accepted.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn().mockResolvedValue({
    text: 'ควรตรวจ troponin ซ้ำ (ESC, 2023).\n❓ ทำไม?', inputTokens: 10, outputTokens: 10, tokenCount: 20,
    provider: 'anthropic', model: 'claude-sonnet-4-6', stopReason: 'end_turn',
  }),
  resolveProviderName: jest.fn().mockResolvedValue('anthropic'),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { CHAT_MAX_TOKENS, MAX_TURN_CHARS } = require('../src/lib/turn-limits');

beforeEach(() => callAI.mockClear());

describe('turn length caps', () => {
  test('the cap sits safely above the largest possible chat reply (6 chars/token) and the 5000-char physician cap', () => {
    expect(MAX_TURN_CHARS).toBeGreaterThanOrEqual(CHAT_MAX_TOKENS * 6);
    expect(MAX_TURN_CHARS).toBeGreaterThanOrEqual(24000);
  });

  test('/chat: an over-length history item is a 400 and no model is called', async () => {
    const res = await request(app).post('/chat').send({
      ple_id: 'x', message: 'q', language: 'th', history: [{ role: 'assistant', content: 'ก'.repeat(MAX_TURN_CHARS + 1) }],
    });
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });

  test('/chat: an over-length message is a 400', async () => {
    const res = await request(app).post('/chat').send({ ple_id: 'x', message: 'ก'.repeat(MAX_TURN_CHARS + 1), history: [] });
    expect(res.status).toBe(400);
  });

  test('/chat: a long but real assistant turn is accepted', async () => {
    const res = await request(app).post('/chat').send({
      ple_id: 'x', message: 'q', language: 'th', history: [{ role: 'assistant', content: 'ก'.repeat(12000) }],
    });
    expect(res.status).toBe(200);
  });

  test('/audit-discuss: an over-length transcript or history item is a 400', async () => {
    const long = [{ role: 'physician', content: 'ก'.repeat(MAX_TURN_CHARS + 1) }];
    for (const extra of [{ transcript: long }, { history: long }]) {
      const res = await request(app).post('/audit-discuss').send({ message: 'q', ...extra });
      expect(res.status).toBe(400);
    }
    expect(callAI).not.toHaveBeenCalled();
  });
});
