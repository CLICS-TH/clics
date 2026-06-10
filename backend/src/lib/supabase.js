const { createClient } = require('@supabase/supabase-js');

const OPTS = { auth: { persistSession: false, autoRefreshToken: false } };

// db: used for all data queries — never call auth methods on this
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, OPTS);

// auth: used only for auth.getUser() in middleware — isolated so session pollution doesn't affect db queries
const authSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, OPTS);

// anon: the PUBLIC auth flows (email OTP send/verify, password reset) are designed for the anon
// key, not the service-role key. FAIL CLOSED in production — the most public endpoints must never
// run under the RLS-bypassing service-role key. Dev falls back (with a warning) for convenience.
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
if (IS_PROD && !process.env.SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_ANON_KEY is required in production (public auth flows must not use the service-role key)');
}
if (!process.env.SUPABASE_ANON_KEY) {
  console.warn('[supabase] SUPABASE_ANON_KEY unset — public auth flows fall back to the service-role key (dev only).');
}
const authAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  OPTS
);

module.exports = { supabase, authSupabase, authAnon };
