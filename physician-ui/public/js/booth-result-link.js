// The result a visitor keeps (#251): the kiosk's QR opens RESULT_PATH with the play's result in the URL fragment.
// A browser never sends the fragment, so the result is in no request and nothing is stored: the link keeps working
// after the 30-day purge. The link is unsigned, so a hand-edited one shows whatever it says (a known limit of #244).
// No imports, so the harness can load this file as a data: URL like booth-bands.js.

export const RESULT_PATH = '/booth-result';

const FORMAT = 'r1.';
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const TEASER_MAX = 400;

/**
 * @typedef {{ score: number, domains: Record<string, number>, tag: number, date: string, teaser: { th: string, en: string } }} KeptResult
 *   score 0-100 (whole), domains d1-d7 at 0-5, tag the booth tag, date YYYY-MM-DD in Bangkok.
 */

/** Today's date in Bangkok, the booth's own day. */
export const boothDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);

/** @param {KeptResult} r @returns {string} the fragment, without the '#' */
export function resultFragment(r) {
  const json = JSON.stringify({ s: Math.round(r.score), d: KEYS.map((k) => r.domains[k]), t: r.tag, at: r.date, th: r.teaser.th, en: r.teaser.en });
  let bin = '';
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return FORMAT + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} origin @param {KeptResult} r */
export const resultUrl = (origin, r) => `${origin}${RESULT_PATH}#${resultFragment(r)}`;

const isScore = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const isText = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= TEASER_MAX;

/** @param {string} hash location.hash, with or without the '#' @returns {KeptResult | null} null for anything malformed */
export function parseResultFragment(hash) {
  const raw = hash.replace(/^#/, '');
  if (!raw.startsWith(FORMAT) || !/^[A-Za-z0-9_-]+$/.test(raw.slice(FORMAT.length))) return null;
  let o;
  try {
    const bin = atob(raw.slice(FORMAT.length).replace(/-/g, '+').replace(/_/g, '/'));
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
  if (!isScore(o?.s, 100) || !Array.isArray(o.d) || o.d.length !== KEYS.length || !o.d.every((v) => isScore(v, 5))
    || !Number.isInteger(o.t) || o.t < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(o.at) || Number.isNaN(Date.parse(o.at))
    || !isText(o.th) || !isText(o.en)) {
    return null;
  }
  return { score: o.s, domains: Object.fromEntries(KEYS.map((k, i) => [k, o.d[i]])), tag: o.t, date: o.at, teaser: { th: o.th, en: o.en } };
}
