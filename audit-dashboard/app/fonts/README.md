# Self-hosted webfonts

`app/layout.tsx` loads these files with `next/font/local`. At build time Next copies each one to
`/_next/static/media/` under a content hash and writes the `@font-face` rules; nothing is fetched
from Google, or from anywhere else, at build time or in the browser.

They replace `next/font/google`, which downloads from Google **during `next build`**. On 2026-10-15
that download failed intermittently, once on Vercel (Noto Sans Thai) and once in a fresh GitHub
Actions runner (Noto Serif Thai), with Turbopack's
`Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'`, while the same
commit built locally. A build that needs Google is also a build the on-premises install cannot run.

## Provenance

Taken from the `@fontsource` npm packages on 2026-10-15, not from Google or any website. Every
package is version **5.3.0**, published 2026-07-19 and pinned exactly. The files are copied
byte-for-byte: each `sha256` below matches the file inside the package.

| File | Family | Package | Path in package | Bytes | sha256 |
| --- | --- | --- | --- | --- | --- |
| `inter-latin-wght-normal.woff2` | Inter | `@fontsource-variable/inter@5.3.0` | `files/inter-latin-wght-normal.woff2` | 48256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `cormorant-garamond-latin-wght-normal.woff2` | Cormorant Garamond | `@fontsource-variable/cormorant-garamond@5.3.0` | `files/cormorant-garamond-latin-wght-normal.woff2` | 37640 | `d80df8ff5aecd299a61549f9e29ab1ed0b9b05f4ea71d50fe978e07d5240b235` |
| `jetbrains-mono-latin-400-normal.woff2` | JetBrains Mono | `@fontsource/jetbrains-mono@5.3.0` | `files/jetbrains-mono-latin-400-normal.woff2` | 21168 | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `noto-sans-thai-thai-wght-normal.woff2` | Noto Sans Thai | `@fontsource-variable/noto-sans-thai@5.3.0` | `files/noto-sans-thai-thai-wght-normal.woff2` | 26924 | `1f5a173641bbcb3ca4fb0a986858b6b07f8cd5dd2ed61236b40548c7a3c7292f` |
| `noto-serif-thai-thai-wght-normal.woff2` | Noto Serif Thai | `@fontsource-variable/noto-serif-thai@5.3.0` | `files/noto-serif-thai-thai-wght-normal.woff2` | 32728 | `9f3427e0d6a6ed4d5d1aa4cec9d0633771f46648bcfd39f9f0f4889a446141bb` |

npm `integrity` of the tarballs they came from:

| Package | integrity |
| --- | --- |
| `@fontsource-variable/inter@5.3.0` | `sha512-OupL48va4JNofb97w6NYeF9S7W/kHNKM0Er8Dem5nqi4jeOLrVJDoE8tZEpnMJmtkvNbB1EIPPwHcdkF6b1oUA==` |
| `@fontsource-variable/cormorant-garamond@5.3.0` | `sha512-rgZJ/5w3hi60swAPnrOXpZf5wEH6NTrvm4H8D9Y4b1QIFUqlX14eM3QTMU/eAznjfh0eXpO1QUqsFhiy58aoMg==` |
| `@fontsource/jetbrains-mono@5.3.0` | `sha512-fqDfB5I9f1p1TV486aUgB9t8zP84P0O1FtQR5Ol9vjwPy+S+EIGlVYm1cvj2W5shcZMTg2nZFdVMoH5wFu8a1A==` |
| `@fontsource-variable/noto-sans-thai@5.3.0` | `sha512-jHEC1vo8gD09GKf8jtH1IMoPqWmQQSKH3gkyD3ibCIMEkVpEqJ9NJ2c181VHKbTHXc7Wu9CbuBU3yjQNvpbEbw==` |
| `@fontsource-variable/noto-serif-thai@5.3.0` | `sha512-3+f9Xd78ICNyrc9LadhmFi2rcOEDmXd27w2xWG/EI9wCoYz7MH4f3Uj3RyS1H0wvOm9PcmrlTnWircnxQrTQeg==` |

The packages are **not** dependencies of the dashboard. Nothing imports them at build or run time,
so they are not in `package.json` or `package-lock.json`. They were installed into a scratch
directory, the files were copied out, and the scratch directory was deleted.

## Licence

All five families are under the SIL Open Font License 1.1. Each package's licence text is copied
verbatim beside the fonts as `OFL-<Family>.txt`.

The files are byte-for-byte as published, but each one is a subset of an upstream font, which makes
it a Modified Version in the OFL's terms. The OFL allows that, and allows bundling with software,
as long as the licence travels with the fonts, which it does here. Its one extra condition on a
Modified Version, not reusing a Reserved Font Name, is moot: none of the five copyright notices
declares a Reserved Font Name.

## Same fonts as before

These were checked against the files `next/font/google` downloaded for the previous build:

- **Same font releases:** Inter 4.001 (git-66647c0bb), Cormorant Garamond 4.001, JetBrains Mono 2.211,
  Noto Sans Thai 2.002 and Noto Serif Thai 2.002.
