// Minimal Markdown -> styled HTML for the CLICS docs (headings, tables, lists, bold, inline and
// FENCED code, blockquote, hr, autolinked URLs). Thai renders via system fonts; lang="th" gives chromium
// dictionary-based Thai line breaking (no mid-word breaks / combining-mark artifacts).
//
// Regenerate MANAGER-SUMMARY.pdf + USER-GUIDE.pdf (no extra installs — uses Playwright's chromium):
//   CHROME=$(echo ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell)
//   node scripts/docs-to-pdf.js MANAGER-SUMMARY.md /tmp/m.html && "$CHROME" --headless --no-sandbox --print-to-pdf=MANAGER-SUMMARY.pdf --no-pdf-header-footer /tmp/m.html
//   node scripts/docs-to-pdf.js USER-GUIDE.md /tmp/u.html && "$CHROME" --headless --no-sandbox --print-to-pdf=USER-GUIDE.pdf --no-pdf-header-footer /tmp/u.html
//
// Usage: node scripts/docs-to-pdf.js <in.md> <out.html>
const fs = require('fs');
const [, , inFile, outFile] = process.argv;
const md = fs.readFileSync(inFile, 'utf8');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/(^|[\s(])((https?:\/\/)[^\s<)]+)/g, '$1<a href="$2">$2</a>');

const lines = md.split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  // Fenced code block. Must be tested BEFORE every other block rule: inside a fence, a line
  // starting with # or | or - is code, not a heading, table or list. Without this the fence
  // markers survive into the output and the whole block collapses into one run-on paragraph
  // with its newlines eaten — which is what §9.2 of the methodology docs looked like.
  const fence = line.match(/^\s*```+\s*([a-z0-9+-]*)\s*$/i);
  if (fence) {
    const buf = [];
    i++;
    while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
    i++;  // consume the closing fence (or run off the end on an unclosed one)
    const cls = fence[1] ? ` class="lang-${fence[1].toLowerCase()}"` : '';
    out.push(`<pre${cls}><code>${esc(buf.join('\n'))}</code></pre>`);
    continue;
  }
  if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
    const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(line);
    i += 2;
    const body = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
    out.push('<table><thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
      + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    continue;
  }
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
  if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
  if (/^>\s?/.test(line)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
    out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    continue;
  }
  // A list item wrapped over several lines. The continuation line must be ABSORBED into the item:
  // left to fall through, it ends the list, becomes its own <p>, and the NEXT marker opens a fresh
  // list — which restarts an <ol> at 1 and un-indents a <ul> item's tail. Requiring the
  // continuation to be indented is deliberate: an un-indented line after a list is a new paragraph
  // far more often than it is a lazy continuation, and guessing wrong there is the worse failure.
  const listItems = (marker) => {
    const items = [];
    while (i < lines.length) {
      if (marker.test(lines[i])) { items.push(lines[i].replace(marker, '')); i++; continue; }
      const cont = items.length && /^\s+\S/.test(lines[i]) && !/^\s*(\||```|>|#{1,4}\s|---+\s*$)/.test(lines[i].trim());
      if (!cont) break;
      items[items.length - 1] += ' ' + lines[i].trim();
      i++;
    }
    return items;
  };
  if (/^\s*[-*]\s+/.test(line)) {
    const buf = listItems(/^\s*[-*]\s+/);
    out.push('<ul>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ul>');
    continue;
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    const buf = listItems(/^\s*\d+\.\s+/);
    out.push('<ol>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ol>');
    continue;
  }
  if (/^\s*$/.test(line)) { i++; continue; }
  const buf = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s|---+\s*$)/.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
    buf.push(lines[i]); i++;
  }
  out.push(`<p>${inline(buf.join(' '))}</p>`);
}

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm 14mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* lang="th" + word-break:normal → chromium uses dictionary-based Thai line breaking (no mid-word breaks). */
body { font-family: -apple-system, "Helvetica Neue", Arial, "Sukhumvit Set", "Noto Sans Thai", sans-serif; color: #1a1a1a; line-height: 1.36; font-size: 10pt; word-break: normal; overflow-wrap: normal; }
h1 { font-size: 18pt; margin: 0 0 3pt; color: #0f3d6e; }
h2 { font-size: 12.5pt; margin: 11pt 0 4pt; color: #0f3d6e; border-bottom: 1.5px solid #cdd9e6; padding-bottom: 2pt; }
h3 { font-size: 11pt; margin: 8pt 0 2pt; color: #1c3a52; }
h4 { font-size: 9.5pt; margin: 7pt 0 2pt; color: #5a6b7a; text-transform: uppercase; letter-spacing: .03em; }
p { margin: 4pt 0; }
ul, ol { margin: 4pt 0; padding-left: 18pt; }
li { margin: 1.5pt 0; }
hr { border: none; border-top: 1px solid #e2e2e2; margin: 11pt 0; }
code { background: #f1f4f8; padding: 1px 5px; border-radius: 4px; font-family: "SF Mono", Menlo, monospace; font-size: 9pt; color: #b03; }
pre { background: #f5f7fa; border: 1px solid #dde4ec; border-left: 3px solid #4a86c9; border-radius: 4px; margin: 7pt 0; padding: 7pt 10pt; overflow-x: auto; break-inside: avoid; }
pre code { background: none; padding: 0; color: #1c3a52; font-size: 8.5pt; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: #1763b3; text-decoration: none; }
blockquote { margin: 8pt 0; padding: 8pt 12pt; background: #f5f8fc; border-left: 4px solid #4a86c9; border-radius: 4px; color: #234; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9.5pt; }
th, td { border: 1px solid #d6dde6; padding: 5pt 8pt; text-align: left; vertical-align: top; }
th { background: #eef3f9; color: #0f3d6e; font-weight: 600; }
tr:nth-child(even) td { background: #fafcfe; }
strong { color: #111; }
</style></head><body>
${out.join('\n')}
</body></html>`;

fs.writeFileSync(outFile, html);
console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(1)}KB, ${out.length} blocks)`);
