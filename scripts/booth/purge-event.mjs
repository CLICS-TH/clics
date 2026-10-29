#!/usr/bin/env node
/*
 * Booth retention (#217, ADR 0004): prints the counts summary for CCME, then with --delete removes every
 * booth_plays row of one event. Run it 30 days after the forum's last day.
 *
 * Needs db/migration-booth-purge.sql applied: one call to booth_event_summary() checks the switch, deletes and
 * summarizes in one transaction, so the printed summary describes exactly the rows deleted.
 *
 * Run from backend/ (dotenv loads backend/.env and @supabase/supabase-js resolves from backend/node_modules):
 *   cd backend && node ../scripts/booth/purge-event.mjs --event NFCME-2026            # summary only
 *   cd backend && node ../scripts/booth/purge-event.mjs --event NFCME-2026 --delete   # summary of the deleted rows
 *
 * --delete refuses while the event is the configured booth_event_code and booth_enabled = 1: switch the booth off
 * first. Re-running on a purged event prints plays 0 and exits 0.
 *
 * Exit codes: 0 = done · 1 = the call failed, or rows remain · 2 = bad arguments, misconfigured, or refused because
 * the event is still switched on.
 */
import { createRequire } from 'node:module';
import { SAFE_EVENT_CODE, report } from './purge-summary.mjs';

const USAGE = 'usage: cd backend && node ../scripts/booth/purge-event.mjs --event <CODE> [--delete]';

function parseArgs(argv) {
  let code = null;
  let del = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--event') code = argv[++i] ?? null;
    else if (argv[i] === '--delete') del = true;
    else return { error: `unknown argument ${argv[i]}` };
  }
  if (!code) return { error: '--event is required' };
  if (!SAFE_EVENT_CODE.test(code)) return { error: `--event ${JSON.stringify(code)} is not an event code (A-Z, 0-9 and -, up to 32)` };
  return { code, del };
}

const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

const args = parseArgs(process.argv.slice(2));
if (args.error) fail(2, `${args.error}\n${USAGE}`);

// Resolved against backend/, not this file: every dependency lives there.
const require = createRequire(`${process.cwd()}/`);
let supabase;
try {
  require('dotenv').config();
  ({ supabase } = require(`${process.cwd()}/src/lib/supabase`));
} catch (e) {
  fail(2, `Could not load the backend modules, run this from backend/:\n  ${USAGE}\n\n${e.message}`);
}

async function remaining(code) {
  const { count, error } = await supabase.from('booth_plays').select('id', { count: 'exact', head: true }).eq('event_code', code);
  if (error || count == null) fail(1, `booth_plays recount failed: ${error?.message ?? 'no count'}`);
  return count;
}

const { code, del } = args;
const { data: summary, error } = await supabase.rpc('booth_event_summary', { p_event: code, p_delete: del });
if (error?.code === 'BP409') {
  fail(2, `refused: ${code} is the booth's event and booth_enabled = 1. Switch the booth off on the superadmin overview first.`);
}
if (error?.code === 'PGRST202') fail(2, `booth_event_summary is missing: apply db/migration-booth-purge.sql first.\n${error.message}`);
if (error || !summary) fail(1, `booth_event_summary failed: ${error?.message ?? 'no result'}`);
console.log(report(code, summary));

if (!del) {
  console.log('dry run: nothing deleted');
  process.exit(0);
}
const left = await remaining(code);
console.log(`deleted ${summary.plays} rows, ${left} remain`);
process.exit(left === 0 ? 0 : 1);
