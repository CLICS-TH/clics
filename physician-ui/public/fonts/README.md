# Self-hosted webfonts (Portal)

`/css/fonts.css` declares one `@font-face` per family over these files. Every Portal page links that
stylesheet, so no page asks Google's font hosts for anything and a visitor's IP is not sent to Google
just for viewing a page.

The five woff2 files and the `OFL-*.txt` licence texts are byte-for-byte copies of
`audit-dashboard/app/fonts/` (`@fontsource` 5.3.0). Provenance, the sha256 and npm integrity tables,
the comparison against Google's files and the list of subsets that are not shipped all live in
`audit-dashboard/app/fonts/README.md`. Check the copies still match with:

```bash
for f in physician-ui/public/fonts/*.woff2 physician-ui/public/fonts/OFL-*.txt; do
  cmp "$f" "audit-dashboard/app/fonts/$(basename "$f")"
done
```

## Weight ranges

Each face's `font-weight` is the range the old Google Fonts link requested, not the file's full
`wght` axis: Cormorant Garamond and Noto Serif Thai `500 600`, Inter and Noto Sans Thai `400 600`,
JetBrains Mono `400`. The CSS uses `font-weight: 700` in many places, and before this change the
browser resolved that to the 600 instance. A wider range would draw those visibly bolder.

## Caching

`vercel.json` serves `/fonts/*` with `Cache-Control: public, max-age=31536000, immutable`. A browser
that has a file never asks for it again, so **an updated font must get a new filename**, and
`css/fonts.css` must point at it. Overwriting a file in place leaves returning visitors on the old one
for a year. `css/fonts.css` itself is not cached that way, which is what lets a rename take effect.
