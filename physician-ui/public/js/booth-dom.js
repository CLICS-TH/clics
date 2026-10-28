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
export function phrases(text) {
  const parts = text.split(/( +)/).filter((p) => p !== '');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^[\d.,]+$/.test(parts[i]) && parts[i + 2]) { out.push(parts[i] + parts[i + 1] + parts[i + 2]); i += 2; } else out.push(parts[i]);
  }
  return out.map((p) => (p.trim() === '' ? p : el('span', { class: 'ph' }, p)));
}

export const bi = (pair, cls = '') => el('span', { class: `bi ${cls}`.trim() },
  el('span', { class: 'bi-th', lang: 'th' }, ...phrases(pair.th)), el('span', { class: 'bi-en', lang: 'en' }, pair.en));
