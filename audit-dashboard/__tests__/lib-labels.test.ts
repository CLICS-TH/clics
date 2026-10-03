// Unit tests for lib/labels.ts — the single source of truth for status/role labels, the PIS-7
// weighting, the composite math, the budget-meter thresholds and the case categoriser. These power
// every status badge + the ICC dashboard, so a drift here silently mis-labels PLEs or mis-scores ICC.
import {
  STATUS_MAP,
  ROLE_LABELS,
  ACCOUNT_STATUS_MAP,
  INVITE_STATUS_MAP,
  WEIGHTS,
  DOMAIN_KEYS,
  DOMAIN_LABELS,
  roleToWire,
  roleToUi,
  pleStatusCards,
  budgetToneHex,
  computeComposite,
  caseCategory,
  POSITION_OPTIONS,
  POSITION_TH,
  positionLabel,
  fmtTokens,
  fmtTokensK,
} from '@/lib/labels';
import { CHART_LIGHT as CHART } from '@/lib/chart-colors';

describe('PIS-7 weights', () => {
  it('sum to exactly 1.0', () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('cover d1..d7 and align positionally with DOMAIN_KEYS/LABELS', () => {
    expect(Object.keys(WEIGHTS).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    expect(DOMAIN_KEYS).toHaveLength(7);
    expect(DOMAIN_LABELS).toHaveLength(7);
  });
});

describe('computeComposite (0–5 domains → 0–100)', () => {
  const all = (n: number) => Object.fromEntries(DOMAIN_KEYS.map((k) => [k, n]));

  it('all-5 → 100 (the ceiling)', () => {
    expect(computeComposite(all(5))).toBeCloseTo(100, 10);
  });
  it('all-3 → 60', () => {
    expect(computeComposite(all(3))).toBeCloseTo(60, 10);
  });
  it('all-0 → 0', () => {
    expect(computeComposite(all(0))).toBe(0);
  });
  it('treats a missing domain as 0, not NaN', () => {
    expect(computeComposite({ d1: 5 })).toBeCloseTo(5 * 0.15 * 20, 10);
  });
});

describe('budgetToneHex thresholds (amber ≥75%, red ≥90%)', () => {
  it('pass below 75%', () => {
    expect(budgetToneHex(0)).toBe(CHART.pass);
    expect(budgetToneHex(0.749)).toBe(CHART.pass);
  });
  it('warn at the 75% boundary up to <90%', () => {
    expect(budgetToneHex(0.75)).toBe(CHART.warn);
    expect(budgetToneHex(0.899)).toBe(CHART.warn);
  });
  it('fail at the 90% boundary and above', () => {
    expect(budgetToneHex(0.9)).toBe(CHART.fail);
    expect(budgetToneHex(1.5)).toBe(CHART.fail);
  });
});

describe('fmtTokens / fmtTokensK (token ceilings and meters)', () => {
  it('fmtTokens writes the settings figure with thousands separators', () => {
    expect(fmtTokens(300000)).toBe('300,000');
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(50_000_000)).toBe('50,000,000');
    expect(fmtTokens(1234.6)).toBe('1,235');
  });
  it('fmtTokensK writes the meter figure in whole k, keeping sub-1000 counts plain', () => {
    expect(fmtTokensK(184_321)).toBe('184k');
    expect(fmtTokensK(300_000)).toBe('300k');
    expect(fmtTokensK(1_500)).toBe('2k');
    expect(fmtTokensK(999)).toBe('999');
    expect(fmtTokensK(0)).toBe('0');
    expect(fmtTokensK(50_000_000)).toBe('50,000k');
  });
  it('both render an absent or non-numeric value as "—" — the caller decides what absence means', () => {
    for (const v of [null, undefined, NaN, Infinity]) {
      expect(fmtTokens(v)).toBe('—');
      expect(fmtTokensK(v)).toBe('—');
    }
  });
});

describe('roleToWire / roleToUi (the can_audit virtual-role encoding)', () => {
  it('special ⇒ physician + can_audit:true', () => {
    expect(roleToWire('special')).toEqual({ role: 'physician', can_audit: true });
  });
  it('plain roles ⇒ can_audit:false', () => {
    expect(roleToWire('auditor')).toEqual({ role: 'auditor', can_audit: false });
    expect(roleToWire('admin')).toEqual({ role: 'admin', can_audit: false });
    expect(roleToWire('physician')).toEqual({ role: 'physician', can_audit: false });
  });
  it('round-trips special through wire and back', () => {
    const { role, can_audit } = roleToWire('special');
    expect(roleToUi(role, can_audit)).toBe('special');
  });
  it('a physician without can_audit stays physician', () => {
    expect(roleToUi('physician', false)).toBe('physician');
    expect(roleToUi('physician', null)).toBe('physician');
  });
  it('a pure auditor never becomes special', () => {
    expect(roleToUi('auditor', false)).toBe('auditor');
  });
});

describe('label maps', () => {
  it('STATUS_MAP covers every PLE lifecycle status', () => {
    for (const k of ['active', 'ended', 'ple_pass', 'ple_fail_t1', 'ple_flag_t2', 'evaluated']) {
      expect(STATUS_MAP[k]).toBeTruthy();
    }
  });
  it('ROLE_LABELS / ACCOUNT_STATUS_MAP / INVITE_STATUS_MAP have their keys', () => {
    expect(Object.keys(ROLE_LABELS)).toEqual(
      expect.arrayContaining(['superadmin', 'admin', 'physician', 'auditor'])
    );
    expect(Object.keys(ACCOUNT_STATUS_MAP)).toEqual(['active', 'deactivated']);
    expect(Object.keys(INVITE_STATUS_MAP)).toEqual(['pending', 'accepted', 'revoked', 'expired']);
  });
});

describe('position ladder (ตำแหน่ง)', () => {
  it('POSITION_OPTIONS + POSITION_TH cover the same six rungs (gp = General Practitioner)', () => {
    const keys = POSITION_OPTIONS.map((p) => p.key);
    expect(keys).toEqual(['extern', 'intern', 'resident', 'fellowship', 'staff', 'gp']);
    expect(Object.keys(POSITION_TH).sort()).toEqual([...keys].sort());
    expect(POSITION_OPTIONS.find((p) => p.key === 'gp')?.label).toMatch(/General Practitioner/);
    // "Fellowship" was relabeled to "Fellow" (the DB value stays 'fellowship').
    expect(POSITION_OPTIONS.find((p) => p.key === 'fellowship')?.label).toMatch(/Fellow(?!ship)/);
  });
  it('positionLabel resolves a known key and falls back to null', () => {
    expect(positionLabel('resident')).toBe(
      POSITION_OPTIONS.find((p) => p.key === 'resident')?.label
    );
    expect(positionLabel('nope')).toBeNull();
    expect(positionLabel(null)).toBeNull();
    expect(positionLabel(undefined)).toBeNull();
  });
});

describe('pleStatusCards', () => {
  it('returns 5 cards whose buckets reconcile to the total', () => {
    const stats = {
      total: 30,
      evaluated: 10,
      ple_flag_t2: 4,
      ple_fail_t1: 6,
      active: 5,
      ended: 3,
      ple_pass: 2,
    };
    const cards = pleStatusCards(stats);
    expect(cards).toHaveLength(5);
    const by = Object.fromEntries(cards.map((c) => [c.key, c.value]));
    // Evaluated + Awaiting QA + Did-not-pass + In-progress === Total
    expect(by.evaluated + by.ple_flag_t2 + by.ple_fail_t1 + by.in_progress).toBe(by['']);
    // in_progress folds active + ended + ple_pass
    expect(by.in_progress).toBe(5 + 3 + 2);
  });
  it('defaults everything to 0 for null/empty stats', () => {
    for (const c of pleStatusCards(null)) expect(c.value).toBe(0);
  });
});

describe('caseCategory', () => {
  it('maps common complaints (English + Thai)', () => {
    expect(caseCategory('substernal chest pain')).toMatch(/Chest pain/);
    expect(caseCategory('SOB on exertion')).toMatch(/Dyspnea/);
    expect(caseCategory('fever and cough')).toMatch(/Fever/);
    expect(caseCategory('ปวดท้อง RLQ')).toMatch(/Abdominal/);
    expect(caseCategory('thunderclap headache')).toMatch(/Headache/);
  });
  it('falls back to Other for anything unmatched / empty', () => {
    expect(caseCategory('rash on arm')).toMatch(/Other/);
    expect(caseCategory(null)).toMatch(/Other/);
  });
});

// The per-assessment confirmations the auditor form requires before it will submit.
//
// These keys are a MIRROR of backend/src/lib/schemas.js SCORE_ATTESTATIONS, and the route rejects a
// submission missing any of them. A key that drifts here produces a form the rater can complete and
// the server will refuse — with no clue on either side about which one is wrong.
import { ATTESTATIONS } from '@/lib/pis7-rubric';

describe('ATTESTATIONS', () => {
  it('matches the set the API enforces, exactly and in order', () => {
    expect(ATTESTATIONS.map((a) => a.key)).toEqual([
      'all_domains_scored',
      'comments_recorded',
      'scored_independently',
      'no_identifiers_found',
      'weights_provisional',
    ]);
  });

  it('gives every item both languages — a rater who reads only Thai must not get a blank', () => {
    for (const a of ATTESTATIONS) {
      expect(a.th.trim().length).toBeGreaterThan(0);
      expect(a.en.trim().length).toBeGreaterThan(0);
    }
  });
});
