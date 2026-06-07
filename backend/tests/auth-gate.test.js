// verifyJwt must reject pending (no professionals row) and deactivated accounts.
// We mock the supabase clients so no network/env is needed.
let mockProf = { data: null, error: null };
let mockUser = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve(mockProf) }) }),
    }),
  },
  authSupabase: {
    auth: { getUser: () => Promise.resolve(mockUser) },
  },
}));

const { verifyJwt } = require('../src/middleware/auth');

function run() {
  const req = { headers: { authorization: 'Bearer token' } };
  let statusCode = 200, body = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
  };
  const next = jest.fn();
  return verifyJwt(req, res, next).then(() => ({ statusCode, body, nextCalled: next.mock.calls.length > 0, req }));
}

beforeEach(() => {
  mockUser = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
});

describe('verifyJwt account-lifecycle gate', () => {
  test('pending (no professionals row) → 403 code:pending', async () => {
    mockProf = { data: null, error: { message: 'no rows' } };
    const r = await run();
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('pending');
    expect(r.nextCalled).toBe(false);
  });

  test('deactivated → 403 code:deactivated', async () => {
    mockProf = { data: { role: 'physician', status: 'deactivated', full_name_th: 'x', full_name_en: 'x' }, error: null };
    const r = await run();
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('deactivated');
    expect(r.nextCalled).toBe(false);
  });

  test('active → next() and req.user is populated', async () => {
    mockProf = { data: { role: 'physician', status: 'active', full_name_th: 'x', full_name_en: 'x', pseudonym: 'P-001' }, error: null };
    const r = await run();
    expect(r.nextCalled).toBe(true);
    expect(r.req.user).toMatchObject({ id: 'u1', role: 'physician', status: 'active', pseudonym: 'P-001' });
  });

  test('missing Authorization header → 401', async () => {
    const req = { headers: {} };
    let statusCode = 200;
    const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
    await verifyJwt(req, res, jest.fn());
    expect(statusCode).toBe(401);
  });
});
