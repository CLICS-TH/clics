// Ground-truth diagnostic of what the soak actually produced. Read-only.
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-diag.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const pad = (s, n) => String(s ?? '').padEnd(n);

(async () => {
  // auth email map
  const emailById = {};
  for (let page = 1; ; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    data.users.forEach(u => { emailById[u.id] = u.email; });
    if (data.users.length < 1000) break;
  }

  const { data: pros } = await supabase.from('professionals')
    .select('id, role, status, pseudonym, full_name_en').order('pseudonym');
  console.log(`\n=== PROFESSIONALS (${pros.length}) ===`);
  for (const p of pros) {
    console.log(`  ${pad(p.pseudonym, 7)} ${pad(p.role, 11)} ${pad(p.status, 12)} ${pad(emailById[p.id], 28)} ${p.full_name_en ?? ''}`);
  }

  const { data: cles } = await supabase.from('cles')
    .select('id, physician_id, auditor_id, status, turn_count, token_count, duration_seconds, started_at, ended_at, chief_complaint')
    .order('started_at');
  console.log(`\n=== CLEs (${cles.length}) ===`);

  // message + eval counts
  const proByid = Object.fromEntries(pros.map(p => [p.id, p]));
  const statusHist = {};
  for (const cle of cles) {
    const { count: msgs } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('cle_id', cle.id);
    const pro = proByid[cle.physician_id];
    statusHist[cle.status] = (statusHist[cle.status] ?? 0) + 1;
    console.log(`  ${pad(pro?.pseudonym ?? '??', 7)} ${pad(cle.status, 13)} turns=${pad(cle.turn_count, 3)} tok=${pad(cle.token_count, 6)} dur=${pad(cle.duration_seconds, 6)} msgs=${pad(msgs, 3)} aud=${cle.auditor_id ? 'Y' : '-'}  ${(cle.chief_complaint ?? '').slice(0, 30)}`);
  }

  console.log(`\n=== STATUS HISTOGRAM ===`);
  for (const [s, n] of Object.entries(statusHist)) console.log(`  ${pad(s, 14)} ${n}`);

  const { count: evals } = await supabase.from('ai_evaluations').select('id', { count: 'exact', head: true });
  const { count: scores } = await supabase.from('audit_scores').select('id', { count: 'exact', head: true });
  const { count: lpdp } = await supabase.from('lpdp_snapshots').select('id', { count: 'exact', head: true });
  const { count: msgsAll } = await supabase.from('messages').select('id', { count: 'exact', head: true });
  console.log(`\n=== TOTALS ===`);
  console.log(`  ai_evaluations ${evals}   audit_scores ${scores}   lpdp_snapshots ${lpdp}   messages ${msgsAll}`);
  const evaluated = cles.filter(p => p.status === 'evaluated').length;
  console.log(`\n  CLEs at 'evaluated' (auditable): ${evaluated}`);

  // sample a few assistant messages to check the content:null issue
  const { data: nullMsgs } = await supabase.from('messages').select('id, cle_id, role, content, token_count')
    .is('content', null).limit(10);
  console.log(`\n=== messages with NULL content: ${nullMsgs?.length ?? 0} (sample) ===`);
  (nullMsgs ?? []).forEach(m => console.log(`  cle=${m.cle_id.slice(0,8)} role=${m.role} tok=${m.token_count}`));
  process.exit(0);
})().catch(e => { console.error('DIAG FAILED:', e.message); process.exit(1); });
