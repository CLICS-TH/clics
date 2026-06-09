// The stub license verifier must be fully deterministic (no network, no clock dependence
// beyond checked_at) so every signup/invite gate is unit-testable. Mock supabase so the
// module imports cleanly (recordVerification touches it; verify() does not).
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
  authSupabase: {},
}));

const { getVerifier, stubVerify, toLicenseStatus, ADAPTER } = require('../src/services/license-verifier');

test('default adapter is stub', () => {
  expect(ADAPTER).toBe('stub');
});

test('stub: even last digit -> verified', () => {
  for (const lic of ['10', 'ว.12342', '8', '100006']) {
    expect(stubVerify({ license_number: lic }).status).toBe('verified');
  }
});

test('stub: last digit 1 or 3 -> name_mismatch', () => {
  expect(stubVerify({ license_number: '41' }).status).toBe('name_mismatch');
  expect(stubVerify({ license_number: '93' }).status).toBe('name_mismatch');
});

test('stub: last digit 5/7/9 -> not_found', () => {
  expect(stubVerify({ license_number: '15' }).status).toBe('not_found');
  expect(stubVerify({ license_number: '7' }).status).toBe('not_found');
  expect(stubVerify({ license_number: '999' }).status).toBe('not_found');
});

test('stub: UNAVAIL sentinel -> unavailable', () => {
  expect(stubVerify({ license_number: 'UNAVAIL' }).status).toBe('unavailable');
});

test('getVerifier().verify resolves with the stub result', async () => {
  const r = await getVerifier().verify({ license_number: '2', full_name_th: 'ก' });
  expect(r.source).toBe('stub');
  expect(r.status).toBe('verified');
  expect(typeof r.checked_at).toBe('string');
});

test('toLicenseStatus maps verify status -> professionals.license_status', () => {
  expect(toLicenseStatus('verified')).toBe('verified');
  expect(toLicenseStatus('name_mismatch')).toBe('name_mismatch');
  expect(toLicenseStatus('not_found')).toBe('not_found');
  expect(toLicenseStatus('unavailable')).toBe('unverified'); // unknown/unavailable stays unverified for review
});
