// Block AST -> HTML, for the two targets that want a string: the portal's static page and the A4
// print render. The dashboard renders the same AST as React instead, so nothing here is shared with
// it — which is deliberate, because that side must not take HTML it would have to inject.
//
// EVERYTHING IS ESCAPED. The content is ours and committed, so this is not an XSS boundary, but the
// prose is full of angle brackets and ampersands ("≥ 4 รอบ", "AI & prompt skill") and an unescaped
// one silently eats the rest of a line. Escaping unconditionally is cheaper than noticing.
//
// CLASS NAMES ARE THE PRODUCT'S. .chip/.callout/.warn/.tip/.steps and friends already exist as a
// vocabulary in docs/manuals/source/style.css; guide.css re-skins them onto the physician-ui tokens
// rather than inventing a parallel set. That is why a manual looks like CLICS and not like a doc site.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function spans(list) {
  return list.map((s) => {
    switch (s.t) {
      case 'b': return `<b>${esc(s.v)}</b>`;
      // A quoted UI label. `dir="auto"` is deliberate: these are Thai + Latin mixed, and letting the
      // browser resolve direction per chip avoids a stray bracket jumping to the wrong end.
      case 'chip': return `<span class="chip" dir="auto">${esc(s.v)}</span>`;
      case 'chip-neutral': return `<span class="chip chip-neutral" dir="auto">${esc(s.v)}</span>`;
      default: return esc(s.v);
    }
  }).join('');
}

const CALLOUT_LABEL = {
  note: { th: 'หมายเหตุ', en: 'Note' },
  tip: { th: 'เคล็ดลับ', en: 'Tip' },
  warn: { th: 'ข้อควรระวัง', en: 'Careful' },
};

function block(b, lang) {
  switch (b.t) {
    case 'h3': return `<h3>${esc(b.text)}</h3>`;
    case 'lead': return `<p class="lead">${spans(b.spans)}</p>`;
    case 'p': return `<p>${spans(b.spans)}</p>`;
    case 'ul': return `<ul class="bullets">${b.items.map((i) => `<li>${spans(i)}</li>`).join('')}</ul>`;
    // Numbered because the order is instruction, not decoration — see parse.mjs.
    case 'steps': return `<ol class="steps">${b.items.map((i) => `<li>${spans(i)}</li>`).join('')}</ol>`;
    case 'callout': {
      // The kind is carried in the class AND in a visible label. Colour alone would make the
      // difference between "tip" and "irreversible" invisible to a colour-blind reader and to print.
      const l = CALLOUT_LABEL[b.kind][lang === 'en' ? 'en' : 'th'];
      const head = b.head ? `<span class="h">${esc(b.head)}</span>` : '';
      return `<div class="callout is-${b.kind}"><span class="kind">${esc(l)}</span>${head}${spans(b.spans)}</div>`;
    }
    case 'figure':
      // src is authored relative ("img/login.png") and rewritten to an absolute, per-target path by
      // build.mjs. A relative src would resolve against the PAGE url, so the same string silently
      // means different files at /manual and /docs/manuals/*.html — and a 404 image still has
      // layout and alt text, so no gate catches it. See resolveImages().
      return `<figure><img class="shot" src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy" />`
        + (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : '') + '</figure>';
    case 'table':
      // Wrapped in its own scroller: a 3-column Thai table does not fit 320px, and the page body
      // must never scroll sideways (scripts/responsive/mobile-audit.mjs asserts exactly that).
      return '<div class="scroll-x"><table><thead><tr>'
        + b.head.map((h) => `<th>${esc(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>';
    default: throw new Error(`render: unknown block type "${b.t}"`);
  }
}

/** One section, as an <section> with a stable anchor id. */
export function renderSection(s, lang, n) {
  return `<section class="guide-section" id="${esc(s.id)}" data-lang="${esc(lang)}">`
    + `<h2><span class="n">${n}</span>${esc(s.title)}</h2>`
    + s.blocks.map((b) => block(b, lang)).join('\n')
    + '</section>';
}

/** The jump list. Rendered for both languages; the toggle hides one. */
export function renderToc(sections, lang, label) {
  return `<nav class="guide-toc" data-lang="${esc(lang)}" aria-label="${esc(label)}"><ol>`
    + sections.map((s, i) => `<li><a href="#${esc(s.id)}"><span class="n">${i + 1}</span>${esc(s.title)}</a></li>`).join('')
    + '</ol></nav>';
}

export function renderBody(sections, lang) {
  return sections.map((s, i) => renderSection(s, lang, i + 1)).join('\n');
}

export { esc };
