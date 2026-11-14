# audit-dashboard — Admin / Auditor / Superadmin consoles

The staff dashboard: CLE management + assignment, the auditor's blind PIS-7 scorer, the ICC dashboard,
invites, and user/usage management. **Next.js 16** (App Router) + React 19 + Tailwind **v4** + shadcn-on-
Base-UI + recharts. Deployed to **Vercel**.

> ⚠️ **This is not the Next.js most training data knows.** Next 16 has breaking changes — **read
> `node_modules/next/dist/docs/` before touching any Next API** (see [`AGENTS.md`](AGENTS.md)).

## Run

```bash
npm install
cp .env.example .env.local           # NEXT_PUBLIC_API_URL, NEXT_PUBLIC_PORTAL_URL, NEXT_PUBLIC_SUPABASE_*
npm run dev -- -p 3002               # port 3002 (the portal expects the dashboard here; next dev
                                     # defaults to 3000, which collides with physician-ui)
npm run build && npm start           # production build / serve
npm run lint                         # eslint
```

`NEXT_PUBLIC_*` is **inlined at build time** — after changing it (incl. on Vercel) you must rebuild, or
the old value (e.g. `localhost:3001`) stays baked in and prod login silently hangs.

`NEXT_PUBLIC_PORTAL_URL` is the Portal (physician-ui) origin that sign-in, Sign out and Return to physician
go to. Left unset it falls back to the prod Portal (`https://physician-ui.vercel.app`), so a local stack
without it signs you out to prod. Set it to `http://localhost:3000` locally.

## Layout

- `app/` — App Router. `login/` (consumes the `?token=` handoff from the portal — a bare visit redirects
  to the portal's `/login`), `home/`, `admin/` (`overview`, `cles`, `cles/[id]`, `flagged`, `invites`, `users`,
  `icc`, `lpdp`, `stats`), `auditor/` (`queue`, `cles/[id]`), `forgot/`, `reset/`. `globals.css` holds the
  Tailwind v4 `@theme` block + design tokens.
- `components/` — `NavBar`, `Toggles` (theme/viewport), `AppShell`, `PageIntro`, `Footer`, `RoleBadge`,
  `Skeleton`, `ThemeProvider`, `ViewportProvider`; and the design-system pieces: **`BiLabel`** (bilingual
  hierarchy), **`Overlays`** (`toast()` / `confirmDialog()`), **`Markdown`** (react-markdown + remark-gfm),
  **`DomainScorer`** (the rubric-anchored 0–5-chip PIS-7 scorer), `TranscriptView` (memoized), `IccPanel`,
  `LpdpChart`, `BlandAltmanPlot`. `components/ui/` is shadcn primitives.
- `lib/` — `api.ts` (backend fetch + auth header), `auth.ts`, `supabase-browser.ts`, `labels.ts`
  (status/role labels + the `WEIGHTS` source of truth), **`pis7-rubric.ts`** (rubric anchors — *mirrors*
  `rimpl/src/lib/prompts.js`, keep in sync), **`chart-colors.ts`** (hex constants for recharts, mirroring
  the `--chart-*` CSS tokens), `utils.ts`.

## Conventions

- **Design tokens** are CSS vars in `globals.css` (`--coral-active` for the primary CTA, `--chart-pass/
  -fail/-threshold/-warn`). Tailwind utilities reference them via `bg-[var(--token)]`. **Recharts can't use
  CSS `var()` in SVG attributes** — charts import `lib/chart-colors.ts` instead.
- **Bilingual labels** → `BiLabel` (Thai primary, English dimmed). **Dialogs/toasts** → `Overlays`, not
  native `confirm`/`alert`. **Markdown** (transcripts) → `Markdown`.
- **Blind-scoring integrity:** the auditor's AI score stays hidden until they submit; `DomainScorer`
  requires all 7 domains set before submit (no silent-0 default).
- **Never `sbClient.auth.signOut()`** after storing the token (it revokes the Supabase session → 401s).

Deploy: after the vm1 cutover, `deploy/vm1/deploy.sh` builds and starts the dashboard with the backend. From
#429 on, `vercel.json` here is a redirect to `https://clics.ccme.or.th/audit/`, so `vercel --prod --yes` from
this tree moves every dashboard user there. Before the cutover, deploy to Vercel only from a pre-#429 ref (with
`NEXT_PUBLIC_API_URL` set on Vercel); the owner deploys this tree's redirect at cutover step 4.
See [../docs/deployment.md](../docs/deployment.md).
