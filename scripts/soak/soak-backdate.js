// Backdate the soak so it reads as a real 1-week pilot in the superadmin/admin dashboards:
//   physician activity spread across May 31 – Jun 6 2026 (Thailand +07), 2-CLE physicians on
//   different days (LPDP trend), auditor scoring "after the week" on Jun 7. Demo data only.
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-backdate.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const WEEK_START = Date.parse('2026-05-31T01:00:00Z'); // 08:00 +07 on May 31
const DAY = 86400000, HOUR = 3600000;
const iso = ms => new Date(ms).toISOString();

(async () => {
  const { data: pros } = await s.from('professionals').select('id, pseudonym').eq('role', 'physician');
  let cleCount = 0, msgCount = 0;

  for (const pro of pros.sort((a, b) => a.pseudonym.localeCompare(b.pseudonym))) {
    const num = parseInt(pro.pseudonym.replace('P-', ''), 10); // 1..10
    const { data: cles } = await s.from('cles').select('id, duration_seconds, status').eq('physician_id', pro.id).order('started_at');
    for (let k = 0; k < cles.length; k++) {
      const cle = cles[k];
      const day0 = (num - 1) % 6;                 // physician's first session day (0..5)
      const day = k === 0 ? day0 : Math.min(day0 + 3, 6); // second session later in the week
      const hour = 8 + (num % 7) + k * 2;          // 8am–6pm-ish, varied per physician
      const started = WEEK_START + day * DAY + (hour - 8) * HOUR;
      const dur = (cle.duration_seconds ?? 900) * 1000;
      const ended = started + dur;

      await s.from('cles').update({ started_at: iso(started), ended_at: iso(ended), created_at: iso(started) }).eq('id', cle.id);
      cleCount++;

      // spread messages evenly between start and end
      const { data: msgs } = await s.from('messages').select('id').eq('cle_id', cle.id).order('created_at');
      for (let i = 0; i < msgs.length; i++) {
        const t = started + Math.round(((i + 1) / (msgs.length + 1)) * dur);
        await s.from('messages').update({ created_at: iso(t) }).eq('id', msgs[i].id);
        msgCount++;
      }
      // evaluation + LPDP snapshot land just after the session
      await s.from('ai_evaluations').update({ evaluated_at: iso(ended + 3 * 60000) }).eq('cle_id', cle.id);
      await s.from('lpdp_snapshots').update({ snapshot_at: iso(ended + 3 * 60000) }).eq('cle_id', cle.id);
    }
  }

  // auditor scoring happens "after the week": Jun 7 2026, spread through the day by auditor
  const { data: auditors } = await s.from('professionals').select('id, pseudonym, full_name_en').eq('role', 'auditor');
  const REVIEW_DAY = Date.parse('2026-06-07T02:00:00Z'); // 09:00 +07 on Jun 7
  auditors.sort((a, b) => (a.full_name_en || '').localeCompare(b.full_name_en || ''));
  let scoreCount = 0;
  for (let ai = 0; ai < auditors.length; ai++) {
    const { data: sc } = await s.from('audit_scores').select('id').eq('auditor_id', auditors[ai].id).order('scored_at');
    for (let i = 0; i < sc.length; i++) {
      const t = REVIEW_DAY + ai * 2 * HOUR + i * 12 * 60000; // each auditor a couple hours apart, ~12 min/score
      await s.from('audit_scores').update({ scored_at: iso(t) }).eq('id', sc[i].id);
      scoreCount++;
    }
  }

  console.log(`Backdated: ${cleCount} CLEs, ${msgCount} messages, audit_scores ${scoreCount}.`);
  // sanity print
  const { data: chk } = await s.from('cles').select('started_at, status').order('started_at');
  console.log('CLE span:', chk[0]?.started_at, '->', chk[chk.length - 1]?.started_at);
  process.exit(0);
})().catch(e => { console.error('BACKDATE FAILED:', e.message); process.exit(1); });
