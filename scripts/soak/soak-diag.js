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

  const { data: ples } = await supabase.from('ples')
    .select('id, physician_id, auditor_id, status, turn_count, token_count, duration_seconds, started_at, ended_at, chief_complaint')
    .order('started_at');
  console.log(`\n=== PLEs (${ples.length}) ===`);

  // message + eval counts
  const proByid = Object.fromEntries(pros.map(p => [p.id, p]));
  const statusHist = {};
  for (const ple of ples) {
    const { count: msgs } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('ple_id', ple.id);
    const pro = proByid[ple.physician_id];
    statusHist[ple.status] = (statusHist[ple.status] ?? 0) + 1;
    console.log(`  ${pad(pro?.pseudonym ?? '??', 7)} ${pad(ple.status, 13)} turns=${pad(ple.turn_count, 3)} tok=${pad(ple.token_count, 6)} dur=${pad(ple.duration_seconds, 6)} msgs=${pad(msgs, 3)} aud=${ple.auditor_id ? 'Y' : '-'}  ${(ple.chief_complaint ?? '').slice(0, 30)}`);
  }

  console.log(`\n=== STATUS HISTOGRAM ===`);
  for (const [s, n] of Object.entries(statusHist)) console.log(`  ${pad(s, 14)} ${n}`);

  const { count: evals } = await supabase.from('ai_evaluations').select('id', { count: 'exact', head: true });
  const { count: scores } = await supabase.from('audit_scores').select('id', { count: 'exact', head: true });
  const { count: lpdp } = await supabase.from('lpdp_snapshots').select('id', { count: 'exact', head: true });
  const { count: msgsAll } = await supabase.from('messages').select('id', { count: 'exact', head: true });
  console.log(`\n=== TOTALS ===`);
  console.log(`  ai_evaluations ${evals}   audit_scores ${scores}   lpdp_snapshots ${lpdp}   messages ${msgsAll}`);
  const evaluated = ples.filter(p => p.status === 'evaluated').length;
  console.log(`\n  PLEs at 'evaluated' (auditable): ${evaluated}`);

  // sample a few assistant messages to check the content:null issue
  const { data: nullMsgs } = await supabase.from('messages').select('id, ple_id, role, content, token_count')
    .is('content', null).limit(10);
  console.log(`\n=== messages with NULL content: ${nullMsgs?.length ?? 0} (sample) ===`);
  (nullMsgs ?? []).forEach(m => console.log(`  ple=${m.ple_id.slice(0,8)} role=${m.role} tok=${m.token_count}`));
  process.exit(0);
})().catch(e => { console.error('DIAG FAILED:', e.message); process.exit(1); });
