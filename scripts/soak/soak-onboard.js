// Onboard the 16 soak personas via the REAL API flows (traceable history):
//  - superadmin direct-creates 2 admins + 3 auditors + 10 physicians via POST /admin/users
// Onboarding now mirrors production (direct-create + invites): /auth/request-access was
// retired (404s), so physicians can no longer self-register and there is no approval queue.
// Writes /tmp/soak-personas.json with creds + tiers + ids for the soak workflow.
const fs = require('fs');
// SOAK_BASE/SOAK_COUNCIL let the soak run against a non-prod stack (e.g. local backend + scaletest DB).
const BASE = require('../lib/api-origin.cjs').apiOrigin(process.env.SOAK_BASE);
const COUNCIL_CODE = process.env.SOAK_COUNCIL || 'TMC';
const PW = 'SoakPass#2026';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const login = (email, password) => api('POST', '/auth/login', { body: { email, password } });
const log = (...a) => console.log(...a);

// 10 physician personas across the competence spectrum.
const TIERS = [
  { n: '01', tier: 'weak',    th: 'นพ. สมหวัง น้อยเรียน',  en: 'Dr Somwang (novice)' },
  { n: '02', tier: 'weak',    th: 'พญ. มินตรา ลังเล',      en: 'Dr Mintra (novice)' },
  { n: '03', tier: 'average', th: 'นพ. ธีรพงษ์ พอใช้',     en: 'Dr Theerapong (average)' },
  { n: '04', tier: 'average', th: 'พญ. กานต์ มาตรฐาน',     en: 'Dr Kan (average)' },
  { n: '05', tier: 'average', th: 'นพ. วิชัย ปานกลาง',     en: 'Dr Wichai (average)' },
  { n: '06', tier: 'good',    th: 'พญ. ปรียา เชี่ยวชาญ',   en: 'Dr Preeya (good)' },
  { n: '07', tier: 'good',    th: 'นพ. อนุชา รอบคอบ',      en: 'Dr Anucha (good)' },
  { n: '08', tier: 'good',    th: 'พญ. สุดารัตน์ ละเอียด',  en: 'Dr Sudarat (good)' },
  { n: '09', tier: 'top',     th: 'นพ. ก้องภพ ยอดเยี่ยม',  en: 'Dr Kongphop (top)' },
  { n: '10', tier: 'top',     th: 'พญ. นภัสสร เป็นเลิศ',   en: 'Dr Napatsorn (top)' },
];

(async () => {
  const sa = await login('superadmin@clics.th', 'ClicsSuper#2026r2');
  if (!sa.body?.access_token) throw new Error('superadmin login failed: ' + JSON.stringify(sa.body));
  const saT = sa.body.access_token;
  log('superadmin logged in.');

  // Everyone joins the same council in this soak cohort (default TMC; override via SOAK_COUNCIL).
  const TMC = ((await api('GET', '/admin/councils', { token: saT })).body || []).find(c => c.code === COUNCIL_CODE)?.id;
  if (!TMC) throw new Error(`council ${COUNCIL_CODE} not found — run db/migration-councils.sql`);

  // --- superadmin creates admins + auditors (the "invite") ---
  const admins = [
    { email: 'soakadmin1@example.com', full_name_th: 'ผู้จัดการ หนึ่ง', full_name_en: 'Pilot Admin 1' },
    { email: 'soakadmin2@example.com', full_name_th: 'ผู้จัดการ สอง', full_name_en: 'Pilot Admin 2' },
  ];
  const auditors = [
    { email: 'soakaud1@example.com', full_name_th: 'ผู้ตรวจ หนึ่ง', full_name_en: 'Auditor 1' },
    { email: 'soakaud2@example.com', full_name_th: 'ผู้ตรวจ สอง', full_name_en: 'Auditor 2' },
    { email: 'soakaud3@example.com', full_name_th: 'ผู้ตรวจ สาม', full_name_en: 'Auditor 3' },
  ];
  for (const a of admins) {
    const r = await api('POST', '/admin/users', { token: saT, body: { ...a, password: PW, role: 'admin', council_id: TMC } });
    log(`  create admin   ${a.email}: ${r.status}`);
  }
  for (const a of auditors) {
    const r = await api('POST', '/admin/users', { token: saT, body: { ...a, password: PW, role: 'auditor', council_id: TMC } });
    log(`  create auditor ${a.email}: ${r.status}`);
  }

  // --- superadmin direct-creates the 10 physicians (production-style onboarding) ---
  const physicians = [];
  for (const p of TIERS) {
    const email = `soakdoc${p.n}@example.com`;
    const r = await api('POST', '/admin/users', { token: saT, body: { email, password: PW, role: 'physician', council_id: TMC, full_name_th: p.th, full_name_en: p.en, specialty: 'Internal Medicine' } });
    physicians.push({ email, password: PW, tier: p.tier, professional_id: r.body?.id, pseudonym: r.body?.pseudonym, full_name_en: p.en });
    log(`  create physician ${email} (${p.tier}): ${r.status} ${r.body?.pseudonym ?? r.body?.error ?? ''}`);
  }

  const out = {
    base: BASE,
    superadmin: { email: 'superadmin@clics.th', password: 'ClicsSuper#2026r2' },
    admins: admins.map(a => ({ email: a.email, password: PW })),
    auditors: auditors.map(a => ({ email: a.email, password: PW })),
    physicians,
  };
  fs.writeFileSync('/tmp/soak-personas.json', JSON.stringify(out, null, 2));
  log(`\nWrote /tmp/soak-personas.json — ${physicians.length} physicians, ${admins.length} admins, ${auditors.length} auditors.`);
  log('Tier spread: ' + physicians.map(p => p.tier).join(', '));
  process.exit(physicians.every(p => p.professional_id) ? 0 : 1);
})().catch(e => { console.error('ONBOARD FAILED:', e.message); process.exit(1); });
