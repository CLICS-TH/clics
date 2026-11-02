// Runtime configuration. On localhost we auto-target the local stack so the app
// can be tested end-to-end before deploying; everywhere else uses production.
(function () {
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  window.CLICS_API_URL = local ? 'http://localhost:3001' : 'https://backend-production-c12e4.up.railway.app';
  // Booth Mode Landing QR (#212). Switch on only once the Landing page (#191) is live at the Portal root.
  window.CLICS_BOOTH_LANDING_QR = false;
  window.CLICS_DASHBOARD_URL = local ? 'http://localhost:3002' : 'https://audit-dashboard-rouge.vercel.app';
  // Supabase browser client (public anon key) — for Google sign-in + password reset.
  // These are PUBLIC values (anon key is shipped to browsers by design). Fill from the Supabase project.
  window.CLICS_SUPABASE_URL = 'https://rgwnnexokstctugwtwub.supabase.co';
  window.CLICS_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnd25uZXhva3N0Y3R1Z3d0d3ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTQxMTUsImV4cCI6MjA5NjEzMDExNX0.4v13bnmvUeI0k85ft2WG-aSbQcc25SqltCp6GJl41LU';
  // Google sign-in mode per flow (ADR 0007): 'gis' asks Google in the Portal's own page, 'redirect' goes
  // through Supabase as before. Roll back by setting a flow to 'redirect' and redeploying. 'gis' also
  // needs the OAuth client ID below and a page origin listed under that client's Authorized JavaScript
  // origins (no wildcards, so Vercel previews fall back to the redirect).
  window.CLICS_GOOGLE_SIGNIN = { login: 'gis', invite: 'gis', link: 'gis' };
  window.CLICS_GOOGLE_ORIGINS = ['https://physician-ui.vercel.app', 'http://localhost:3000'];
  // Public OAuth client ID of the Supabase Google provider (not a secret). Empty keeps every flow on the redirect.
  window.CLICS_GOOGLE_CLIENT_ID = '';
})();
