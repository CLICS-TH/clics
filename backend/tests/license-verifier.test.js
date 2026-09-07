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

// The stub answers 'verified' from the last digit of the licence number, and
// audit-dashboard/app/admin/identity/page.tsx renders that as a green
// "Licence found, name matches" — a positive, NAME-MATCHED assertion produced by arithmetic.
// Production has never set LICENSE_VERIFIER_ADAPTER, and POST /auth/identity/national-id is live and
// not gated by identity_verification_required, so the only reason nothing has been fabricated yet is
// that no physician has submitted.
describe('the stub must never serve production', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = env; delete process.env.RAILWAY_ENVIRONMENT; });

  test('in production the verifier degrades to unavailable instead of guessing', async () => {
    process.env.NODE_ENV = 'production';
    // '10' ends in 0, which the stub calls verified. It must not.
    const r = await getVerifier().verify({ license_number: '10', full_name_th: 'ก' });
    expect(r.status).toBe('unavailable');
    expect(r.source).not.toBe('stub');
    // 'unavailable' is already handled end to end: it maps to unverified and the admin card says
    // "verify manually", so failing closed costs nothing but the fabricated evidence.
    expect(toLicenseStatus(r.status)).toBe('unverified');
    // The refusal is recorded in the evidence, so an administrator can see WHY there is no lookup.
    expect(r.evidence.refused).toMatch(/not permitted in production/i);
  });

  test('RAILWAY_ENVIRONMENT alone is enough — Railway does not set NODE_ENV', async () => {
    delete process.env.NODE_ENV;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect((await getVerifier().verify({ license_number: '10' })).status).toBe('unavailable');
  });

  test('outside production the stub still answers deterministically, so every other suite holds', async () => {
    process.env.NODE_ENV = 'test';
    expect((await getVerifier().verify({ license_number: '10' })).status).toBe('verified');
  });

  test('the boot check refuses the stub and says why', () => {
    const { adapterUnfitForProduction } = require('../src/services/license-verifier');
    // ADAPTER is read once at import, and this suite loads with it unset, i.e. 'stub'.
    expect(adapterUnfitForProduction()).toMatch(/last digit/);
  });

  // 'manual' is the only value production can actually be set to right now: no scraper service is
  // deployed and LICENSE_VERIFIER_URL is unset everywhere, so 'tmc_scrape' would time out on every
  // submission. Without this value the boot guard would have had no permitted setting to offer and
  // would simply have made the service unbootable.
  test("'manual' is fit for production, and returns unavailable with its own source", async () => {
    jest.resetModules();
    process.env.LICENSE_VERIFIER_ADAPTER = 'manual';
    const lv = require('../src/services/license-verifier');
    try {
      expect(lv.adapterUnfitForProduction()).toBeNull();
      const r = await lv.getVerifier().verify({ license_number: '10' });
      expect(r.status).toBe('unavailable');
      // 'manual' not 'stub' and not 'none': a deliberate policy has to be distinguishable on the
      // admin card from a guard that fired.
      expect(r.source).toBe('manual');
      expect(lv.toLicenseStatus(r.status)).toBe('unverified');
    } finally {
      delete process.env.LICENSE_VERIFIER_ADAPTER;
      jest.resetModules();
    }
  });

  test("'tmc_scrape' without LICENSE_VERIFIER_URL is refused — it would time out on every lookup", () => {
    jest.resetModules();
    process.env.LICENSE_VERIFIER_ADAPTER = 'tmc_scrape';
    delete process.env.LICENSE_VERIFIER_URL;
    try {
      expect(require('../src/services/license-verifier').adapterUnfitForProduction()).toMatch(/LICENSE_VERIFIER_URL is unset/);
    } finally { delete process.env.LICENSE_VERIFIER_ADAPTER; jest.resetModules(); }
  });

  test('an unrecognised value is refused, because an unknown adapter falls back to the stub', () => {
    jest.resetModules();
    process.env.LICENSE_VERIFIER_ADAPTER = 'tmc-scrape'; // hyphen, not underscore
    try {
      expect(require('../src/services/license-verifier').adapterUnfitForProduction()).toMatch(/not a known adapter/);
    } finally { delete process.env.LICENSE_VERIFIER_ADAPTER; jest.resetModules(); }
  });
});
