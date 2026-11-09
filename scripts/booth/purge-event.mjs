#!/usr/bin/env node
/*
 * Booth purge (#217, ADR 0004, 0010): prints the counts summary for CCME and, with --delete, removes every
 * booth_plays row of one event. Booth plays are kept as research data with no 30-day delete (ADR 0010): run it only
 * for a test event or an owner-ordered removal.
 *
 * Needs db/migration-booth-purge.sql applied: one call to booth_event_summary() checks the switch, deletes and
 * summarizes in one transaction, so the printed summary describes exactly the rows deleted. That transaction also
 * records the summary in booth_event_purges under the run's attempt id, so whether a delete whose response was lost
 * committed is read back exactly, with --attempt.
 *
 * Run from backend/ (dotenv loads backend/.env and @supabase/supabase-js resolves from backend/node_modules):
 *   node ../scripts/booth/purge-event.mjs --event TEST-2026                  # read only
 *   node ../scripts/booth/purge-event.mjs --event TEST-2026 --delete         # delete, print what was deleted
 *   node ../scripts/booth/purge-event.mjs --event TEST-2026 --attempt <id>   # read only: did that delete commit?
 *
 * Every run ends with the one block to send CCME (or a line saying there is none yet) and a "Next step:" line naming
 * the exact command to run next, if any (plan() in purge-summary.mjs decides both). The operator follows that line.
 *
 * Exit codes: 0 = done · 1 = the call failed, or rows remain · 2 = bad arguments, misconfigured, or refused because
 * a booth event is switched on.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { SAFE_EVENT_CODE, report, bangkokTime, command, plan, ending } from './purge-summary.mjs';

const USAGE = 'usage: node ../scripts/booth/purge-event.mjs --event <CODE> [--delete | --attempt <id>]   (run from backend/)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  let code = null;
  let del = false;
  let attempt = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--event') code = argv[++i] ?? null;
    else if (argv[i] === '--delete') del = true;
    else if (argv[i] === '--attempt') attempt = argv[++i] ?? '';
    else return { error: `unknown argument ${argv[i]}` };
  }
  if (!code) return { error: '--event is required' };
  if (!SAFE_EVENT_CODE.test(code)) return { error: `--event ${JSON.stringify(code)} is not an event code (A-Z, 0-9 and -, up to 32)` };
  if (attempt !== null && !UUID.test(attempt)) return { error: `--attempt ${JSON.stringify(attempt)} is not an attempt id` };
  if (attempt && del) return { error: '--attempt reads only: use it without --delete' };
  return { code, del, attempt };
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`${args.error}\n${USAGE}`);
  process.exit(2);
}
const { code, del } = args;
// A --delete run's own id, stored with its record; a read passes the id it was given to look that record up.
const attempt = del ? randomUUID() : args.attempt;

const end = (p, exit) => {
  console.log(ending(code, p));
  process.exit(exit);
};

// Resolved against backend/, not this file: every dependency lives there.
const require = createRequire(`${process.cwd()}/`);
let supabase;
try {
  require('dotenv').config();
  ({ supabase } = require(`${process.cwd()}/src/lib/supabase`));
} catch (e) {
  console.error(`Could not load the backend modules: ${e.message}`);
  end({ ccme: null, none: 'none yet (nothing was read or deleted)',
    next: `From the backend/ folder, run \`${command(code, del ? '--delete' : args.attempt ? `--attempt ${args.attempt}` : '')}\`.` }, 2);
}

let summary;
let error;
try {
  ({ data: summary, error } = await supabase.rpc('booth_event_summary', { p_event: code, p_delete: del, p_attempt: attempt }));
} catch (e) {
  error = { message: e?.message ?? String(e) };
}
if (error?.code === 'BP409') {
  console.error('refused: a booth event is switched on (booth_enabled = 1).');
  end(plan(code, { kind: 'refused' }), 2);
}
if (error?.code === 'PGRST202') {
  console.error(`booth_event_summary is missing: ${error.message}`);
  end(plan(code, { kind: 'missing' }), 2);
}
if (error || !summary) {
  console.error(`booth_event_summary failed: ${error?.message ?? 'no result'}`);
  end(plan(code, { kind: 'failed', del, attempt }), 1);
}

if (!del) {
  console.log(`Live plays of ${code} now (dry run: nothing deleted):\n${report(code, summary)}\n`);
  const p = plan(code, { kind: 'read', summary, attempt });
  const earlier = summary.recorded;
  const shown = p.ccme && (p.ccme.summary === earlier?.summary || earlier?.purged_at === summary.attempt?.purged_at);
  if (earlier && !shown) {
    console.log(`Earlier purge at ${bangkokTime(earlier.purged_at)} (not the CCME summary of this run):\n${report(code, earlier.summary)}\n`);
  }
  end(p, 0);
}

const p = plan(code, { kind: 'deleted', summary });
const { count: left, error: countError } = await supabase.from('booth_plays').select('id', { count: 'exact', head: true }).eq('event_code', code);
if (countError || left == null) {
  console.error(`booth_plays recount failed: ${countError?.message ?? 'no count'}`);
  end({ ...p, next: `The delete committed and its CCME summary is above: send it. Then run \`${command(code)}\` to check no plays remain.` }, 1);
}
console.log(`deleted ${summary.plays} rows, ${left} remain\n`);
if (left > 0) end({ ...p, next: `${left} plays remain. Send the CCME summary block above, then run \`${command(code)}\` and follow its next step.` }, 1);
end(p, 0);
