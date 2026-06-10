// Runtime configuration. On localhost we auto-target the local stack so the app
// can be tested end-to-end before deploying; everywhere else uses production.
(function () {
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  window.CLICS_API_URL = local ? 'http://localhost:3001' : 'https://backend-production-c12e4.up.railway.app';
  window.CLICS_DASHBOARD_URL = local ? 'http://localhost:3002' : 'https://audit-dashboard-rouge.vercel.app';
  // Supabase browser client (public anon key) — for Google sign-in + password reset.
  // These are PUBLIC values (anon key is shipped to browsers by design). Fill from the Supabase project.
  window.CLICS_SUPABASE_URL = 'https://your-project.supabase.co';
  window.CLICS_SUPABASE_ANON_KEY = 'your-anon-key';
})();
