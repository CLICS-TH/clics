// Recover stranded PLEs through the LEGITIMATE deployed paths (no DB mutation):
//   - misjudged flagged (full session, tier-2 false negative) -> admin approve (manual QA)
//   - stuck cle_pass (eval dropped) -> new POST /admin/ples/:id/reevaluate (awaits, retries, 409 if already done)
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-recover2.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = 'https://backend-production-c12e4.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j };
}
const pseudoFor = async () => {
  const { data } = await s.from('professionals').select('id, pseudonym');
  return Object.fromEntries(data.map(p => [p.id, p.pseudonym]));
};

(async () => {
  const sa = (await api('POST', '/auth/login', { body: { email: 'superadmin@clics.th', password: 'ClicsSuper#2026r2' } })).body.access_token;
  const ps = await pseudoFor();

  // read-only: identify targets
  const { data: stuck } = await s.from('ples').select('id, physician_id').eq('status', 'cle_pass');
  const { data: misjudged } = await s.from('ples').select('id, physician_id, turn_count').eq('status', 'cle_flag_t2').gte('turn_count', 6);
  console.log(`stuck cle_pass: ${stuck.length}  | misjudged-flagged (>=6 turns): ${misjudged.length}`);

  // 1) manual-QA approve the misjudged full-session flagged PLEs (legit cle_flag_t2 -> cle_pass + eval)
  for (const p of misjudged) {
    const r = await api('POST', `/admin/ples/${p.id}/approve`, { token: sa });
    console.log(`  approve ${ps[p.physician_id]} ${p.id.slice(0,8)} (turns=${p.turn_count}): ${r.status} ${JSON.stringify(r.body)}`);
  }
  await sleep(4000);

  // 2) reevaluate everything that passed the gate but isn't evaluated yet (awaits + retries internally)
  const targets = [...stuck, ...misjudged];
  for (const p of targets) {
    const r = await api('POST', `/admin/ples/${p.id}/reevaluate`, { token: sa });
    console.log(`  reevaluate ${ps[p.physician_id]} ${p.id.slice(0,8)}: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.status === 404) { console.log('  !! 404 — new build not promoted yet; rerun shortly.'); }
  }

  const { data: final } = await s.from('ples').select('status');
  const h = final.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
  console.log('Final histogram:', JSON.stringify(h));
  process.exit(0);
})().catch(e => { console.error('RECOVER2 FAILED:', e.message); process.exit(1); });
