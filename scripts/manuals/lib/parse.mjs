// Markdown-lite -> a small block AST, so one authored source can render into three very different
// targets without any of them needing a markdown runtime.
//
// WHY AN AST AND NOT HTML. The manual has to appear in physician-ui (static, zero build, plain
// <script src> globals) AND in audit-dashboard (Next 16 + React 19) AND in an A4 PDF. Shipping HTML
// fragments would force the React side to use dangerouslySetInnerHTML, which components/Markdown.tsx
// deliberately avoids. An AST lets each target render with its own idiom: the portal builds DOM, the
// dashboard returns JSX, the print target emits a string.
//
// WHY NOT FULL MARKDOWN. The vocabulary here is exactly what the existing print guides use and no
// more — headings, prose, steps, bullets, the callout triad, figures, tables, and the two CLICS-
// specific inline forms below. A general parser would accept constructs no renderer implements, and
// the failure would be silent. This one throws on anything it does not recognise.
//
// THE TWO CLICS-SPECIFIC FORMS
//   [[จบและส่ง / End]]   a UI label quoted VERBATIM from the product. docs/manuals/README.md makes
//                        this the house rule so a reader can match what is on screen. Rendered as a
//                        .chip, and greppable — scripts/manuals/verify-labels.mjs checks every one
//                        against the real front-end source, which is how a manual stops going stale.
//   [[~ ยกเลิก / Cancel]] the same, marked neutral (a secondary control) so the chip is not tinted
//                        as though it were the primary action.
//
// DIRECTIVES mirror the `:::artifact{}` fences the PLE chat already uses (rimpl emits them,
// physician-ui/public/js/artifacts.js parses them), so the syntax is not new to this codebase.

const CALLOUT_KINDS = new Set(['note', 'tip', 'warn']);

/** Inline: **bold**, [[chip]], [[~ neutral chip]], plain text. Returns an array of spans. */
export function parseSpans(text) {
  const spans = [];
  // One pass, alternation ordered so a chip containing ** is not split by the bold rule.
  const re = /\[\[(~\s*)?([^\]]+)\]\]|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[3] !== undefined) spans.push({ t: 'b', v: m[3] });
    else spans.push({ t: m[1] ? 'chip-neutral' : 'chip', v: m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ t: 'text', v: text.slice(last) });
  return spans.length ? spans : [{ t: 'text', v: '' }];
}

/** Every [[...]] label in a source, for the label-drift check. Neutral marker stripped. */
export function extractLabels(src) {
  return [...src.matchAll(/\[\[(~\s*)?([^\]]+)\]\]/g)].map((m) => m[2].trim());
}

