// scripts/scale/bench.js
// Time the hot DB paths against a seeded (~80K-physician) TEST Supabase and print a table.
// Goal: after db/migration-scale.sql, every path should be index-backed and sub-100ms.
//
//   cd backend && NODE_PATH="$PWD/node_modules" \
//     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node ../scripts/scale/bench.js
//   Override sample size:  RUNS=15 node ../scripts/scale/bench.js
//
// Paths timed (mirrors the real backend hot paths):
//   1. next_pseudonym() RPC            — the O(1) sequence (db/migration-scale.sql)  ...vs...
//      legacy full-scan                — select all pseudonyms + JS max (pre-migration behaviour)
//   2. slot-count                      — count(role=physician, status=active)  (usedCount)
//   3. professionals page              — select ... limit 50 offset 0   (admin roster)
//   4. cles page                       — select ... limit 50 order by started_at desc
//
// Timing model: we wall-clock the actual supabase client calls (the spec's "by timing the supabase
// call" option), N=RUNS times each, and report min / median / max ms. True query-planner output
// (EXPLAIN ANALYZE / index-usage confirmation) needs raw SQL in the Supabase SQL editor — the
// service-role JS client can't run arbitrary SQL — so the exact EXPLAIN statements are in
// scripts/scale/README.md. The wall-clock medians here are the practical sub-100ms gate.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUNS = parseInt(process.env.RUNS || '10', 10);

// --- the timed operations ---------------------------------------------------

// 1a. O(1) pseudonym allocation via the migration RPC.
async function nextPseudonymRpc() {
  const { data, error } = await supabase.rpc('next_pseudonym');
  if (error) throw error;
  return typeof data === 'string';
}

// 1b. Legacy O(N) behaviour: pull every pseudonym, compute max in JS (what we replaced).
async function nextPseudonymLegacyScan() {
  const { data, error } = await supabase
    .from('professionals').select('pseudonym').not('pseudonym', 'is', null);
  if (error) throw error;
  let max = 0;
  for (const row of data ?? []) {
    const m = /^P-(\d+)$/.exec(row.pseudonym || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// 2. Slot used-count: how many active physicians (the usedCount slot check).
async function slotCount() {
  const { count, error } = await supabase
    .from('professionals')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'physician')
    .eq('status', 'active');
  if (error) throw error;
  return count;
}

// 3. Paginated professionals roster (admin list), 50/page.
async function professionalsPage() {
  const { data, error } = await supabase
    .from('professionals')
    .select('id, pseudonym, full_name_en, role, status, council_id')
    .eq('role', 'physician')
    .order('created_at', { ascending: false })
    .range(0, 49);
  if (error) throw error;
  return data?.length ?? 0;
}

// 4. Paginated CLE list, 50/page (admin sessions list). Empty result is fine — still exercises
//    the planner over the cles table; seed CLEs separately if you want non-empty timings.
async function clesPage() {
  const { data, error } = await supabase
    .from('cles')
    .select('id, physician_id, status, started_at, turn_count, token_count')
    .order('started_at', { ascending: false })
    .range(0, 49);
  if (error) throw error;
  return data?.length ?? 0;
}

// --- timing harness ---------------------------------------------------------

async function time(fn) {
  const t = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return { ms, out };
}

async function bench(name, fn, runs = RUNS) {
  const samples = [];
  let last;
  // one warm-up (JIT / connection) not counted
  try { await fn(); } catch (e) { return { name, error: e.message }; }
  for (let i = 0; i < runs; i++) {
    try { const { ms, out } = await time(fn); samples.push(ms); last = out; }
    catch (e) { return { name, error: e.message }; }
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return {
    name,
    min: samples[0],
    median,
    max: samples[samples.length - 1],
    runs,
    sample: last,
  };
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

(async () => {
  console.log(`bench: ${SUPABASE_URL}  (RUNS=${RUNS})`);

  const { count: total } = await supabase
    .from('professionals').select('id', { count: 'exact', head: true });
  console.log(`professionals rows: ${total ?? '?'}`);
  console.log('');

  const results = [];
  results.push(await bench('1a next_pseudonym() RPC  [O(1) seq]', nextPseudonymRpc));
  results.push(await bench('1b legacy full-scan      [O(N) scan]', nextPseudonymLegacyScan));
  results.push(await bench('2  slot count(role+status)', slotCount));
  results.push(await bench('3  professionals page (limit 50)', professionalsPage));
  results.push(await bench('4  cles page (limit 50)', clesPage));

  // table
  const W = 40;
  console.log(`${pad('path', W)}  ${padL('min', 9)}  ${padL('median', 9)}  ${padL('max', 9)}  status`);
  console.log('-'.repeat(W + 9 * 3 + 6 + 8));
  for (const r of results) {
    if (r.error) {
      console.log(`${pad(r.name, W)}  ${padL('—', 9)}  ${padL('—', 9)}  ${padL('—', 9)}  ERROR: ${r.error}`);
      continue;
    }
    const ms = (x) => `${x.toFixed(1)}ms`;
    const ok = r.median < 100 ? 'OK <100ms' : 'SLOW';
    console.log(
      `${pad(r.name, W)}  ${padL(ms(r.min), 9)}  ${padL(ms(r.median), 9)}  ${padL(ms(r.max), 9)}  ${ok}`,
    );
  }
  console.log('');
  console.log('Note: medians are wall-clock round-trips (includes network). For query-planner');
  console.log('proof of index usage, run the EXPLAIN ANALYZE statements in scripts/scale/README.md');
  console.log('in the Supabase SQL editor — confirm Index Scan (not Seq Scan) on professionals/cles.');

  // The legacy-vs-RPC delta is the headline of the migration.
  const rpc = results.find((r) => r.name.startsWith('1a'));
  const scan = results.find((r) => r.name.startsWith('1b'));
  if (rpc && scan && !rpc.error && !scan.error && rpc.median > 0) {
    console.log('');
    console.log(`pseudonym allocation speedup: legacy ${scan.median.toFixed(1)}ms -> RPC ${rpc.median.toFixed(1)}ms  (${(scan.median / rpc.median).toFixed(0)}x faster)`);
  }

  const anySlow = results.some((r) => !r.error && r.median >= 100 && !r.name.startsWith('1b'));
  process.exit(anySlow ? 1 : 0);
})().catch((e) => {
  console.error('BENCH FAILED:', e.message);
  process.exit(1);
});
