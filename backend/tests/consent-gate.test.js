// Session creation (POST /ples) must be blocked until the physician has recorded informed consent.
let mockProf = { data: { id: 'doc1', role: 'physician', status: 'active', consented_at: null }, error: null };
let mockUser = { data: { user: { id: 'doc1', email: 'doc@clics.th' } }, error: null };

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve(mockProf), order: () => Promise.resolve({ data: [], error: null }) }) }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'ple1', status: 'active' }, error: null }) }) }),
    }),
  },
  authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
}));

const request = require('supertest');
const express = require('express');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  mockProf = { data: { id: 'doc1', role: 'physician', status: 'active', consented_at: null }, error: null };
});

test('POST /ples is blocked (403 consent_required) before consent', async () => {
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('consent_required');
});

test('POST /ples passes the consent gate once consented', async () => {
  mockProf = { data: { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z' }, error: null };
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).not.toBe(403); // gate cleared (proceeds to create)
  expect(res.body.code).not.toBe('consent_required');
});
