// scripts/scale/seed-80k.js
// Bulk-seed N synthetic physicians (default 80 000) into a *TEST* Supabase to validate DB scale
// after db/migration-scale.sql. Pair with bench.js.
//
//   Run from backend/ so @supabase/supabase-js resolves (same pattern as scripts/soak/*):
//     cd backend && NODE_PATH="$PWD/node_modules" \
//       SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node ../scripts/scale/seed-80k.js
//   Override the target count:  COUNT=10000 node ../scripts/scale/seed-80k.js
//
// !!  POINT THIS AT A THROWAWAY TEST PROJECT ONLY  !!  It creates tens of thousands of auth users
//     and professionals rows. Never run against the live pilot DB. Cleanup note in README.md.
//
// FK NOTE (important): public.professionals.id REFERENCES auth.users(id) ON DELETE CASCADE.
//   You cannot insert a professionals row without a matching auth.users row first. This script
//   therefore takes approach (a): it creates a lightweight confirmed auth user per physician via
//   supabase.auth.admin.createUser(), then bulk-inserts the professionals rows in batches of 1000.
//   (Approach (b) — inserting straight into auth.users — needs raw SQL/admin DB access the JS
//   service-role client doesn't expose, and would skip GoTrue's bookkeeping, so we don't.)

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

const COUNT = parseInt(process.env.COUNT || '80000', 10);
const PROF_BATCH = 1000;   // professionals.insert([...]) batch size (per the task spec)
const AUTH_CONCURRENCY = 24; // parallel createUser calls (GoTrue is the bottleneck, not the table)
const COUNCIL_CODE = 'TMC';
const EMAIL_DOMAIN = 'scale.test';   // synthetic, non-routable; keeps test users obvious
const PASSWORD = 'ScaleTest#2026';   // throwaway; these accounts never log in

const SPECIALTIES = [
  'Internal Medicine', 'Family Medicine', 'Pediatrics', 'Surgery',
  'Obstetrics & Gynaecology', 'Cardiology', 'Emergency Medicine', 'Psychiatry',
];

// Synthetic, deterministic-by-index name/email so a partial run can be resumed without collisions.
const pseudonymOf = (i) => `P-${i}`;
const emailOf = (i) => `scale-p${i}@${EMAIL_DOMAIN}`;
const nameThOf = (i) => `นพ. ทดสอบสเกล ${i}`;
const nameEnOf = (i) => `Dr ScaleTest ${i}`;
const specialtyOf = (i) => SPECIALTIES[i % SPECIALTIES.length];

async function resolveCouncilId(code) {
  const { data, error } = await supabase.from('councils').select('id').eq('code', code).single();
  if (error || !data) {
    throw new Error(`council "${code}" not found — run db/schema.sql / db/migration-councils.sql first (${error?.message || 'no row'})`);
  }
  return data.id;
}

// How many synthetic physicians are already present (idempotent-ish skip).
async function currentSyntheticCount() {
  const { count, error } = await supabase
    .from('professionals')
    .select('id', { count: 'exact', head: true })
    .like('pseudonym', 'P-%')
    .eq('role', 'physician');
  if (error) throw error;
  return count ?? 0;
}

// Run an array of async thunks with bounded concurrency; collect results in order.
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Create one confirmed auth user; return its id (or null on failure, logged once).
let authFailures = 0;
async function createAuthUser(i) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: emailOf(i),
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) {
    // A duplicate (resumed run) is fine — look the user up so the professionals row can still attach.
    if (/already.+registered|duplicate|exists/i.test(error.message)) {
      const found = await findAuthIdByEmail(emailOf(i));
      if (found) return found;
    }
    authFailures++;
    if (authFailures <= 5) console.error(`  auth createUser failed for index ${i}: ${error.message}`);
    return null;
  }
  return data.user.id;
}

// listUsers has no get-by-email; paginate and match (only hit on resume/duplicate paths).
async function findAuthIdByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

(async () => {
  const t0 = Date.now();
  console.log(`seed-80k: target COUNT=${COUNT} into ${SUPABASE_URL}`);
  console.log('FK note: each physician needs an auth.users row first (approach a).');

  const councilId = await resolveCouncilId(COUNCIL_CODE);
  console.log(`council ${COUNCIL_CODE} -> ${councilId}`);

  const already = await currentSyntheticCount();
  console.log(`already present (role=physician, pseudonym P-%): ${already}`);
  if (already >= COUNT) {
    console.log(`Nothing to do — ${already} >= COUNT ${COUNT}. (Idempotent skip.)`);
    process.exit(0);
  }

  // Seed indices [already+1 .. COUNT] so a resumed run continues the P-NNN series without reuse.
  const startIdx = already + 1;
  const indices = [];
  for (let i = startIdx; i <= COUNT; i++) indices.push(i);
  console.log(`seeding indices ${startIdx}..${COUNT} (${indices.length} new physicians)`);

  let insertedProfs = 0;
  // Process in PROF_BATCH-sized chunks: create that chunk's auth users (concurrently), then one
  // professionals.insert([...]) for the chunk. Keeps memory flat and gives steady progress.
  for (let off = 0; off < indices.length; off += PROF_BATCH) {
    const chunk = indices.slice(off, off + PROF_BATCH);
    const tb = Date.now();

    const ids = await mapPool(chunk, AUTH_CONCURRENCY, (i) => createAuthUser(i));

    const rows = [];
    for (let k = 0; k < chunk.length; k++) {
      const id = ids[k];
      if (!id) continue; // auth user failed — skip; FK would reject it anyway
      const i = chunk[k];
      rows.push({
        id,
        role: 'physician',
        status: 'active',
        council_id: councilId,
        pseudonym: pseudonymOf(i),
        full_name_th: nameThOf(i),
        full_name_en: nameEnOf(i),
        specialty: specialtyOf(i),
        license_status: 'unverified',
      });
    }

    if (rows.length) {
      const { error } = await supabase.from('professionals').insert(rows);
      if (error) {
        console.error(`  professionals.insert failed for chunk @${chunk[0]}: ${error.message}`);
      } else {
        insertedProfs += rows.length;
      }
    }

    const done = off + chunk.length;
    const rate = Math.round(done / ((Date.now() - t0) / 1000));
    console.log(
      `  +${rows.length.toString().padStart(4)} profs  [${(startIdx + done - 1)
        .toString()
        .padStart(6)}/${COUNT}]  chunk ${fmtMs(Date.now() - tb)}  (~${rate}/s, elapsed ${fmtMs(Date.now() - t0)})`,
    );
  }

  const total = await currentSyntheticCount();
  console.log('—');
  console.log(`inserted this run: ${insertedProfs} professionals`);
  if (authFailures) console.log(`auth createUser failures: ${authFailures}`);
  console.log(`total synthetic physicians now: ${total}`);
  console.log(`TOTAL TIME: ${fmtMs(Date.now() - t0)}`);
  process.exit(authFailures ? 1 : 0);
})().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
