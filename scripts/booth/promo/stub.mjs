// The fixture world the promo capture runs in (#216): a stubbed booth API serving the real case, an empty attract
// loop, and nothing from the network. capture.mjs and the harness scenario scenarios/promo.mjs both import it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const CASE_FILE = fileURLToPath(new URL('../../../backend/src/booth-cases/NFCME-2026/leptospirosis.json', import.meta.url));
export const KASE = JSON.parse(await readFile(CASE_FILE, 'utf8'));
const LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const TIER = Object.fromEntries(Object.entries(LETTER).map(([name, letter]) => [letter, name]));
/** The case's step count, read from its own bank keys (backend booth-dialogue.js stepCount). */
export const STEPS = Object.keys(KASE.banks).filter((k) => /^step[1-9][0-9]*$/.test(k)).length;
/** The bank the step after `path` draws from (backend booth-dialogue.js bankEntry): step 1's one bank, then the bank
 *  keyed by the whole path so far (three steps) or by the previous tier (five steps). */
function bankFor(path, kase = KASE) {
  const level = kase.banks[`step${path.length + 1}`];
  return path === '' ? level : level[Object.hasOwn(level, path) ? path : path.slice(-1)];
}

/** The video needs the same frames on every capture, so the stub asks the first variant and the bank's own option order. */
export function nextFor(path, kase = KASE) {
  const bank = bankFor(path, kase);
  const options = bank.options.filter((o) => bank.default_trio.includes(o.id)).map(({ id, label, line }) => ({ id, label, line }));
  return { ask: { variant: bank.variants[0].id, bridge: '', options: options.map((o) => o.id) }, question: bank.variants[0].question, options };
}
const pathOf = (answers) => answers.reduce((path, a) => path + ('choice' in a ? LETTER[bankFor(path).options.find((o) => o.id === a.choice).tier] : 'W'), '');
/** The score's per-step tiers, as backend booth-dialogue.js stepTiers sends them: the answer's and each offered option's. */
const stepTiers = ({ answers, asks }) => {
  const path = pathOf(answers);
  return asks.map((ask, i) => {
    const { options } = bankFor(path.slice(0, i));
    return { tier: TIER[path[i]], options: ask.options.map((id) => ({ id, tier: options.find((o) => o.id === id).tier })) };
  });
};
const API = 'http://localhost:3001';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
export const TAG = 42;

// Fictional replies shaped by the booth prompt (rimpl/src/lib/prompts.js RIMPL_SYSTEM_PROMPT_BOOTH): one strength and one
// thing worth weighing, no grading, no preview of a later step, no question, nothing the answer did not name. One per
// step of capture.mjs's picks: scrub typhus, Weil-Felix, oral azithromycin, finish the course, phone follow-up.
const REPLIES = [
  { strength: 'คุณนึกถึงโรคติดเชื้อที่พบบ่อยในคนทำนา ซึ่งเข้ากับประวัติของผู้ป่วย', weigh: 'โรคไข้ในหน้าฝนหลายโรคมีอาการช่วงแรกคล้ายกัน', safety: '' },
  { strength: 'CBC และค่าไตช่วยดูความรุนแรงของโรคได้ตั้งแต่เนิ่น ๆ', weigh: 'ความไวของ Weil-Felix ในช่วงแรกของโรค', safety: '' },
  { strength: 'ยากินช่วยให้ผู้ป่วยกลับไปรักษาตัวที่บ้านได้', weigh: 'ความครอบคลุมของยาที่เลือกต่อโรคที่ยังเป็นไปได้', safety: '' },
  { strength: 'การให้ยาต่อจนครบช่วยให้การรักษาต่อเนื่อง', weigh: 'อาการปวดน่องที่ยังไม่หาย', safety: '' },
  { strength: 'การโทรติดตามช่วยให้รู้อาการโดยผู้ป่วยไม่ต้องเดินทาง', weigh: 'อาการอ่อนเพลียที่ยังไม่หาย', safety: '' },
];
// A five-step play's domains come from a fitted table, one decimal each (spec #370); weighted (PIS-7 weights) they give
// the composite.
export const SCORE = { status: 'scored', composite: 72.4, domains: { d1: 4.1, d2: 3.9, d3: 3.8, d4: 3.4, d5: 3.3, d6: 3.4, d7: 3.1 } };
const at = (min) => new Date(Date.UTC(2026, 10, 3, 2, min)).toISOString();
// The visitor's row is third on both lists and carries the same score as the result card.
const entries = (tags, top) => tags.map((tag, i) => ({ tag, score: tag === TAG ? SCORE.composite : top - i * 2.9, at: at(i) }));
export const BOARD = { today: entries([7, 19, TAG, 3, 25, 11, 30, 8, 14, 2], 79.4), event: entries([7, 19, TAG, 3, 25, 11, 30, 8, 14, 2], 79.4) };

const ROUTES = {
  'GET /booth/status': () => ({ open: true, event_code: KASE.event_code }),
  'POST /booth/draw': () => ({ case_id: KASE.case_id, teaser: KASE.teaser }),
  'POST /booth/plays': () => ({
    play_id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', tag: TAG, case: { vignette: KASE.vignette }, answer_max_chars: 500, next: nextFor(''), sig: 'sig-0',
    step_count: STEPS,
  }),
  'POST /booth/plays/:id/reply': ({ answers }) => ({
    status: 'replied', reply: REPLIES[answers.length - 1], reply_sig: `sig-${answers.length}`,
    ...(answers.length < STEPS ? { next: nextFor(pathOf(answers)) } : {}),
  }),
  'POST /booth/plays/:id/score': (dialogue) => ({ ...SCORE, steps: stepTiers(dialogue), rank_today: 3, rank_event: 3, board: BOARD }),
  'GET /booth/board': () => ({ board: BOARD }),
};

/**
 * Routes every request of `ctx`: the page's own files from `base`, except the attract loop, whose manifest is
 * empty and whose media never load (so no staff file can reach a frame); the booth API from ROUTES; anything
 * else is aborted. `scoreDelayMs` holds the score response so the scoring screen can be captured.
 */
export async function installStub(ctx, base, { scoreDelayMs = 0 } = {}) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.url().startsWith(base + '/')) {
      if (url.pathname === '/booth-loop/manifest.json') return route.fulfill({ status: 200, contentType: 'application/json', body: '{ "items": [] }' });
      if (url.pathname.startsWith('/booth-loop/')) return route.abort();
      return route.continue();
    }
    if (!req.url().startsWith(API + '/booth/')) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const key = `${req.method()} ${url.pathname.replace(/^\/booth\/plays\/[^/]+\/(reply|score)$/, '/booth/plays/:id/$1')}`;
    const make = ROUTES[key];
    if (!make) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    if (key.endsWith('/score') && scoreDelayMs) await new Promise((r) => setTimeout(r, scoreDelayMs));
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(make(JSON.parse(req.postData() ?? 'null'))) });
  });
}
