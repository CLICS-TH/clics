# physician-ui — physician portal

The patient-facing portal and the **single login point for everyone** (physicians use it directly;
admins/auditors/superadmins sign in here and are handed to the dashboard via `/login?token=`). Static
HTML/CSS/JS, **phone-first**, bilingual Thai/English, **no build step**. Served on **Vercel**
(`vercel.json`: `outputDirectory: public`, `cleanUrls: true`); locally via `serve` on port **3000**.

## Run

```bash
npm install
npm run dev      # npx serve public -l 3000 --cors
```

No `.env` — `public/js/config.js` auto-targets `localhost:3001` (backend) / `localhost:3002` (dashboard)
when on localhost, and the prod URLs otherwise.

## Pages (`public/*.html`)

`login.html` (sign-in, served at `/login`) · `index.html` (public Landing page; signed-in visitors are forwarded by `js/forward.js`; keeps the
[ADR 0003](../docs/adr/0003-portal-root-keeps-auth-rescue.md) head scripts) ·
`dashboard.html` (CLE list + folders + usage meter + consent gate) ·
`ple-new.html` (start a CLE) · `ple-chat.html` (chat) · `ple-result.html` (PIS-7 result) ·
`lpdp.html` (longitudinal trend) · `guest-chat.html` (anonymous trial) · `invite.html` (accept invite) ·
`forgot.html` / `reset.html` (password reset).

## JS modules (`public/js/`)

- **Shared infra:** `config.js` (runtime URLs), `api.js` (fetch wrapper), `auth.js` (token/role guard),
  `boot.js` (theme + viewport toggles), `labels.js` (`cssVar` + bilingual label helpers),
  `supabase-client.js`. **`icons.js`** (`icon(name, size)` → inline-SVG line icons) and **`ui.js`**
  (`toast()` / `confirmModal()`) are the shared design-system primitives — added in the 2026-06 design
  audit; prefer them over native `alert`/`confirm` and emoji.
- **Per-page logic:** `dashboard.js`, `ple-chat.js`, `guest-chat.js`, `invite.js`, `reset.js`,
  `forgot.js`, `oauth-callback.js`.

## Conventions

- **The `<head>` is intentionally duplicated** across pages (no-FOUC theme snippet + the `/css/fonts.css` link).
  With no build there's no include mechanism, and the boot snippet must be inline to run before first
  paint. When you add a page, copy the `<head>` from an existing one.
- **Design tokens** live in `public/css/main.css` as CSS custom properties (cream canvas, coral
  `--coral-active` for CTAs, etc.). Full system: [../DESIGN-claude.md](../DESIGN-claude.md).
- **Bilingual labels:** Thai primary, English dimmed — use the `.bi` / `.bi-en` classes.
- **Auth:** the stored `clics_token` *is* the Supabase session token — never call `auth.signOut()` after
  storing it.

Deploy: `vercel --prod --yes`. See [../docs/deployment.md](../docs/deployment.md).
