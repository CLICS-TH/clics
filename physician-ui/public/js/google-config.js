// Google sign-in settings (ADR 0008), loaded by the pages that start a Google sign-in. They live apart from
// config.js because the booth promo's source digest covers config.js, and the booth never reads these.
// 'gis' asks Google in the Portal's own page, 'redirect' goes through Supabase as before. Roll back by setting
// a flow to 'redirect' and redeploying. 'gis' also needs the OAuth client ID below and a page origin listed
// under that client's Authorized JavaScript origins (no wildcards, so Vercel previews fall back to the redirect).
window.CLICS_GOOGLE_SIGNIN = { login: 'gis', invite: 'gis', link: 'gis' };
window.CLICS_GOOGLE_ORIGINS = ['https://physician-ui.vercel.app', 'http://localhost:3000'];
// Public OAuth client ID of the Supabase Google provider (not a secret). Empty keeps every flow on the redirect.
window.CLICS_GOOGLE_CLIENT_ID = '723476258825-6ocmvnqt8on5bodhaa4qure55260n0q2.apps.googleusercontent.com';
