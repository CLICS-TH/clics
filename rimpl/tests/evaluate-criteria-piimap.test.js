// /evaluate-criteria returns the on-prem reversible token→raw map (pii_map) for the backend to
// encrypt + persist — while still sending ZERO raw PII to the cloud model. Hermetic.
jest.mock('../src/services/claude', () => ({
  callClaude: jest.fn().mockResolvedValue({ text: '{"c4":true,"c5":true,"c6":true}', inputTokens: 5, outputTokens: 5 }),
}));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callClaude } = require('../src/services/claude');

describe('POST /evaluate-criteria — pii_map + boundary', () => {
  beforeEach(() => callClaude.mockClear());

  test('returns the token→raw pii_map AND sends no raw PII to the model', async () => {
    const res = await request(app).post('/evaluate-criteria').send({
      transcript: [{ role: 'physician', content: 'สมชายปวดท้องมา 2 วัน' }],
      patient_ref: 'นายสมชาย',
    });
    expect(res.status).toBe(200);
    expect(res.body.c4).toBe(true);
    expect(res.body.pii_map).toContainEqual({ token: '[NAME-1]', category: 'NAME', value: 'สมชาย' });
    const sentToClaude = JSON.stringify(callClaude.mock.calls[0][0].messages);
    expect(sentToClaude).not.toContain('สมชาย'); // the boundary still holds
    expect(sentToClaude).toContain('[NAME-1]');
  });

  test('a PII-free transcript yields an empty pii_map', async () => {
    const res = await request(app).post('/evaluate-criteria').send({
      transcript: [{ role: 'physician', content: 'BP 120/80, asked about renal dosing' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.pii_map).toEqual([]);
  });

  test('patient_ref: null is accepted (regression — backend sends `?? null`)', async () => {
    const res = await request(app).post('/evaluate-criteria').send({
      transcript: [{ role: 'physician', content: 'x' }], patient_ref: null,
    });
    expect(res.status).toBe(200); // .nullish() schema; .optional() would 400 on null
  });
});
