# Google sign-in runs in the Portal's own page, loads Google's script only on click, and keeps the Supabase redirect as a fallback

Google's account chooser named `rgwnnexokstctugwtwub.supabase.co`, because the Supabase redirect makes Supabase the party asking Google. With no domain of our own, brand verification (#186) cannot fix that yet. So the Portal asks Google itself through Google Identity Services: Google's button returns an ID token to the page, the page trades it with `signInWithIdToken` and a nonce, and the chooser names `physician-ui.vercel.app`. Login, invite accept and Link Google all go this way.

Three choices here look odd without context:

- **Two clicks.** Our "Continue with Google" button only loads `accounts.google.com/gsi/client` and swaps itself for Google's button. Loading it with the page would send every visitor's IP to Google, and the Privacy page promises Google sees only people who choose Google sign-in. GIS returns an ID token only from Google's own button or One Tap, so our button cannot open the popup itself. No One Tap: it fires without a click and is unreliable on iOS Safari.
- **The page hands the session to the Callback page in the URL hash.** After `signInWithIdToken` the page writes the flow marker and goes to `/auth/callback#access_token=…&refresh_token=…&flow=<id>`, the same shape the Supabase redirect lands plus the press's id. The marker lives in that tab's `sessionStorage`, tagged with the id, because every tab of the origin shares `localStorage` and a second tab's press would otherwise overwrite and consume it (invite accepted as a plain signup, #324). A Callback page with no marker of its own stops at an error, never at signup. The redirect cannot carry an id through Google, so it keeps its marker in `sessionStorage` too and in the shared `localStorage` key only as a fallback for a browser that drops the tab's copy; a two-tab race can remain only in that case. Signup completion, the council picker, invite accept, Link Google and the token rule stay in one handler for both modes.
- **The redirect stays.** `CLICS_GOOGLE_SIGNIN` in `google-config.js` selects the mode per flow, and the in-page mode runs only on origins listed under the OAuth client's Authorized JavaScript origins (no wildcards, so Vercel previews fall back to the redirect). Rolling back is a config change and a redeploy. The Callback page and the OAuth rescue (ADR 0003) therefore stay.

`gsi/client` carries no SRI hash: Google serves it unversioned and changes it without notice.

## Considered Options

- **Load GIS with the page, one click.** Rejected: Google would receive the IP of every visitor to `/login`, `/invite` and `/dashboard`.
- **Run signup, invite and link in place on each page.** Rejected: it duplicates the Callback page's branches and moves the council picker.
- **Delete the redirect and rely on git revert.** Rejected: a rollback would need a code revert under pressure, and previews would lose Google sign-in.
