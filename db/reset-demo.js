// db/reset-demo.js — reset the CLICS app to a clean slate, PRESERVING test history.
//
// Wipes all REAL activity (PLEs + messages + AI evals + audit scores + LPDP where is_test=false)
// and every non-superadmin account EXCEPT the accounts that own or scored a TEST session
// (ples.is_test = true). Test sessions are kept so they can keep feeding the audit system.
// councils + council_slots are CONFIGURATION and are never wiped.
//
//   cd backend && NODE_PATH="$PWD/node_modules" node ../db/reset-demo.js
//
// Mark sessions test first with db/mark-test-sessions.js. Reads backend/.env for the prod
// Supabase service-role key. DESTRUCTIVE for real data — there is no undo.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const KEEP_SUPERADMIN = 'superadmin@clics.th';
const SUPERADMIN_PW = 'ClicsSuper#2026r2';
const NIL = '00000000-0000-0000-0000-000000000000'; // sentinel so "delete all" has a filter
const SLOTS = [
  { role: 'superadmin', capacity: 1 }, { role: 'admin', capacity: 5 },
  { role: 'physician', capacity: 100 }, { role: 'auditor', capacity: 20 },
];

async function count(table) {
  const { count } = await supabase.from(table).select('id', { count: 'exact', head: true });
  return count ?? 0;
}
async function snapshot(label) {
  const tables = ['councils', 'professionals', 'ples', 'messages', 'ai_evaluations', 'audit_scores', 'lpdp_snapshots', 'access_requests', 'oauth_identities'];
  const out = {};
  for (const t of tables) out[t] = await count(t);
  console.log(`\n${label}:`);
  for (const [t, n] of Object.entries(out)) console.log(`  ${t.padEnd(18)} ${n}`);
  return out;
}
async function wipe(table) {
  const { error } = await supabase.from(table).delete().neq('id', NIL);
  if (error) throw new Error(`wipe ${table}: ${error.message}`);
}
async function listAllUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

// IDs of every account that owns or scored a TEST session — these must survive the reset,
// or the FK ples.physician_id → professionals would be orphaned.
async function testAccountIds() {
  const keep = new Set();
  const { data: testPles } = await supabase.from('ples').select('id, physician_id, auditor_id').eq('is_test', true);
  const ids = [];
  for (const p of testPles ?? []) {
    if (p.physician_id) keep.add(p.physician_id);
    if (p.auditor_id) keep.add(p.auditor_id);
    ids.push(p.id);
  }
  if (ids.length) {
    const { data: scores } = await supabase.from('audit_scores').select('auditor_id').in('ple_id', ids);
    for (const s of scores ?? []) if (s.auditor_id) keep.add(s.auditor_id);
  }
  return keep;
}

(async () => {
  console.log('CLICS RESET — wiping REAL activity + accounts; keeping test sessions + their accounts.');
  await snapshot('BEFORE');

  // Delete only REAL sessions (is_test=false). Their messages/ai_evaluations/audit_scores cascade;
  // lpdp_snapshots has no cascade, so remove those rows by ple_id first.
  const { data: realPles } = await supabase.from('ples').select('id').eq('is_test', false);
  const realIds = (realPles ?? []).map(p => p.id);
  if (realIds.length) {
    await supabase.from('lpdp_snapshots').delete().in('ple_id', realIds);
    await supabase.from('ples').delete().in('id', realIds);
  }
  await wipe('access_requests');

  // Accounts to keep = superadmin + everyone tied to a surviving test session.
  const all = await listAllUsers();
  const sa = all.find(u => u.email?.toLowerCase() === KEEP_SUPERADMIN.toLowerCase());
  const keepIds = await testAccountIds();
  if (sa) keepIds.add(sa.id);

  let deleted = 0, kept = 0;
  for (const u of all) {
    if (keepIds.has(u.id)) { kept++; continue; }
    await supabase.auth.admin.deleteUser(u.id); // cascades the professionals row + oauth_identities
    deleted++;
  }
  console.log(`\nDeleted ${deleted} accounts; kept ${kept} (superadmin + test-session owners/scorers).`);

  // Ensure the superadmin bootstrap exists, active, with a known password and no council.
  let saId = sa?.id;
  if (saId) {
    await supabase.auth.admin.updateUserById(saId, { password: SUPERADMIN_PW, email_confirm: true });
  } else {
    const { data, error } = await supabase.auth.admin.createUser({ email: KEEP_SUPERADMIN, password: SUPERADMIN_PW, email_confirm: true });
    if (error) throw error;
    saId = data.user.id;
  }
  await supabase.from('professionals').upsert({
    id: saId, role: 'superadmin', status: 'active', council_id: null,
    full_name_th: 'ผู้ดูแลระบบสูงสุด', full_name_en: 'Super Admin',
  }, { onConflict: 'id' });

  // Restore global slot pools; restore per-council admin/auditor pools for every council.
  await supabase.from('role_slots').upsert(SLOTS, { onConflict: 'role' });
  const { data: councils } = await supabase.from('councils').select('id');
  const councilSlots = (councils ?? []).flatMap(c => [
    { council_id: c.id, role: 'admin', capacity: 5 },
    { council_id: c.id, role: 'auditor', capacity: 20 },
  ]);
  if (councilSlots.length) await supabase.from('council_slots').upsert(councilSlots, { onConflict: 'council_id,role' });
  console.log('Superadmin reset; global + per-council slot pools restored. Councils preserved.');

  await snapshot('AFTER');
  console.log('\nReset complete. Real data cleared; test history + councils preserved.');
  process.exit(0);
})().catch(e => { console.error('RESET FAILED:', e.message); process.exit(1); });
