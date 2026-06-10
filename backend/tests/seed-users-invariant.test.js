// Guards the seed config. The council assertion is load-bearing (prof_council_required is still
// active). The auditor license_status assertion is now a REVERSIBILITY guard: the
// enforce_auditor_license trigger was retired 2026-06-09 (license columns kept dormant), but
// seed-users.js still seeds the auditor 'manual_verified' so that IF the dormant gate is ever
// restored, the seed stays trigger-safe.
//
// We assert against the seed SOURCE (not by importing it): seed-users.js connects to Supabase and
// self-executes on require, and resolving its deps (dotenv/@supabase) from the test context is not
// guaranteed — a text assertion is robust and dependency-free.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'seed-users.js'), 'utf8');

describe('seed-users.js seed-config invariants', () => {
  test('demo auditor is seeded with a verified-class license_status (trigger-safe)', () => {
    const auditorLine = SRC.split('\n').find((l) => /role:\s*'auditor'/.test(l));
    expect(auditorLine).toBeDefined();
    // enforce_auditor_license only permits an ACTIVE auditor whose license is 'verified' or 'manual_verified'.
    expect(auditorLine).toMatch(/license_status:\s*'(verified|manual_verified)'/);
  });

  test('every non-superadmin seed account carries a council (prof_council_required)', () => {
    // Scope to USER account lines (they carry `email:`) so the SLOTS pool definitions,
    // which also have a `role:` key but no council, are not matched.
    const roleLines = SRC.split('\n').filter(
      (l) => /email:/.test(l) && /role:\s*'(admin|physician|auditor)'/.test(l)
    );
    expect(roleLines.length).toBeGreaterThanOrEqual(3); // admin + physician + auditor demo accounts
    for (const line of roleLines) {
      expect(line).toMatch(/council:/); // resolved to council_id before upsert
    }
  });
});
