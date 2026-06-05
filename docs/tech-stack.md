# Tech Stack

- **Physician UI:** static HTML/JS (no build step), single `public/css/main.css` (CSS custom-property design tokens), Chart.js via CDN. Dark/light + desktop/mobile toggles via `public/js/boot.js`. Served on Vercel (`vercel.json`: `outputDirectory: public`, `cleanUrls: true`).
- **Audit Dashboard:** Next.js **16.2.7** (App Router), React **19.2.4**, Tailwind **v4** (`@theme` block, config-less), shadcn-on-Base-UI, recharts. Custom `ThemeProvider` / `ViewportProvider` (no `next-themes`). ⚠️ This Next is newer than most training data — read `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs (see `audit-dashboard/AGENTS.md`).
- **Backend:** Node.js + Express (port 3001), Supabase SDK (auth + DB), Anthropic SDK (via RIMPL). JWT auth via Supabase Auth (`signInWithPassword` / `auth.getUser`).
- **Database:** Supabase / PostgreSQL, AES-256 at rest, row-level security.
- **Middleware:** RIMPL (custom, on-premise, port 3003), Claude-only today (see [architecture.md](architecture.md) / [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md)).
- **AI Providers (planned):** Claude (Anthropic), GPT-4o (OpenAI), Gemini (Google Vertex AI), Mistral — randomized per session via L4. **Currently only Claude (`claude-sonnet-4-6`) is wired.**

## Design system

Anthropic warm-editorial: cream canvas `#faf9f5`, coral `#cc785c` (active `#a9583e`), dark navy `#181715`, ink `#141413`. Display = Cormorant Garamond + Noto Serif Thai; body = Inter + Noto Sans Thai; mono = JetBrains Mono. Bilingual (Thai/English) throughout. Full spec: `DESIGN-claude.md`.
