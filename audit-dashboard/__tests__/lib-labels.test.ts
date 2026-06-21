// Unit tests for lib/labels.ts — the single source of truth for status/role labels, the PIS-7
// weighting, the composite math, the budget-meter thresholds and the case categoriser. These power
// every status badge + the ICC dashboard, so a drift here silently mis-labels CLEs or mis-scores ICC.
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
  cleStatusCards,
  budgetToneHex,
  computeComposite,
  caseCategory,
  POSITION_OPTIONS,
  POSITION_TH,
  positionLabel,
} from '@/lib/labels';
import { CHART } from '@/lib/chart-colors';

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
  it('STATUS_MAP covers every CLE lifecycle status', () => {
    for (const k of ['active', 'ended', 'cle_pass', 'cle_fail_t1', 'cle_flag_t2', 'evaluated']) {
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

describe('cleStatusCards', () => {
  it('returns 5 cards whose buckets reconcile to the total', () => {
    const stats = {
      total: 30,
      evaluated: 10,
      cle_flag_t2: 4,
      cle_fail_t1: 6,
      active: 5,
      ended: 3,
      cle_pass: 2,
    };
    const cards = cleStatusCards(stats);
    expect(cards).toHaveLength(5);
    const by = Object.fromEntries(cards.map((c) => [c.key, c.value]));
    // Evaluated + Awaiting QA + Did-not-pass + In-progress === Total
    expect(by.evaluated + by.cle_flag_t2 + by.cle_fail_t1 + by.in_progress).toBe(by['']);
    // in_progress folds active + ended + cle_pass
    expect(by.in_progress).toBe(5 + 3 + 2);
  });
  it('defaults everything to 0 for null/empty stats', () => {
    for (const c of cleStatusCards(null)) expect(c.value).toBe(0);
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
