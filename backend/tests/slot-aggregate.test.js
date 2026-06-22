// Role-slot aggregation in src/lib/accounts.js (2026-06-22). The global admin/auditor "capacity" is
// now the SUM of every council's per-council pool (council_slots, with a DEFAULT_CAPACITY fallback) —
// NOT the dead role_slots row — so the superadmin card reads e.g. 16/36 instead of the old, scope-mixed
// 16/5. allCouncilsSlotUsage() drives the new "active per council" breakdown table. Table-aware mock:
// professionals count queries resolve from a fixture; role_slots/council_slots/councils too.

jest.mock('../src/lib/supabase', () => {
  const councils = [
    { id: 'c-tmc', code: 'TMC', name_th: 'แพทยสภา', name_en: 'Medical Council' },
    { id: 'c-pharm', code: 'PHARM', name_th: 'สภาเภสัชกรรม', name_en: 'Pharmacy Council' },
  ];
  // PHARM has NO admin row → admin capacity falls back to DEFAULT_CAPACITY.admin (5).
  const councilSlots = [
    { council_id: 'c-tmc', role: 'admin', capacity: 21 },
    { council_id: 'c-tmc', role: 'auditor', capacity: 20 },
    { council_id: 'c-pharm', role: 'auditor', capacity: 20 },
  ];
  const roleSlots = [
    { role: 'superadmin', capacity: 1 }, { role: 'admin', capacity: 5 },
    { role: 'physician', capacity: 100 }, { role: 'auditor', capacity: 20 },
  ];
  // 16 admins (all TMC) + 6 auditors (5 TMC, 1 PHARM), all active. A deactivated admin must NOT count.
  const professionals = [
    ...Array.from({ length: 16 }, (_, i) => ({ id: `a${i}`, role: 'admin', status: 'active', council_id: 'c-tmc' })),
    { id: 'a-off', role: 'admin', status: 'deactivated', council_id: 'c-tmc' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, role: 'auditor', status: 'active', council_id: 'c-tmc' })),
    { id: 'u-pharm', role: 'auditor', status: 'active', council_id: 'c-pharm' },
  ];

  function builder(table) {
    const q = { table, filters: {}, count: false };
    q.select = (_cols, opts) => { if (opts && opts.count) q.count = true; return q; };
    q.eq = (col, val) => { q.filters[col] = val; return q; };
    q.order = () => q;
    const single = () => {
      if (table === 'role_slots') {
        const row = roleSlots.find(r => r.role === q.filters.role);
        return Promise.resolve({ data: row ? { capacity: row.capacity } : null, error: null });
      }
      if (table === 'council_slots') {
        const row = councilSlots.find(r => r.council_id === q.filters.council_id && r.role === q.filters.role);
        return Promise.resolve({ data: row ? { capacity: row.capacity } : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    q.single = single;
    q.maybeSingle = single;
    q.then = (resolve, reject) => {
      let value;
      if (table === 'professionals' && q.count) {
        const n = professionals.filter(p => Object.entries(q.filters).every(([k, v]) => p[k] === v)).length;
        value = { count: n, data: null, error: null };
      } else if (table === 'councils') {
        value = { data: councils, error: null };
      } else {
        value = { data: [], error: null };
      }
      return Promise.resolve(value).then(resolve, reject);
    };
    return q;
  }
  return { supabase: { from: builder } };
});

const accounts = require('../src/lib/accounts');

describe('slotUsage — admin/auditor capacity is the SUM of per-council pools', () => {
  test('admin: capacity = TMC 21 + PHARM default 5 = 26; used = 16 active (deactivated excluded)', async () => {
    expect(await accounts.slotUsage('admin')).toEqual({ role: 'admin', capacity: 26, used: 16, remaining: 10 });
  });

  test('auditor: capacity = TMC 20 + PHARM 20 = 40; used = 6 (5 TMC + 1 PHARM)', async () => {
    expect(await accounts.slotUsage('auditor')).toEqual({ role: 'auditor', capacity: 40, used: 6, remaining: 34 });
  });

  test('superadmin still uses the global role_slots row (capacity 1), not per-council', async () => {
    expect((await accounts.slotUsage('superadmin')).capacity).toBe(1);
  });

  test('physician still uses the global role_slots row (capacity 100)', async () => {
    expect((await accounts.slotUsage('physician')).capacity).toBe(100);
  });
});

describe('allCouncilsSlotUsage — per-council active breakdown', () => {
  test('one entry per council with admin+auditor used/capacity (PHARM admin uses the default 5)', async () => {
    const rows = await accounts.allCouncilsSlotUsage();
    expect(rows).toHaveLength(2);
    const tmc = rows.find(r => r.code === 'TMC');
    const pharm = rows.find(r => r.code === 'PHARM');
    const adminOf = (r) => r.slots.find(s => s.role === 'admin');
    const auditorOf = (r) => r.slots.find(s => s.role === 'auditor');

    expect(tmc).toMatchObject({ council_id: 'c-tmc', name_th: 'แพทยสภา' });
    expect(adminOf(tmc)).toMatchObject({ used: 16, capacity: 21, remaining: 5 });
    expect(auditorOf(tmc)).toMatchObject({ used: 5, capacity: 20, remaining: 15 });
    expect(adminOf(pharm)).toMatchObject({ used: 0, capacity: 5, remaining: 5 });   // default fallback
    expect(auditorOf(pharm)).toMatchObject({ used: 1, capacity: 20, remaining: 19 });
  });
});
