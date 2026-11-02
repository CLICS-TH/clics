// The fixture world the promo capture runs in (#216): a stubbed booth API serving the real case, an empty attract
// loop, and nothing from the network. capture.mjs and the harness scenario scenarios/promo.mjs both import it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const CASE_FILE = fileURLToPath(new URL('../../../backend/src/booth-cases/NFCME-2026/leptospirosis.json', import.meta.url));
export const KASE = JSON.parse(await readFile(CASE_FILE, 'utf8'));
const LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const bankFor = (path, kase = KASE) => (path === '' ? kase.banks.step1 : kase.banks[`step${path.length + 1}`][path]);

/** The video needs the same frames on every capture, so the stub asks the first variant and the bank's own option order. */
export function nextFor(path, kase = KASE) {
  const bank = bankFor(path, kase);
  const options = bank.options.filter((o) => bank.default_trio.includes(o.id)).map(({ id, label, line }) => ({ id, label, line }));
  return { ask: { variant: bank.variants[0].id, bridge: '', options: options.map((o) => o.id) }, question: bank.variants[0].question, options };
}
const pathOf = (answers) => answers.reduce((path, a) => path + ('choice' in a ? LETTER[bankFor(path).options.find((o) => o.id === a.choice).tier] : 'W'), '');
const API = 'http://localhost:3001';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
export const TAG = 42;

// Fictional replies shaped by the booth prompt (rimpl/src/lib/prompts.js RIMPL_SYSTEM_PROMPT_BOOTH): one strength and one
// thing worth weighing, no grading, no preview of a later step, no question, nothing the answer did not name.
const REPLIES = [
  'คุณเชื่อมโยงประวัติลุยน้ำท่วมเข้ากับอาการปวดน่องและตาแดงได้ตรงประเด็น สิ่งที่ควรชั่งน้ำหนักคือโรคไข้ในหน้าฝนหลายโรคมีอาการช่วงแรกคล้ายกัน',
  'ผลเลือดและปัสสาวะพื้นฐานช่วยดูการทำงานของไต ตับ และเกล็ดเลือดได้ตั้งแต่เนิ่น ๆ สิ่งที่ควรชั่งน้ำหนักคือผลเหล่านี้อาจยังปกติในวันแรกของโรค',
  'การรับไว้ในโรงพยาบาลช่วยให้เฝ้าดูอาการที่อาจแย่ลงได้ใกล้ชิด สิ่งที่ควรชั่งน้ำหนักคือภาระของการนอนโรงพยาบาลต่อผู้ป่วยและครอบครัว',
];
export const SCORE = { status: 'scored', composite: 72.4, domains: { d1: 4, d2: 4, d3: 4, d4: 3, d5: 3, d6: 3, d7: 3 } };
const at = (min) => new Date(Date.UTC(2026, 10, 3, 2, min)).toISOString();
// The visitor's row is third on both lists and carries the same score as the result card.
const entries = (tags, top) => tags.map((tag, i) => ({ tag, score: tag === TAG ? SCORE.composite : top - i * 2.9, at: at(i) }));
export const BOARD = { today: entries([7, 19, TAG, 3, 25, 11, 30, 8, 14, 2], 79.4), event: entries([7, 19, TAG, 3, 25, 11, 30, 8, 14, 2], 79.4) };

const ROUTES = {
  'GET /booth/status': () => ({ open: true, event_code: KASE.event_code }),
  'POST /booth/plays': () => ({
    play_id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', tag: TAG, case: { vignette: KASE.vignette }, answer_max_chars: 500, next: nextFor(''), sig: 'sig-0',
  }),
  'POST /booth/plays/:id/reply': ({ answers }) => ({
    status: 'replied', reply: REPLIES[answers.length - 1], reply_sig: `sig-${answers.length}`,
    ...(answers.length < 3 ? { next: nextFor(pathOf(answers)) } : {}),
  }),
  'POST /booth/plays/:id/score': () => ({ ...SCORE, rank_today: 3, rank_event: 3, board: BOARD }),
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
