// Fresh E2E onboarding (after db/reset-demo.js). Superadmin creates the manager admin + 3 auditors;
// 6 physicians self-register; the admin approves them -> P-001..P-006. Matches LOGIN-ACCOUNTS.txt creds.
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/e2e-onboard.js
const fs = require('fs');
const BASE = 'https://backend-production-c12e4.up.railway.app';
const SOAK = 'SoakPass#2026';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j };
}
const login = (e, p) => api('POST', '/auth/login', { body: { email: e, password: p } });

const PHYS = [
  { n: '01', tier: 'weak',    th: 'นพ. สมหวัง น้อยเรียน', en: 'Dr Somwang (novice)' },
  { n: '02', tier: 'average', th: 'นพ. ธีรพงษ์ พอใช้',    en: 'Dr Theerapong (average)' },
  { n: '03', tier: 'good',    th: 'พญ. ปรียา เชี่ยวชาญ',  en: 'Dr Preeya (good)' },
  { n: '04', tier: 'good',    th: 'นพ. อนุชา รอบคอบ',     en: 'Dr Anucha (good)' },
  { n: '05', tier: 'top',     th: 'นพ. ก้องภพ ยอดเยี่ยม', en: 'Dr Kongphop (top)' },
  { n: '06', tier: 'top',     th: 'พญ. นภัสสร เป็นเลิศ',  en: 'Dr Napatsorn (top)' },
];

(async () => {
  const sa = (await login('superadmin@clics.th', 'ClicsSuper#2026r2')).body?.access_token;
  if (!sa) throw new Error('superadmin login failed');
  console.log('superadmin in.');

  // Everyone joins the Medical Council in this E2E cohort.
  const TMC = ((await api('GET', '/admin/councils', { token: sa })).body || []).find(c => c.code === 'TMC')?.id;
  if (!TMC) throw new Error('Medical Council (TMC) not found — run db/migration-councils.sql');

  // manager admin + 3 auditors (the "invite")
  console.log('  create admin@clics.th:', (await api('POST', '/admin/users', { token: sa, body: { email: 'admin@clics.th', password: 'ClicsAdmin#2026r2', role: 'admin', council_id: TMC, full_name_th: 'ผู้ดูแลระบบ', full_name_en: 'Pilot Admin' } })).status);
  for (const n of [1, 2, 3]) {
    const r = await api('POST', '/admin/users', { token: sa, body: { email: `soakaud${n}@example.com`, password: SOAK, role: 'auditor', council_id: TMC, full_name_th: `ผู้ตรวจ ${n}`, full_name_en: `Auditor ${n}` } });
    console.log(`  create auditor ${n}:`, r.status);
  }

  // 6 physicians self-register
  for (const p of PHYS) {
    const r = await api('POST', '/auth/request-access', { body: { email: `soakdoc${p.n}@example.com`, password: SOAK, council_id: TMC, full_name_th: p.th, full_name_en: p.en, specialty: 'Internal Medicine' } });
    console.log(`  request-access soakdoc${p.n} (${p.tier}):`, r.status);
  }

  // admin approves all pending -> physician
  const ad = (await login('admin@clics.th', 'ClicsAdmin#2026r2')).body.access_token;
  const pending = (await api('GET', '/admin/access-requests', { token: ad })).body || [];
  const physicians = [];
  for (const req of pending) {
    const r = await api('POST', `/admin/access-requests/${req.id}/approve`, { token: ad, body: { granted_role: 'physician' } });
    const tier = PHYS.find(t => req.email === `soakdoc${t.n}@example.com`)?.tier ?? 'average';
    physicians.push({ email: req.email, password: SOAK, tier, professional_id: r.body?.professional_id, pseudonym: r.body?.pseudonym });
    console.log(`  approve ${req.email}: ${r.status} ${r.body?.pseudonym ?? r.body?.error ?? ''}`);
  }
  fs.writeFileSync('/tmp/e2e-personas.json', JSON.stringify({ physicians }, null, 2));
  console.log(`\nOnboarded ${physicians.length} physicians, 3 auditors, 1 admin. Tiers: ${physicians.map(p => p.tier).join(', ')}`);
  process.exit(physicians.length === 6 ? 0 : 1);
})().catch(e => { console.error('ONBOARD FAILED:', e.message); process.exit(1); });
