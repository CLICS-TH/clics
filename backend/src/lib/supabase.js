const { createClient } = require('@supabase/supabase-js');

const OPTS = { auth: { persistSession: false, autoRefreshToken: false } };

// db: used for all data queries — never call auth methods on this
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, OPTS);

// auth: used only for auth.getUser() in middleware — isolated so session pollution doesn't affect db queries
const authSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, OPTS);

module.exports = { supabase, authSupabase };
