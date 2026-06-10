// Browser-only Supabase client — used for Google OAuth sign-in and the
// password-recovery flow. PII never touches this client; it only carries the
// OAuth/recovery session whose access_token we then hand to the backend.
//
// Requires '@supabase/supabase-js' (add it: `npm i @supabase/supabase-js`).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

// Lazily construct a singleton so importing this module never throws during
// SSR/build when the public env vars are absent — callers get a clear error
// only if they actually try to use Supabase without configuration.
export function getSupabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      'Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  client = createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

// True when the public Supabase env vars are present — lets a page hide the
// Google button / reset flow gracefully instead of crashing.
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
