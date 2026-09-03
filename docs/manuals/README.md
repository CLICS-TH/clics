# CLICS user manuals

Two manuals — one for physicians, one for expert auditors — written for clinicians with no technical
background, in **Thai and English at equal weight**. Each ships **inside its own console** and also
prints to A4.

| Manual | Where a reader finds it | Handout |
|---|---|---|
| **Physician** | physician-ui → **`/manual`**, linked from the portal nav | `clics-physician-manual-{th,en}.pdf` |
| **Auditor** | audit-dashboard → **`/manual`**, linked from the auditor nav | `clics-auditor-manual-{th,en}.pdf` |

The physician manual is **public** (`data-public`): a reader who cannot get past the sign-in screen
can still read the section that explains signing in.

## One source, three targets

`content/*.md` is the **only** place the prose is written. Everything else is generated.

```
docs/manuals/content/{physician,auditor}.{th,en}.md      ← edit these
        │
        ├─▶ physician-ui/public/manual.html              ← generated + committed
        ├─▶ audit-dashboard/lib/manual-content.ts        ← generated + committed
        └─▶ docs/manuals/clics-*-manual-*.pdf            ← generated (Playwright)
```

```bash
npm run manuals            # rebuild the two in-console targets
npm run test:manuals       # parser tests + generated-file freshness + label drift + TH/EN parity
npm run test:manuals-scale # type hierarchy at 11 widths, both consoles  (needs Chromium)
npm run test:manuals-embed # the manual is reachable and renders in both consoles
node scripts/manuals/pdf.mjs             # the four A4 handouts (needs Chromium)
node scripts/manuals/pdf.mjs physician th   # just one
```

The generated files are committed because the portal has no build step — Vercel serves `public/`
as-is. `npm run test:manuals` runs `build.mjs --check` in CI, so a committed copy can never fall
behind its source.

## The format

Markdown, plus two things the product needs. `scripts/manuals/lib/parse.mjs` rejects anything else
rather than rendering it as nothing.

| Syntax | Renders as |
|---|---|
| `## section-id \| Section title` | A section. **Ids must match across languages, in the same order** — the build fails otherwise, because the language toggle keys on them |
| `[[จบและส่ง / End]]` | A UI label quoted **verbatim** from the product |
| `[[~ ยกเลิก / Cancel]]` | The same, marked as a *secondary* control |
| `::: note` / `::: tip` / `::: warn` … `:::` | A callout. The kind is shown as a word, not only a colour |
| `> text` | A lead paragraph |
| `1.` / `-` | A numbered **step sequence** / a plain bullet list — deliberately different things |
| `![alt](img/x.png "caption")` | A figure. The file must exist in `source/img/` or the build fails |
| A GFM table | A table, in its own horizontal scroller |

## The two rules that keep it from going stale

**1. Quoted labels are verbatim, and checked.** `scripts/manuals/verify-labels.mjs` greps every
`[[label]]` — in both languages — against the real front-end source. Rename a button and the manual
goes red. This is the check the previous manuals did not have, which is how they ended up two months
behind the product with no signal at all.

**2. Generated files are checked for freshness.** `build.mjs --check` fails if any target, or any
copied screenshot, is behind `content/`.

Both run in the `manuals` job in `.github/workflows/ci.yml`. Neither needs a browser, a secret, or
the network.

## Design

The manual uses the product's own tokens and adds no colours: `physician-ui/public/css/guide.css`
for the portal, Tailwind utilities on `audit-dashboard/app/globals.css` tokens for the dashboard. It
keeps the console's chrome but reads as a distinct editorial surface — a wider measure, serif
numbered section heads, a stepped rhythm the product itself never uses.

### Sizes are `em`. Never px, never rem.

This is the one rule that is easy to break and invisible when broken, so it has its own gate. The
two consoles scale desktop type in **incompatible** ways, and the manual renders in both:

| | scales | so `rem` |
|---|---|---|
| physician-ui | `body { font-size: 22px }` at ≥1280px (`main.css`) | does **not** follow — `rem` tracks `<html>`, which never moves |
| audit-dashboard | `html { font-size: 118/132/145% }` at 1280/1600/1920 (`globals.css`) | does follow |