- **Same contents:** the same `wght` axis ranges, the same character set, the same advance widths
  and vertical metrics, and identical glyph outlines.
- **The bytes differ in two places:**
  - `head.checkSumAdjustment`;
  - a 7-byte `prep` table (dropout control: `SCANCTRL 511`, `SCANTYPE 4`) that Google's copy leaves
    out.
- **Cormorant's GPOS** also differs, but only because one value record spells out `XAdvance=0`.
- **Rendering:** the same Thai and Latin strings at weights 400 to 700, sizes 13 to 22 px and
  pixel ratios 1x and 2x came out pixel-identical from both sets in Chromium. That holds for all
  five families.
- **The Thai files** contain every Thai code point Google's `thai` subset had, plus the same
  non-Thai code points (U+0020, U+00A0, U+02BC, U+02D7, U+0303, U+0331, U+200B–U+200D and
  U+25CC). That subset never included Latin letters. Latin text in a Thai string is drawn by
  Inter or Cormorant, which come first in each stack.

## What is shipped, and what is not

Only the subsets that were **preloaded** before are shipped: `latin` for Inter, Cormorant Garamond
and JetBrains Mono, and `thai` for both Noto Thai families. Each face carries Google's
`unicode-range` for its subset, verbatim.

Google's stylesheet also declared faces that load only when one of their characters is on screen.
They are no longer shipped:

- latin-ext, cyrillic, cyrillic-ext, greek, greek-ext and vietnamese for the Latin families;
- latin and latin-ext for the Thai families.

A character from one of those ranges, such as `Δ`, `ā` or Cyrillic, now renders from the
metric-matched Arial or Times New Roman fallback, or from the system font.

- **In the dashboard's own UI text** there is exactly one such character: the `Δ` in
  `components/ConsistencyChip.tsx`. That chip renders nothing until RIMPL sends
  `provenance.consistency`.
- **In data from the API** there will be more. Transcripts and AI rationale often contain Greek:
  β-blocker, α-agonist, μ. These now render from the fallback in every stack. In headings the
  face does not change: Cormorant never had Greek, so Times drew it before too, now 1.2% smaller.
  In body text they move from Inter to Arial. In `font-mono` they move from JetBrains Mono to
  proportional Arial, so a Greek letter in a monospaced value no longer keeps the column width.
  The micro sign `µ` (U+00B5) is in the latin range and is unaffected; only Greek `μ` (U+03BC)
  moves.

To bring a range back, copy that subset's file from the same package version and give it its own
`localFont` call with that subset's `unicode-range` and a new `variable`. Then put the new variable
in the stack in `globals.css` **in front of** the family it extends. Two things to know:

- **Behind it does not work.** That family's variable ends in its Arial or Times fallback, which has
  Greek, so the new face would never be reached. Its `unicode-range` keeps it from touching any
  other character.
- **It cannot join the existing family.** Turbopack names each family after its `const`, so a
  second call always starts a new family; that is why it needs its own place in the stack.

Then add the file to the tables above. For Greek, the pieces are:

- the files `inter-greek-wght-normal.woff2` (`@fontsource-variable/inter`) and
  `jetbrains-mono-greek-400-normal.woff2` (`@fontsource/jetbrains-mono`);
- the range `U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF`;
- `preload: false`, so the file loads only on a page that shows Greek;
- `adjustFontFallback: false`, because the family it extends already has a fallback face.

For example:

```ts
const interGreek = localFont({
  src: "./fonts/inter-greek-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" }],
});
// globals.css: --font-sans: var(--font-inter-greek), var(--font-inter), var(--font-noto-sans-thai), …
```

Checked in Chromium with the Inter files: placed in front, `β α μ Δ` render in Inter Greek and the
line height is unchanged. Placed behind, they render in Arial.

## Updating

```bash
REPO="$(git rev-parse --show-toplevel)"           # run from inside the checkout, before the cd
mkdir -p "$TMPDIR/fontsrc" && cd "$TMPDIR/fontsrc" && echo '{"private":true}' > package.json
npm view @fontsource-variable/inter time          # pick a version published at least 2 weeks ago
npm install --ignore-scripts --save-exact @fontsource-variable/inter@X.Y.Z   # and the others
cp node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 "$REPO/audit-dashboard/app/fonts/"
cp node_modules/@fontsource-variable/inter/LICENSE "$REPO/audit-dashboard/app/fonts/OFL-Inter.txt"
shasum -a 256 "$REPO"/audit-dashboard/app/fonts/*.woff2   # update the table above
```

`__tests__/self-hosted-fonts.test.ts` fails in any of these cases:

- a file's sha256 or size no longer matches this table;
- `layout.tsx` points at a file that is missing or not listed here;
- a family's `OFL-<Family>.txt` is missing;
- `next/font/google` or `@next/font/google` appears as a string anywhere in `app/`, `components/`,
  `lib/`, `public/` or the root config files. That covers `import`, `import()` and `require()`.
  A link to `fonts.googleapis.com` or `fonts.gstatic.com` in the same places fails it too.
