// FAIL CLOSED on a de-identification failure. /evaluate and /evaluate-criteria used to call
// flattenForPrompt (the PII strip) OUTSIDE their try block, so a throw inside the filter — e.g. the
// stack overflow found in review of PR #114 — became an unhandled rejection that exits RIMPL under
// Node 22 (and the backend's evaluation retry would crash-loop it). Now it must be an ordinary 500
// with a generic body, and nothing may reach the model or the shadow evaluator. Hermetic.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn().mockResolvedValue('anthropic') }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));
jest.mock('../src/lib/transcript', () => {
  const actual = jest.requireActual('../src/lib/transcript');
  return { ...actual, flattenForPrompt: jest.fn() };
});

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { flattenForPrompt } = require('../src/lib/transcript');

const RAW = 'ผู้ป่วยชื่อ สมชาย ใจดี HN 12345678';
const body = { ple_id: 'x', transcript: [{ role: 'physician', content: RAW }], patient_ref: 'สมชาย ใจดี', shadow: true };

let errSpy;
beforeEach(() => {
  callAI.mockReset();
  flattenForPrompt.mockReset().mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded'); });
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('a throw inside de-identification is a 500, not a crash', () => {
  test.each(['/evaluate', '/evaluate-criteria'])('POST %s', async (route) => {
    const res = await request(app).post(route).send(body);
    expect(res.status).toBe(500);
    expect(callAI).not.toHaveBeenCalled();                 // nothing reached any model
    const wire = JSON.stringify(res.body) + res.text;
    for (const frag of ['สมชาย', 'ใจดี', '12345678', 'Maximum call stack']) expect(wire).not.toContain(frag);
  }, 3000); // before the fix the request was never answered (the handler rejected outside its try)
});
