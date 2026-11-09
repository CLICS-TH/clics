// #406: a booth physician turn is the bank question, a newline, then the visitor's typed answer
// (backend booth-dialogue.js dialogueTurns). A question that opens with the pronoun คุณ ("you") must not turn
// the answer under it into a name: the AI sorts and replies to that answer. Every request is built by the
// backend's own chatRequest and sent through POST /chat, so the route primes and strips it as in production.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { chatRequest, bankAt } = require('../../backend/src/services/booth-dialogue');

const CASES_DIR = path.join(__dirname, '../../backend/src/booth-cases/NFCME-2026');
const ANSWERS = [
  'ให้ออกซิเจนและส่งตรวจเพิ่มเติม',
  'ส่งตรวจ CBC และ electrolyte',
  'ให้น้ำเกลือและยาปฏิชีวนะทันที',
  'คิดถึงภาวะช็อกจากการเสียเลือด',
];
const L = ['B', 'R', 'W'];
const PATHS = ['', ...L, ...L.flatMap((x) => L.map((y) => x + y))];

// One play per (case, path, variant): every step typed, the earlier steps with the first variant of their bank.
const PLAYS = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((file) => {
  const kase = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8'));
  return PATHS.flatMap((tierPath) => bankAt(kase, tierPath).variants.map((v) => {
    const steps = tierPath.length + 1;
    const variants = [...Array(steps - 1)].map((_, i) => bankAt(kase, tierPath.slice(0, i)).variants[0].id).concat(v.id);
    const answers = variants.map((_, i) => ({ text: ANSWERS[(i + tierPath.length + v.id.length) % ANSWERS.length] }));
    const d = {
      answers,
      replies: answers.slice(1).map(() => ({ strength: 'ดี', weigh: '', safety: '' })),
      asks: variants.map((variant) => ({ variant, bridge: '' })),
      tierPath,
      unsorted: true,
    };
    return [`${file} ${tierPath || '-'} ${v.id}`, kase, d];
  }));
});

beforeEach(() => {
  callAI.mockReset();
  callAI.mockResolvedValue({ text: '{}', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'local-tutor', model: 'm' });
});

test('every NFCME-2026 case and path is played', () => {
  expect(new Set(PLAYS.map(([, kase]) => kase)).size).toBe(11);
  expect(PLAYS.length).toBeGreaterThan(300);
});

test.each(PLAYS)('%s: each typed answer reaches the AI as typed', async (_name, kase, d) => {
  await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
  // The last turn carries the sort block after the answer (services/booth.js withSort).
  const turns = callAI.mock.calls[0][0].messages.filter((m) => m.role === 'user').map((m) => m.content.split('\n\nSORT: ')[0]);
  expect(turns.map((t) => t.slice(t.lastIndexOf('\n')))).toEqual(d.answers.map(({ text }) => `\n${text}`));
});
