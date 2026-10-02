// Per-turn provenance for tutor and discussion replies (Phase 1.4). The backend stores what these
// routes return in messages / audit_discussions, so each stored reply can say which provider, model
// and prompt produced it. Hermetic: the AI seam is mocked, nothing leaves the process.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn().mockResolvedValue({
    text: 'Metformin is first-line (ADA, 2024).\n❓ How does renal function affect this choice?',
    tokenCount: 120, inputTokens: 100, outputTokens: 20,
    provider: 'local', model: 'deepseek-v4-flash-dspark',
  }),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { promptLabel, PROMPT_VERSION } = require('../src/lib/versions');
const P = require('../src/lib/prompts');

const chat = (extra = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', ...extra });

test('promptLabel is a stable hash of the exact text, and leaves the evaluator version alone', () => {
  expect(promptLabel('chat', 'abc')).toMatch(/^chat-prompt-[0-9a-f]{8}$/);
  expect(promptLabel('chat', 'abc')).toBe(promptLabel('chat', 'abc'));
  expect(promptLabel('chat', 'abc')).not.toBe(promptLabel('chat', 'abd'));
  expect(PROMPT_VERSION).toMatch(/^pis7-prompt-/);
});

test('a chat reply carries provider, model and the version of the prompt it was produced under', async () => {
  const res = await chat();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    provider: 'local', model: 'deepseek-v4-flash-dspark',
    prompt_version: promptLabel('chat', P.RIMPL_SYSTEM_PROMPT_NATURAL),
  });
});

test('examiner mode and artifact guidance are different instructions, so different versions', async () => {
  const natural = (await chat()).body.prompt_version;
  const examiner = (await chat({ socratic: true })).body.prompt_version;
  const withArtifacts = (await chat({ artifacts: true })).body.prompt_version;
  expect(examiner).toBe(promptLabel('chat', P.RIMPL_SYSTEM_PROMPT_EXAMINER));
  expect(withArtifacts).toBe(promptLabel('chat', P.RIMPL_SYSTEM_PROMPT_NATURAL + P.ARTIFACT_GUIDANCE));
  expect(new Set([natural, examiner, withArtifacts]).size).toBe(3);
});

test('audit-discuss versions its fixed instructions, not the per-episode transcript', async () => {
  const send = (content) => request(app).post('/audit-discuss').send({
    message: 'why d4?', transcript: [{ role: 'physician', content }], history: [],
  });
  const a = await send('first episode');
  const b = await send('a different episode');
  expect(a.status).toBe(200);
  expect(a.body).toMatchObject({ provider: 'local', model: 'deepseek-v4-flash-dspark' });
  expect(a.body.prompt_version).toBe(promptLabel('discuss', P.RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS));
  expect(b.body.prompt_version).toBe(a.body.prompt_version);
});