A px size is frozen in both, and a frozen size inside a base that grows is how a heading ends up
smaller than its own paragraph. Measured before this was fixed: `h3` rendering **17px inside 22px
body** at 1280px — legible, correctly coloured, and passing every other gate. `em` is the only unit
that tracks the reader's real base size in both consoles. That also rules out the shared
`--text-lg` / `--text-2xl` tokens, which are rem clamps; `guide.css` spells its clamps out in `em`.

`npm run test:manuals-scale` measures every text role against the role whose scale governs it — a
section number against its heading, not against body — at 11 widths in both languages, and fails on
an inversion, a Thai-floor breach, or a role its selectors can no longer reach. Read its coverage
line: without `DASH_URL` it measures the portal only.

Two floors it must not breach, both enforced by `npm run test:readability` (which renders `/manual`
at four widths × two themes × **both languages**):

- **Thai never below 12px.** The loop (หัว) that distinguishes many Thai letters closes up before
  Latin becomes unreadable.
- **Serif never below 24px / 600**, per `main.css:62-63` — so section heads are serif and sub-heads
  are not.

Coral text on a tinted background uses `--coral-on-card` (portal) / `--coral-on-tint` (dashboard).
The bright `--coral` / `--primary` is a border and accent colour and measures ~3.1:1 as text.

## Superseded

`source/*.html` and `scripts/manuals/generate.mjs` are the **old** pipeline: three hand-written Thai
HTML files that were themselves the source. They are kept only for `clics-user-auditor-guide-th`
(the dual-role manual), which has not been ported yet.

⚠️ **All three `source/`-built PDFs are stale** — `clics-user-guide-th.pdf`,
`clics-auditor-guide-th.pdf` **and `clics-user-auditor-guide-th.pdf`** (last built 2026-06-29,
before identity verification, the reflection step, the privacy-report path, the submit attestations
and anchor clarity). Hand out `clics-physician-manual-*.pdf` and `clics-auditor-manual-*.pdf`
instead.

The dual-role file needs naming separately because it is the trap: it is the only one with no
replacement, so it is the one still likely to be handed to someone. A dual-role participant given
it gets no mention of the identity verification they must complete before their first episode.
Until the dual-role manual is ported, brief those participants from both new manuals instead.

The two replaced files should be deleted once nobody is linking to them.

## Screenshots

`npm run manuals:capture` re-shoots every frame. It needs **no credentials and no live data**:
both consoles gate on `localStorage`, so the harness seeds a token, and every backend call is
*fulfilled* from `scripts/manuals/lib/capture-fixtures.mjs` rather than forwarded. Add
`DASH_URL=http://localhost:3002` (a running dashboard) to include the auditor frames.

Three properties, each of which replaces a way the old pipeline failed:

- **Assert before write.** The frame is captured to a Buffer, its DOM text is run through
  `lib/pii-gate.mjs`, and only a clean frame reaches the disk. A PNG is the one artifact here that
  code review cannot read, and `physician-ui/public/img/` is served to the open internet.
- **`expect`, so an empty state cannot be published.** Every frame names a string the populated page
  must contain. This exists because the first auditor-queue capture photographed *"No PLEs assigned
  yet"* — the fixture shape was wrong, the page rendered its empty state, and a plain "has text"
  check passed it. A screenshot of an empty feature is worse than no screenshot.
- **Fail closed.** Any frame that errors, renders empty or trips the gate exits non-zero. The old
  `generate.mjs` warned and continued, which is how the manual shipped two-month-old frames.

The PII gate borrows `rimpl/src/services/pii-filter.js` — the same filter that guards the cloud-AI
boundary — rather than growing a second, weaker copy. Six of its eight classes refuse a frame;
`AGE` and `DATE` cannot, because every product screenshot contains them. `lib/pii-gate.mjs` states
that trade and its known false negatives in full; read them before trusting a green run. Its own
tests run in `npm run test:manuals`.

`source/img/` is still the home of the screenshots; `build.mjs` copies them to
`physician-ui/public/img/manual/`.

`source/test-login-guide-th.html` is **gitignored and contains credentials** — never port it, never
publish it.
