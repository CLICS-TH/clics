/*
 * API fixtures for the manual's screenshots.
 *
 * WHY NOT REUSE scripts/readability/fixtures.mjs. That set is deliberately HOSTILE — its own header
 * says so. It carries the longest plausible Thai name, a licence number and a reviewer note about a
 * found HN, because its job is to break line-breaking and clip pills. Every one of those strings is
 * a thing the PII gate must refuse, so it is the right adversary for the gate and exactly the wrong
 * content to publish. These fixtures have the opposite brief: representative, unremarkable, and
 * publishable — pseudonyms only, no names, no licence values, no contact details.
 *
 * WHY NOT LIVE DATA. Capturing against the real product would put a physician's actual reasoning
 * into a PNG served from physician-ui/public/ — a published, undiffable artifact. The CREC082
 * privacy review exists to prevent exactly that. It would also need credentials this pipeline
 * deliberately does not hold.
 *
 * The clinical vignette below is invented. It states an age and a date, which the PII gate allows
 * on purpose (see lib/pii-gate.mjs DIRECT) — a manual that could not show a date would be useless.
 */

const iso = (daysAgo) => new Date(Date.UTC(2026, 7, 28 - daysAgo)).toISOString();

// An invented case, written the way the manual asks physicians to write one: no name, no HN, no
// hospital, no admission date. It doubles as an example of the house rule it illustrates.
const VIGNETTE = 'ผู้ป่วยชายอายุ 62 ปี เบาหวานชนิดที่ 2 มา 10 ปี มาด้วยอาการเหนื่อยง่ายขณะออกแรงมา 3 สัปดาห์ '
  + 'ตรวจพบขาบวมทั้งสองข้าง ควรประเมินภาวะหัวใจล้มเหลวอย่างไร และมีข้อควรระวังใดในการปรับยาเบาหวาน';

const ASSISTANT = 'การประเมินควรเริ่มจากแยกสาเหตุของอาการเหนื่อยระหว่างภาวะหัวใจล้มเหลว ภาวะซีด และโรคปอด '
  + 'จากนั้นจึงพิจารณาการทำงานของไตก่อนปรับยา เพราะยาเบาหวานบางกลุ่มต้องลดขนาดเมื่อการกรองของไตลดลง';

const ple = (i, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  ple_code: `PLE-${100 + i}`, status: 'evaluated',
  chief_complaint: VIGNETTE, turn_count: 9 + i, token_count: 12000 + i * 800, folder_id: 'f1',
  started_at: iso(i + 1), ended_at: iso(i), is_test: false, privacy_review_status: 'passed',
  ...extra,
});

const EVALUATION = {
  ple_id: '00000000-0000-4000-8000-000000000001', status: 'evaluated', composite_score: 78,
  d1: 4, d2: 4, d3: 4, d4: 3, d5: 4, d6: 3, d7: 4,
  domain_rationale: {
    d1: 'ตั้งคำถามเจาะจงกับจุดตัดสินใจจริงของเคส ไม่ใช่คำถามกว้าง',
    d2: 'จัดลำดับสมมติฐานพร้อมเหตุผล และทบทวนเมื่อพบข้อมูลค้าน',
    d5: 'ขอหลักฐานอ้างอิงและระบุจุดที่ยังไม่แน่ใจอย่างชัดเจน',
  },
};

export const CAPTURE_FIXTURES = [
  // ---- physician portal ------------------------------------------------------------------------
  [/\/ples\/lpdp\/me/, { snapshots: [1, 2, 3].map((i) => ({
    ple_id: `00000000-0000-4000-8000-00000000000${i}`,
    composite_score: [64, 71, 78][i - 1], snapshot_at: iso(20 - i * 7),
  })), held: 0 }],
  [/\/ples\/[^/]+\/evaluation/, EVALUATION],
  [/\/ples\/[0-9a-f-]{8,}$/, { ...ple(1), messages: [
    { role: 'physician', content: VIGNETTE, created_at: iso(1) },
    { role: 'assistant', content: ASSISTANT, created_at: iso(1) },
  ] }],
  // Bare arrays, both of them. js/dashboard.js:536 treats a non-array as an ERROR envelope and
  // renders "could not load" — so an object here produces a screenshot of a failure state.
  [/\/ples$/, [ple(1), ple(2), ple(3)]],
  [/\/folders/, [{ id: 'f1', name: 'อายุรศาสตร์ทั่วไป', ple_count: 3 }]],
  // The identity page shows its status card only for a submitted verification. `verified` is the
  // state the manual describes as the goal, and it carries no name and no licence value.
  [/\/auth\/identity\/status/, { status: 'verified', method: 'thaid', submitted_at: iso(6), decided_at: iso(5) }],
  // full_name_th is what js/dashboard.js:2 greets the reader by — and on the real product that is
  // the physician's actual name. Here it is the pseudonym, which is what a manual should show.
  [/\/auth\/me|\/me$/, { id: 'p1', role: 'physician', pseudonym: 'P-014', council_id: 'c1',
    full_name_th: 'P-014', full_name_en: 'P-014',
    consented_at: iso(30), usage_used_usd: 0.18, usage_limit_usd: 0.5 }],
  [/\/usage/, { used_usd: 0.18, limit_usd: 0.5, pct: 36 }],

  // ---- auditor console -------------------------------------------------------------------------
  // A BARE ARRAY of CleItem — app/auditor/queue/page.tsx does `Array.isArray(d) ? ... : []`, so an
  // object here renders the empty state, which is a screenshot of nothing.
  [/\/auditor\/queue/, [
    { id: '00000000-0000-4000-8000-000000000001', pseudonym: 'P-014', chief_complaint: VIGNETTE,
      turn_count: 11, token_count: 13400, ended_at: iso(2), scored: false },
    { id: '00000000-0000-4000-8000-000000000002', pseudonym: 'P-021', chief_complaint: VIGNETTE,
      turn_count: 9, token_count: 11200, ended_at: iso(4), scored: false },
    { id: '00000000-0000-4000-8000-000000000003', pseudonym: 'P-007', chief_complaint: VIGNETTE,
      turn_count: 14, token_count: 16800, ended_at: iso(7), scored: true },
  ]],
  [/\/audit\/ples\/[^/]+/, { ...ple(1), physician_pseudonym: 'P-014', messages: [
    { role: 'physician', content: VIGNETTE },
    { role: 'assistant', content: ASSISTANT },
  ] }],
];

const FALLBACK = {};

export function captureFixtureFor(url) {
  for (const [re, body] of CAPTURE_FIXTURES) if (re.test(url)) return body;
  return FALLBACK;
}
