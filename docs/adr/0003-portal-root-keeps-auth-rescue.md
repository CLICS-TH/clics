# The portal root keeps the OAuth rescue and the legacy logout handler, whatever it renders

The portal's sign-in form moves from `/` to `/login` so `/` can become a public landing page. Supabase falls back to its Site URL — the portal root — when a sign-in return URL is not on its allow-list, and audit-dashboard builds already deployed sign out via `/?logout=1`. So the page at `/`, whether today's thin redirect or the future landing page, must keep two head scripts: the rescue that forwards an `access_token` hash or `code=` query to `/auth/callback`, and the `?logout=1` handler that clears stored credentials. Deleting either breaks Google sign-in or sign-out for no visible reason.

## Considered Options

- **A Vercel redirect `/` → `/login`, with the Supabase Site URL changed to `/login`.** Rejected. It depends on the hash and query surviving a 308, it needs a change in the Supabase dashboard, and the landing-page round would have to undo the rule.
