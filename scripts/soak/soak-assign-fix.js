require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = 'https://backend-production-c12e4.up.railway.app';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j };
}
(async () => {
  const sa = (await api('POST', '/auth/login', { body: { email: 'superadmin@clics.th', password: 'ClicsSuper#2026r2' } })).body.access_token;
  const { data: auditors } = await s.from('professionals').select('id, full_name_en').eq('role', 'auditor');
  auditors.sort((a, b) => (a.full_name_en || '').localeCompare(b.full_name_en || ''));
  const { data: cles } = await s.from('cles').select('id').eq('status', 'evaluated').order('started_at');
  console.log('auditors:', auditors.map(a => `${a.full_name_en}=${a.id.slice(0,8)}`).join(', '));
  let assigned = 0;
  for (let i = 0; i < cles.length; i++) {
    const aud = auditors[i % auditors.length];
    const r = await api('POST', `/admin/cles/${cles[i].id}/assign`, { token: sa, body: { auditor_id: aud.id } });
    if (r.status === 200) assigned++; else console.log(`  assign ${cles[i].id.slice(0,8)} -> ${aud.full_name_en}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  console.log(`Assigned ${assigned}/${cles.length}.`);
  // verify
  const { data: chk } = await s.from('cles').select('auditor_id').eq('status', 'evaluated');
  console.log('CLEs with auditor_id set:', chk.filter(p => p.auditor_id).length);
  process.exit(0);
})().catch(e => { console.error('ASSIGN-FIX FAILED:', e.message); process.exit(1); });