function tableRow(line) {
  // Trailing/leading pipes are optional; an escaped \| stays literal.
  return line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Parse one language file into sections.
 *
 * Section heading:  `## {id} | {title}`
 * The id is stable across languages and is what the section index, the deep link and the
 * cross-language toggle all key on — so a translated file MUST reuse the same ids. parseManual()
 * enforces that rather than leaving it to reviewers.
 *
 * @returns {{id: string, title: string, blocks: object[]}[]}
 */
export function parseSections(src, { file = '<source>' } = {}) {
  const lines = src.split('\n');
  const sections = [];
  let cur = null;
  let i = 0;

  const fail = (msg) => { throw new Error(`${file}:${i + 1} — ${msg}`); };
  const push = (b) => { if (!cur) fail('content before the first `## id | title` heading'); cur.blocks.push(b); };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Authoring notes. Consumed to the closing fence, because a multi-line comment whose body does
    // not start with `<!--` would otherwise be parsed as prose and land in the manual.
    if (trimmed.startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      if (i >= lines.length) fail('an HTML comment is never closed');
      i++; continue;
    }

    // --- section heading ------------------------------------------------------------------------
    if (trimmed.startsWith('## ')) {
      const parts = trimmed.slice(3).split('|');
      if (parts.length < 2) fail('section heading needs `## {id} | {title}`');
      const id = parts[0].trim();
      if (!/^[a-z0-9-]+$/.test(id)) fail(`section id "${id}" must be kebab-case [a-z0-9-]`);
      cur = { id, title: parts.slice(1).join('|').trim(), blocks: [] };
      sections.push(cur);
      i++; continue;
    }

    // --- sub-heading ----------------------------------------------------------------------------
    if (trimmed.startsWith('### ')) { push({ t: 'h3', text: trimmed.slice(4).trim() }); i++; continue; }

    // --- lead paragraph (the print guides' .lead) -----------------------------------------------
    if (trimmed.startsWith('> ')) { push({ t: 'lead', spans: parseSpans(trimmed.slice(2).trim()) }); i++; continue; }

    // --- callout: ::: kind [heading] ... ::: ----------------------------------------------------
    if (trimmed.startsWith(':::')) {
      const open = trimmed.slice(3).trim();
      const [kind, ...headParts] = open.split(/\s+/);
      if (!CALLOUT_KINDS.has(kind)) fail(`unknown directive ":::${kind}" (want ${[...CALLOUT_KINDS].join('/')})`);
      const head = headParts.join(' ').trim();
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ':::') { body.push(lines[i]); i++; }
      if (i >= lines.length) fail(`":::${kind}" is never closed`);
      i++; // consume the closing fence
      push({ t: 'callout', kind, head: head || null, spans: parseSpans(body.join(' ').trim()) });
      continue;
    }

    // --- table ----------------------------------------------------------------------------------
    if (trimmed.startsWith('|')) {
      const head = tableRow(trimmed);
      if (i + 1 >= lines.length || !/^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) fail('table header needs a `|---|` separator row beneath it');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(tableRow(lines[i].trim())); i++; }
      push({ t: 'table', head, rows });
      continue;
    }

    // --- figure: ![alt](src "caption") ----------------------------------------------------------
    const fig = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(trimmed);
    if (fig) { push({ t: 'figure', alt: fig[1], src: fig[2], caption: fig[3] || null }); i++; continue; }

    // --- lists ----------------------------------------------------------------------------------
    // A numbered list is a STEP sequence (`ol.steps` in the print guides); a bulleted one is not.
    // The distinction is load-bearing for the reader, so it is preserved in the AST rather than
    // being left to a renderer's choice of marker.
    const ordered = /^\d+\.\s+/.test(trimmed);
    const bulleted = /^[-*]\s+/.test(trimmed);
    if (ordered || bulleted) {
      const items = [];
      const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || !re.test(t)) break;
        items.push(parseSpans(t.replace(re, '')));
        i++;
      }
      push({ t: ordered ? 'steps' : 'ul', items });
      continue;
    }

    // --- paragraph (greedy to the next blank line) ----------------------------------------------
    const para = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith('#') || t.startsWith(':::') || t.startsWith('|') || t.startsWith('>')
        || /^\d+\.\s+/.test(t) || /^[-*]\s+/.test(t) || /^!\[/.test(t)) break;
      para.push(t); i++;
    }
    push({ t: 'p', spans: parseSpans(para.join(' ')) });
  }

  if (!sections.length) throw new Error(`${file} — no sections found`);
  return sections;
}

/**
 * Parse one manual's language pair and assert they describe the same document.
 *
 * A translation that silently drops or reorders a section is the classic way a bilingual manual
 * rots: the toggle lands the reader somewhere else, or nowhere. Checked here so it fails the build
 * rather than a reader.
 */
export function parseManual({ th, en, name = 'manual' }) {
  const sections = { th: parseSections(th, { file: `${name}.th.md` }) };
  if (en == null) return sections;
  sections.en = parseSections(en, { file: `${name}.en.md` });

  const ids = (s) => s.map((x) => x.id);
  const a = ids(sections.th);
  const b = ids(sections.en);
  if (a.join(',') !== b.join(',')) {
    const missing = a.filter((x) => !b.includes(x));
    const extra = b.filter((x) => !a.includes(x));
    throw new Error(
      `${name}: the Thai and English sections do not match.\n`
      + (missing.length ? `  missing from .en.md: ${missing.join(', ')}\n` : '')
      + (extra.length ? `  only in .en.md: ${extra.join(', ')}\n` : '')
      + (!missing.length && !extra.length ? `  same ids, different order:\n    th: ${a.join(', ')}\n    en: ${b.join(', ')}\n` : ''));
  }
  return sections;
}
