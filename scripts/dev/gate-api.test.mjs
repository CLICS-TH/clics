// The browser gates against the one-origin dashboard build (#429, #488 review). Package-free:
// `node --test scripts/dev/*.test.mjs` (CI's deploy-vm1 job runs this glob).
//
// Since #429 a dashboard built the default way (NEXT_PUBLIC_API_URL unset, basePath /audit) calls the relative
// /api on its own origin. The readability gate and the wide-nav audit answered only http://localhost:3001, so
// against that build every fixture was skipped and the dashboard pages rendered their error or empty states;
// and the readability gate had no /admin/booth fixture, so the superadmin overview fell into its error
// boundary. These checks need no browser: they read the matcher both scripts use, the scripts' own source, and
// the fixture the overview's BoothCard reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateApiBases, isGateApiCall } from '../lib/gate-api.mjs';
import { fixtureFor, FALLBACK } from '../readability/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const DASH = 'http://127.0.0.1:3002/audit';

test('the gates answer the default build\'s same-origin /api, :3001, and nothing else', () => {
  const bases = gateApiBases({ dashUrl: DASH });
  for (const u of ['http://127.0.0.1:3002/api/admin/booth', 'http://127.0.0.1:3002/api/auth/me',
    'http://localhost:3001/admin/booth', 'http://127.0.0.1:3001/auth/me']) assert.ok(isGateApiCall(u, bases), u);
  for (const u of ['http://127.0.0.1:3002/audit/admin/overview', 'http://127.0.0.1:3002/audit/_next/static/x.js',
    'http://127.0.0.1:3002/apix', 'http://localhost:30010/x', 'https://clics.ccme.or.th/api/auth/me'])
    assert.ok(!isGateApiCall(u, bases), u);
  // A build made with NEXT_PUBLIC_API_URL set: relative resolves against DASH_URL, absolute stands.
  assert.ok(isGateApiCall('http://127.0.0.1:3002/backend/x', gateApiBases({ dashUrl: DASH, apiUrl: '/backend' })));
  assert.ok(isGateApiCall('http://10.0.0.9:4000/x', gateApiBases({ dashUrl: DASH, apiUrl: 'http://10.0.0.9:4000/' })));
});

test('readability/audit.mjs and responsive/nav-width-audit.mjs route backend calls through that matcher', () => {
  for (const [file, dashVar] of [['scripts/readability/audit.mjs', 'dashUrl'], ['scripts/responsive/nav-width-audit.mjs', 'DASH']]) {
    const src = read(file);
    assert.match(src, /import \{ gateApiBases, isGateApiCall \} from '\.\.\/lib\/gate-api\.mjs';/, `${file} imports the matcher`);
    assert.match(src, new RegExp(`gateApiBases\\(\\{ dashUrl${dashVar === 'dashUrl' ? '(: dashUrl)?' : `: ${dashVar}`}, apiUrl: process\\.env\\.NEXT_PUBLIC_API_URL \\}\\)`),
      `${file} builds its bases from DASH_URL and NEXT_PUBLIC_API_URL`);
    assert.match(src, /if \(isGateApiCall\((u|url), API(_BASES)?\)\) \{/, `${file} fulfils what the matcher accepts`);
    assert.doesNotMatch(src, /startsWith\((API_BASE|b)\)|['"]http:\/\/localhost:3001['"]\s*[\],;]/,
      `${file} has no second, :3001-only matcher`);
    assert.match(src, /NEXT_PUBLIC_API_URL unset/, `${file}'s header names the build it measures`);
  }
});

test('the readability fixtures answer the overview\'s /admin/booth with a BoothSettings, on either API base', () => {
  for (const u of ['http://127.0.0.1:3002/api/admin/booth', 'http://localhost:3001/admin/booth']) {
    const b = fixtureFor(u);
    assert.notEqual(b, FALLBACK, `${u} has its own fixture`);
    assert.equal(typeof b.enabled, 'boolean');
    assert.ok(['open', 'off', 'not_yet', 'ended', 'misconfigured'].includes(b.state), 'state is a BoothState');
    assert.ok(Array.isArray(b.cases) && b.cases.length > 0, 'cases is a non-empty BoothCase[] (the card reads .length)');
    for (const c of b.cases) {
      assert.equal(typeof c.case_id, 'string');
      assert.equal(typeof c.teaser?.th, 'string');
      assert.equal(typeof c.on, 'boolean');
    }
    assert.ok(b.audits === null || typeof b.audits.audits === 'number');
  }
  // The overview-counts entry is not shadowed by the new one.
  assert.ok(Array.isArray(fixtureFor('http://127.0.0.1:3002/api/admin/overview-counts')));
});
