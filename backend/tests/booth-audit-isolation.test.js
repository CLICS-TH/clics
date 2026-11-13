jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { AUDITOR, SUPERADMIN } = require('./helpers/roles');
const app = require('../src/index');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function filesUnder(rel, pattern) {
  return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = path.posix.join(rel, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : filesUnder(child, pattern);
    return pattern.test(e.name) ? [child] : [];
  });
}

const CODE = /\.(?:js|mjs|cjs|ts)$/;
const SERVICE = 'backend/src/services/booth-audits.js';
const MIGRATION = 'db/migration-booth-audits.sql';

describe('the source', () => {
  const scanned = [
    ...filesUnder('backend/src', CODE), ...filesUnder('scripts', CODE), ...filesUnder('rimpl/src', CODE),
    ...filesUnder('db', /\.sql$/),
  ];

  test('only the booth audits service and its migration name booth_audits', () => {
    expect(scanned).toContain('scripts/calibration/calibrate.js');
    expect(scanned).toContain('rimpl/src/lib/prompts.js');
    expect(scanned.filter((f) => read(f).includes('booth_audits')).sort()).toEqual([SERVICE, MIGRATION]);
  });

  test('the booth audits service reaches only the two booth tables, and calls no database function', () => {
    const src = read(SERVICE);
    const tables = [...src.matchAll(/\.from\('([a-z_]+)'\)/g)].map(([, t]) => t);
    expect(tables).toHaveLength([...src.matchAll(/\.from\(/g)].length);
    expect([...new Set(tables)].sort()).toEqual(['booth_audits', 'booth_plays']);
    expect(src).not.toMatch(/\.rpc\(/);
  });

  test('the pilot ICC, payout, compensation, export and calibration code names nothing of the booth', () => {
    const services = fs.readdirSync(path.join(ROOT, 'backend/src/services')).filter((f) => /^(?:icc|kappa|agreement|rater-spread).*\.js$/.test(f));
    const pilot = [
      'backend/src/routes/auditor.js', 'backend/src/routes/admin.js', 'backend/src/routes/oversight.js',
      'backend/src/lib/compensation.js', ...services.map((f) => `backend/src/services/${f}`),
      ...filesUnder('scripts/calibration', CODE),
    ];
    expect(pilot).toEqual(expect.arrayContaining(['backend/src/services/icc.js', 'backend/src/services/agreement.js',
      'backend/src/services/rater-spread.js', 'scripts/calibration/three-way.js']));
    expect(pilot.filter((f) => /booth_|booth-audits|boothAudits/.test(read(f)))).toEqual([]);
  });
});

describe('the running app', () => {
  const COUNCIL = 'C1';
  const PLE = (id, physician, status) => ({
    id, ple_code: `PLE-${id}`, physician_id: physician, council_id: COUNCIL, specialty_id: null, episode_number: 1,
    socratic_active: false, socratic_reason: null, status, is_test: false, turn_count: 6, token_count: 1200,
    duration_seconds: 900, started_at: `2026-01-0${id.slice(1)}T00:00:00Z`,
  });
  const SCORE = (ple, auditor, d, composite) => ({
    ple_id: ple, auditor_id: auditor, council_id: COUNCIL, composite_score: composite, scored_at: '2026-01-10T00:00:00Z',
    notes: 'DDx narrowed late', d1_anchor: 'clear', attestations: { all_domains_scored: true },
    ...Object.fromEntries(d.map((v, i) => [`d${i + 1}`, v])),
  });
  const AI = (ple, d, composite) => ({
    ple_id: ple, composite_score: composite, model_version: 'claude-x', prompt_version: 'p1', rubric_version: 'r1',
    provenance: null, evaluated_at: '2026-01-09T00:00:00Z', ...Object.fromEntries(d.map((v, i) => [`d${i + 1}`, v])),
  });
  const PILOT = {
    ples: [PLE('p1', 'phys-1', 'ple_pass'), PLE('p2', 'phys-1', 'evaluated'), PLE('p3', 'phys-2', 'ple_pass'), PLE('p4', 'phys-2', 'evaluated')],
    audit_scores: [
      SCORE('p1', AUDITOR.id, [3, 3, 4, 3, 3, 4, 3], 66), SCORE('p1', 'aud-2', [4, 3, 4, 3, 3, 4, 4], 71),
      SCORE('p2', AUDITOR.id, [2, 2, 3, 2, 2, 3, 2], 45), SCORE('p2', 'aud-2', [2, 3, 3, 2, 2, 2, 2], 47),
      SCORE('p3', AUDITOR.id, [5, 4, 4, 5, 4, 4, 5], 88), SCORE('p4', 'aud-2', [3, 4, 3, 3, 4, 3, 3], 67),
    ],
    ai_evaluations: [
      AI('p1', [3, 4, 4, 3, 3, 4, 3], 68), AI('p2', [2, 2, 2, 3, 2, 3, 2], 46), AI('p3', [4, 4, 5, 5, 4, 4, 4], 86),
      AI('p4', [3, 3, 3, 4, 4, 3, 3], 66),
    ],
    professionals: [
      { id: 'phys-1', pseudonym: 'P-001', full_name_th: 'หมอ ก', role: 'physician', council_id: COUNCIL },
      { id: 'phys-2', pseudonym: 'P-002', full_name_th: 'หมอ ข', role: 'physician', council_id: COUNCIL },
      { id: AUDITOR.id, exp_code: 'EXP-001', role: 'auditor', council_id: COUNCIL },
      { id: 'aud-2', exp_code: 'EXP-002', role: 'auditor', council_id: COUNCIL },
    ],
    payouts: [{ physician_id: 'phys-1', amount_thb: 500 }],
    councils: [{ id: COUNCIL, code: 'TMC', name_th: 'แพทยสภา', name_en: 'Medical Council' }],
  };
  const BOOTH = {
    booth_plays: [
      { id: 'b0000000-0000-4000-8000-000000000001', event_code: 'NFCME-2026', status: 'scored', composite: 61.5, d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 },
      { id: 'b0000000-0000-4000-8000-000000000002', event_code: 'NFCME-2026', status: 'scored', composite: 82, d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4 },
    ],
    booth_audits: [
      { play_id: 'b0000000-0000-4000-8000-000000000001', auditor_id: AUDITOR.id, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, created_at: '2026-11-21T08:00:00Z' },
      { play_id: 'b0000000-0000-4000-8000-000000000002', auditor_id: 'aud-2', d1: 5, d2: 5, d3: 5, d4: 5, d5: 5, d6: 5, d7: 5, created_at: '2026-11-21T09:00:00Z' },
    ],
  };
  const SETTINGS = { min_auditors_per_cle: 1, peer_calibration: 1 };

  const matches = (row, ctx) => ctx.eqs.every(([c, v]) => row[c] === v) && ctx.neqs.every(([c, v]) => row[c] !== v)
    && ctx.ins.every(([c, vals]) => vals.includes(row[c]));
  const resolver = (tables) => (table, kind, ctx) => {
    if (table === 'app_settings') return kind === 'list' ? [] : (ctx.id('key') in SETTINGS ? { value: SETTINGS[ctx.id('key')] } : null);
    if (kind !== 'list') return undefined;
    const rows = (tables[table] ?? []).filter((r) => matches(r, ctx));
    return table === 'ples' ? { data: rows, count: rows.length } : rows;
  };

  const binary = (r) => r.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  async function sheets(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb.worksheets.map((ws) => ({ name: ws.name, rows: JSON.parse(JSON.stringify(ws.getSheetValues())) }));
  }

  const CONSUMERS = [
    ['the auditor ICC', AUDITOR, '/auditor/icc', (b) => b.n > 0],
    ['the auditor calibration radar', AUDITOR, '/auditor/calibration', (b) => b.n > 0 && b.peer !== null],
    ['the superadmin ICC', SUPERADMIN, '/admin/icc', (b) => b.n > 0],
    ['the superadmin payouts', SUPERADMIN, '/admin/payouts', (b) => b.recipients.length === 2],
    ['the payout file', SUPERADMIN, '/admin/payouts/export', (b) => b.includes('P-001')],
    ['the admin compensation report', SUPERADMIN, '/admin/compensation', (b) => b.total_thb > 0],
    ['the JSON export', SUPERADMIN, '/admin/export', (b) => b.sessions.some((s) => s.auditor_scores.length > 0)],
    ['the XLSX export', SUPERADMIN, '/admin/export.xlsx', (b) => b.find((s) => s.name === 'Auditor scores').rows.length > 2],
  ];

  let rpcs;
  const realRpc = supabase.rpc;
  beforeAll(() => { supabase.rpc = (name, args) => { rpcs.push(name); return realRpc(name, args); }; });
  afterAll(() => { supabase.rpc = realRpc; });

  async function drive(caller, route, tables) {
    m.reset();
    rpcs = [];
    m.state.caller = caller;
    m.state.resolve = resolver(tables);
    const req = request(app).get(route).set('Authorization', 'Bearer t');
    const res = route.endsWith('.xlsx') ? await binary(req) : await req;
    let body = res.body;
    if (route.endsWith('.xlsx')) body = await sheets(res.body);
    else if (res.type === 'text/csv') body = res.text;
    else if (route === '/admin/export') { const { exported_at: _clock, ...rest } = body; body = rest; }
    const booth = [...m.state.queries.map((q) => q.table), ...rpcs].filter((name) => /booth/.test(name));
    return { status: res.status, body, booth };
  }

  test.each(CONSUMERS)('%s reads no booth table and answers the same with booth audits in the database',
    async (_name, caller, route, computed) => {
      const without = await drive(caller, route, PILOT);
      const withBooth = await drive(caller, route, { ...PILOT, ...BOOTH });
      expect(without.status).toBe(200);
      expect(computed(without.body)).toBe(true);
      expect(withBooth.booth).toEqual([]);
      expect(without.booth).toEqual([]);
      expect(withBooth.body).toEqual(without.body);
    });
});
