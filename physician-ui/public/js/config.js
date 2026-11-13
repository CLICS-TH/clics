// Runtime configuration. The Portal, the API (/api) and the audit-dashboard (/audit) share one origin
// (#429): the vm1 site, or locally the one-origin dev proxy on :3080 (scripts/dev/one-origin.mjs).
// Any other localhost port (the bare Portal dev server, the test harnesses) reaches the API on :3001; the
// dashboard is only ever same-origin, since it reads the Portal's session from localStorage.
(function () {
  var direct = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && location.port !== '3080';
  window.CLICS_API_URL = direct ? 'http://localhost:3001' : location.origin + '/api';
  // Booth Mode Landing QR (#212). Switch on only once the Landing page (#191) is live at the Portal root.
  window.CLICS_BOOTH_LANDING_QR = false;
  window.CLICS_DASHBOARD_URL = '/audit';
  // Supabase browser client (public anon key) — for Google sign-in + password reset.
  // These are PUBLIC values (anon key is shipped to browsers by design). Fill from the Supabase project.
  window.CLICS_SUPABASE_URL = 'https://rgwnnexokstctugwtwub.supabase.co';
  window.CLICS_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnd25uZXhva3N0Y3R1Z3d0d3ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTQxMTUsImV4cCI6MjA5NjEzMDExNX0.4v13bnmvUeI0k85ft2WG-aSbQcc25SqltCp6GJl41LU';
})();
