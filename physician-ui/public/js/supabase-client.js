// supabase-client.js — exposes window.sbClient (browser anon client) for Google sign-in
// + password recovery. Loaded as <script type="module"> (CDN ESM import). The anon key is a
// PUBLIC value shipped to browsers by design (see config.js). If config.js still holds the
// placeholders, we DO NOT build a client — window.sbClient stays null and the UI degrades
// gracefully (Google button hidden / reset page shows a "link not configured" notice).
// PINNED version — '@2' floats to whatever esm.sh serves and has broken hash handling before.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const url = window.CLICS_SUPABASE_URL;
const anonKey = window.CLICS_SUPABASE_ANON_KEY;

const configured =
  !!url && !!anonKey &&
  url !== 'https://your-project.supabase.co' &&
  anonKey !== 'your-anon-key';

window.sbClient = configured
  ? createClient(url, anonKey, {
      auth: {
        // Recovery links + OAuth redirects come back with the session in the URL hash
        // (flowType 'implicit' — the hash-based flow our /auth/callback handling expects);
        // detectSessionInUrl lets the client pick it up automatically on /reset and /auth/callback.
        flowType: 'implicit',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

window.CLICS_SUPABASE_CONFIGURED = configured;
// Let non-module scripts know the client is ready (they load synchronously, before this module runs).
window.dispatchEvent(new CustomEvent('clics:sbready', { detail: { configured } }));
