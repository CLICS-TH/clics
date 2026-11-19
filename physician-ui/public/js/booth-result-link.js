// The result a visitor keeps (#251): the kiosk's QR opens RESULT_PATH with the play's result in the URL fragment.
// A browser never sends the fragment, so the result is in no request and nothing is stored: the link keeps working
// after the 30-day purge. The link is unsigned, so a hand-edited one shows whatever it says (a known limit of #244).
// One import, booth-copy.js (itself import-free), so the harness can still load this file as a data: URL.
import { TIERS, LOOKS, DEFAULT_LOOK, isDomainScore } from './booth-copy.js';

export const RESULT_PATH = '/booth-result';

const FORMAT = 'r1.';
// r2 (#step explanations) names the case instead of carrying its teaser, and each step's variant, pick and best option
// offered: the page reads their text from /booth-steps/<case_id>.js, so the QR holds far fewer bytes than r1's teaser.
const FORMAT2 = 'r2.';
const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A case version as tree-schema.js writes it, safe inside a file name. */
export const CASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const PICK = /^([A-Za-z0-9_-]{1,16})\.([A-Za-z0-9_-]{0,16})\.([A-Za-z0-9_-]{0,16})$/;
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const TEASER_MAX = 400;
const TIER_NAMES = Object.keys(TIERS);
const PATH = new RegExp(`^[${TIER_NAMES.map((n) => TIERS[n].letter).join('')}]{1,5}$`);

/**
 * @typedef {{ score: number, domains: Record<string, number>, tag: number, date: string, teaser: { th: string, en: string },
 *   tiers: string[] | null, look: string, caseId: string | null, caseVersion: string | null, picks: Pick[] | null }} KeptResult
 *   score 0-100 (whole), domains d1-d7 at 0-5 (one decimal from a five-step play), tag the booth tag, date YYYY-MM-DD in
 *   Bangkok, tiers each step's tier name (TIERS), one per step, so their count is the play's step count; null on a link
 *   made before tiers were kept (3-4 Nov) or when the score carried none. look the
 *   kiosk's language look when the QR was drawn (LOOKS); a link made before looks (#377) reads as DEFAULT_LOOK.
 *   An r2 link has caseId and caseVersion and no teaser (null): the page reads it from that version's step text, so an
 *   edited case never relabels an old link. picks, one per step, is
 *   null on an r1 link or when the kiosk had no tiers.
 * @typedef {{ variant: string, chosen: string | null, best: string | null }} Pick
 *   chosen null for a typed answer; best the offered option whose tier is best, null when none was offered.
 */

/** Today's date in Bangkok, the booth's own day. */
export const boothDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);

/** @param {KeptResult} r @returns {string} the fragment, without the '#' */
export function resultFragment(r) {
  if (r.caseId && r.caseVersion) return FORMAT2 + b64(JSON.stringify({ s: Math.round(r.score), d: KEYS.map((k) => r.domains[k]), t: r.tag, at: r.date, c: r.caseId, v: r.caseVersion,
    ...(r.tiers?.length ? { p: r.tiers.map((n) => TIERS[n].letter).join('') } : {}),
    ...(r.tiers?.length && r.picks?.length === r.tiers.length ? { a: r.picks.map((k) => `${k.variant}.${k.chosen ?? ''}.${k.best ?? ''}`).join(',') } : {}),
    l: r.look }));
  const json = JSON.stringify({ s: Math.round(r.score), d: KEYS.map((k) => r.domains[k]), t: r.tag, at: r.date, th: r.teaser.th, en: r.teaser.en,
    ...(r.tiers?.length ? { p: r.tiers.map((n) => TIERS[n].letter).join('') } : {}), l: r.look });
  return FORMAT + b64(json);
}

function b64(json) {
  let bin = '';
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} origin @param {KeptResult} r */
export const resultUrl = (origin, r) => `${origin}${RESULT_PATH}#${resultFragment(r)}`;

const isScore = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const isText = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= TEASER_MAX;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** @param {string} hash location.hash, with or without the '#' @returns {KeptResult | null} null for anything malformed */
export function parseResultFragment(hash) {
  const raw = hash.replace(/^#/, '');
  const r2 = raw.startsWith(FORMAT2);
  if (!(r2 || raw.startsWith(FORMAT)) || !/^[A-Za-z0-9_-]+$/.test(raw.slice(FORMAT.length))) return null;
  let o;
  try {
    const bin = atob(raw.slice(FORMAT.length).replace(/-/g, '+').replace(/_/g, '/'));
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || !isScore(o.s, 100) || !Array.isArray(o.d) || o.d.length !== KEYS.length
    || !o.d.every(isDomainScore) || !Number.isInteger(o.t) || o.t < 1 || !isDate(o.at)
    || (r2 ? !(typeof o.c === 'string' && CASE_ID.test(o.c) && typeof o.v === 'string' && CASE_VERSION.test(o.v)) || 'th' in o || 'en' in o : !isText(o.th) || !isText(o.en))
    || ('a' in o && !(r2 && typeof o.a === 'string' && typeof o.p === 'string' && o.a.split(',').length === o.p.length && o.a.split(',').every((x) => PICK.test(x))))
    || ('p' in o && !(typeof o.p === 'string' && PATH.test(o.p))) || ('l' in o && !(typeof o.l === 'string' && Object.hasOwn(LOOKS, o.l)))) {
    return null;
  }
  const pick = (x) => { const [, variant, chosen, best] = PICK.exec(x); return { variant, chosen: chosen || null, best: best || null }; };
  return { score: o.s, domains: Object.fromEntries(KEYS.map((k, i) => [k, o.d[i]])), tag: o.t, date: o.at, teaser: r2 ? null : { th: o.th, en: o.en },
    tiers: 'p' in o ? [...o.p].map((c) => TIER_NAMES.find((n) => TIERS[n].letter === c)) : null, look: 'l' in o ? o.l : DEFAULT_LOOK,
    caseId: r2 ? o.c : null, caseVersion: r2 ? o.v : null, picks: 'a' in o ? o.a.split(',').map(pick) : null };
}
