// Reversible on-prem PII map: persistPiiMap encrypts the token→raw map into ple_pii_map (never
// plaintext), and the superadmin-only GET /admin/ples/:id/pii-map decrypts it for Tier-1 audit,
// logging every access. Hermetic: a tailored supabase mock + the REAL crypto (dev key).
let mockUser, mockPle, mockMapRow, mockUpsertError, capturedUpsert;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      const c = {
        select: () => c, eq: () => c,
        maybeSingle: () => Promise.resolve({
          data: table === 'ples' ? mockPle : table === 'ple_pii_map' ? mockMapRow : null,
          error: null,
        }),
        upsert: (payload) => { if (table === 'ple_pii_map') capturedUpsert = payload; return Promise.resolve({ error: mockUpsertError }); },
        insert: () => Promise.resolve({ error: null }),
      };
      return c;
    },
  },
  authSupabase: { auth: {} },
}));
jest.mock('../src/middleware/auth', () => ({
  verifyJwt: (req, _res, next) => { req.user = mockUser; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden' })),
}));
const mockLogEvent = jest.fn();
jest.mock('../src/lib/audit', () => ({ logEvent: (...a) => mockLogEvent(...a) }));

const request = require('supertest');
const express = require('express');
const { encryptJson } = require('../src/lib/crypto');
const { persistPiiMap } = require('../src/lib/pii-map');
const superadminRouter = require('../src/routes/superadmin');

const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
const SAMPLE = [{ token: '[NAME-1]', category: 'NAME', value: 'สมชาย' }, { token: '[PHONE-1]', category: 'PHONE', value: '081-234-5678' }];

beforeEach(() => {
  mockUser = { id: 'sa1', role: 'superadmin' };
  mockPle = { id: 'c1', ple_code: 'PLE-001', council_id: null };
  mockMapRow = { map_encrypted: encryptJson(SAMPLE), entry_count: SAMPLE.length };
  mockUpsertError = null;
  capturedUpsert = undefined;
  mockLogEvent.mockClear();
});

describe('persistPiiMap', () => {
  test('encrypts the map (no plaintext at rest) and round-trips', async () => {
    const { decryptJson } = require('../src/lib/crypto');
    await persistPiiMap('c1', SAMPLE);
    expect(capturedUpsert.ple_id).toBe('c1');
    expect(capturedUpsert.entry_count).toBe(2);
    expect(capturedUpsert.map_encrypted).not.toContain('สมชาย'); // opaque at rest
    expect(capturedUpsert.map_encrypted).not.toContain('081-234-5678');
    expect(decryptJson(capturedUpsert.map_encrypted)).toEqual(SAMPLE);
  });
  test('empty/missing map → no write', async () => {
    await persistPiiMap('c1', []);
    await persistPiiMap('c1', undefined);
    expect(capturedUpsert).toBeUndefined();
  });
  test('a write error is swallowed (fail-soft, never throws)', async () => {
    mockUpsertError = { message: 'db down' };
    await expect(persistPiiMap('c1', SAMPLE)).resolves.toBeUndefined();
  });
});

describe('GET /admin/ples/:id/pii-map (Tier-1 re-identification)', () => {
  test('superadmin gets decrypted entries + an audit row is written', async () => {
    const res = await request(app).get('/admin/ples/c1/pii-map').set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.ple_code).toBe('PLE-001');
    expect(res.body.entries).toEqual(SAMPLE);
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent.mock.calls[0][0]).toMatchObject({ action: 'pii.reidentify', targetId: 'PLE-001' });
  });
  test('a non-superadmin role is forbidden (403) and nothing is logged', async () => {
    mockUser = { id: 'a1', role: 'admin' };
    const res = await request(app).get('/admin/ples/c1/pii-map').set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
  test('a PLE with no stored map → 404', async () => {
    mockMapRow = null;
    const res = await request(app).get('/admin/ples/c1/pii-map').set('Authorization', 'Bearer t');
    expect(res.status).toBe(404);
  });
  test('an unknown PLE → 404', async () => {
    mockPle = null;
    const res = await request(app).get('/admin/ples/zzz/pii-map').set('Authorization', 'Bearer t');
    expect(res.status).toBe(404);
  });
});
