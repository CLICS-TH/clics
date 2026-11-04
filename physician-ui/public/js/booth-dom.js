export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
  return e;
}

/** Thai puts spaces between phrases, not words, and the browser would break inside a word (เบา|หวาน). */
export const phrases = (text) => phraseNodes(text, []);

/** Text whose `**…**` pairs mark bold runs. A run is drawn inside the phrase spans it covers, one <strong> per
 *  phrase, so bold never splits a phrase. The server sends `**` only in pairs. */
export function markedPhrases(text) {
  const segs = text.split('**');
  let plain = '';
  const bold = [];
  segs.forEach((s, i) => { if (i % 2) bold.push([plain.length, plain.length + s.length]); plain += s; });
  return phraseNodes(plain, bold);
}

function phraseNodes(text, bold) {
  const parts = text.split(/( +)/).filter((p) => p !== '');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^[\d.,]+$/.test(parts[i]) && parts[i + 2]) { out.push(parts[i] + parts[i + 1] + parts[i + 2]); i += 2; } else out.push(parts[i]);
  }
  let at = 0;
  return out.map((p) => {
    const from = at;
    at += p.length;
    return p.trim() === '' ? p : el('span', { class: 'ph' }, ...(bold.length ? boldRuns(p, from, bold) : [p]));
  });
}

/** Phrase `p`, at offset `from` of the text, cut where a bold range [start, end) begins or ends. */
function boldRuns(p, from, bold) {
  const cuts = [...new Set([0, p.length, ...bold.flat().map((k) => k - from).filter((k) => k > 0 && k < p.length)])].sort((a, b) => a - b);
  return cuts.slice(1).map((end, i) => {
    const piece = p.slice(cuts[i], end);
    return bold.some(([a, b]) => from + cuts[i] >= a && from + cuts[i] < b) ? el('strong', {}, piece) : piece;
  });
}

export const bi = (pair, cls = '') => el('span', { class: `bi ${cls}`.trim() },
  el('span', { class: 'bi-th', lang: 'th' }, ...phrases(pair.th)), el('span', { class: 'bi-en', lang: 'en' }, pair.en));
