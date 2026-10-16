/*
 * Synthetic API fixtures for the readability audit.
 *
 * WHY THIS EXISTS. The first audit run reported every dashboard screen clean, and it was wrong: with
 * no backend those pages render their empty state, so no table row, badge or reviewer note was ever
 * measured. That gap hid a real dark-mode regression in a status badge — the badge is injected from
 * API data, so it simply never appeared. A green result is only as wide as the states it rendered.
 *
 * WHY SYNTHETIC RATHER THAN A REAL BACKEND. Two reasons, in order. Auditing against real data would
 * pull actual physician transcripts into screenshots and into the audit log, which the CREC082
 * privacy review exists to prevent. And real data is not adversarial: it would not reliably contain
 * the longest plausible Thai name, or a reviewer note long enough to test wrapping.
 *
 * THE CONTENT IS DELIBERATELY HOSTILE. Thai runs here are long, use tall stacked vowel/tone
 * combinations (ป่วยเรื้อรัง, ผู้สูงอายุ), and mix Thai with Latin and digits — the combination that
 * breaks line-breaking, clips pills and separates combining marks. Short, tidy strings prove nothing.
 */

// Four levels of vertical stacking plus a long unbroken run: the two things Thai renders badly.
const LONG_TH = 'ผู้ป่วยหญิงไทยอายุ ๗๘ ปี มีภาวะหัวใจล้มเหลวเรื้อรังร่วมกับโรคไตวายระยะสุดท้าย ปฏิเสธการฟอกเลือด';
const LONG_NOTE = 'พบเลขประจำตัวผู้ป่วย (HN) ปรากฏในรอบที่ ๓ และชื่อ-นามสกุลจริงในรอบที่ ๗ — ได้แก้ไขข้อความทั้งสองจุดแล้ว '
  + 'แต่ยังคงมีรายละเอียดวันเวลาเข้ารับการรักษาที่อาจระบุตัวบุคคลได้เมื่อประกอบกับข้อมูลอื่น จึงกันออกไว้เพื่อรอการพิจารณา';
const LONG_NAME_TH = 'ศาสตราจารย์เกียรติคุณ นายแพทย์ประเสริฐศักดิ์ วงศ์เจริญรุ่งเรืองพิพัฒน์';

const iso = (daysAgo) => new Date(Date.UTC(2026, 7, 27 - daysAgo)).toISOString();

const pleRow = (i, status, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  ple_code: `PLE-${String(100 + i).padStart(3, '0')}`,
  status: 'evaluated', turn_count: 12 + i, token_count: 24000 + i * 900,
  started_at: iso(i + 2), ended_at: iso(i + 1),
  is_test: i % 3 === 0, privacy_review_status: status,
  ...extra,
});

// ---- dashboard scoring + calibration (added 2026-10-16) ----------------------------------------
// The two auditor PLE ids audit.mjs opens. OPEN has no score yet, so every DomainScorer domain shows
// "ยังไม่ให้คะแนน". REVEALED is the post-submit page: its own score sits at the extremes (0, 1, 4, 5)
// that make DomainScorer ask for a comment, and the AI score + peer average are revealed, which is
// what renders the two radars. Never real scores — the shapes mirror lib/types.ts AuditorPle.
export const AUDITOR_PLE_OPEN = '00000000-0000-4000-8000-0000000000a1';
export const AUDITOR_PLE_REVEALED = '00000000-0000-4000-8000-0000000000a2';
const AUDITOR_TRANSCRIPT = [
  { role: 'physician', content: LONG_TH },
  { role: 'assistant', content: 'การประเมินเบื้องต้นควรครอบคลุมภาวะน้ำเกิน ระดับอิเล็กโทรไลต์ และการทำงานของหัวใจ **โดยเฉพาะ** ในผู้สูงอายุที่มีโรคร่วมหลายระบบ',
    refs: [{ source: 'Thai Heart Association', title: 'แนวทางเวชปฏิบัติภาวะหัวใจล้มเหลว พ.ศ. ๒๕๖๗' }],
    socratic_question: 'ท่านคิดว่าปัจจัยใดที่ทำให้ผู้ป่วยรายนี้ปฏิเสธการฟอกเลือด และจะสำรวจเรื่องนี้อย่างไร' },
  { role: 'physician', content: 'ผู้ป่วยกังวลเรื่องภาระค่าใช้จ่ายของครอบครัวและการเดินทางมาฟอกเลือดสัปดาห์ละสามครั้ง' },
];
const MY_SCORES = { d1: 5, d2: 4, d3: 3, d4: 1, d5: 0, d6: 2, d7: 4 };
const AI_SCORES = { d1: 4, d2: 4, d3: 2, d4: 3, d5: 2, d6: 3, d7: 3 };
const PEER_AVG = { d1: 4.5, d2: 3.5, d3: 3, d4: 2, d5: 1.5, d6: 2.5, d7: 3.5 };
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const anchorsOf = (v) => Object.fromEntries(DOMAINS.map((k, i) => [`${k}_anchor`, v[i % v.length]]));

// An ICC stat with its interval; `interpretation` is the server's label.
const icc = (v, n = 8, w = 0.18) => ({ icc: v, lower: +(v - w).toFixed(3), upper: +Math.min(0.99, v + w / 2).toFixed(3), n,
  interpretation: v >= 0.95 ? 'Excellent' : v >= 0.85 ? 'Good' : v >= 0.75 ? 'Moderate' : 'Poor — ต่ำกว่าเกณฑ์' });
const perDomain = (base) => Object.fromEntries(DOMAINS
  .map((k, i) => [k, icc(+(base + (i % 2 ? -0.09 : 0.06) * (i % 3)).toFixed(3))]));
const verdict = (state, v) => ({ state, threshold: 0.75, icc: v, lower: +(v - 0.18).toFixed(3), upper: +(v + 0.09).toFixed(3), n: 8,
  why: state === 'pass' ? 'ขอบล่างของช่วงความเชื่อมั่นอยู่เหนือเกณฑ์ / the lower bound clears the threshold'
    : state === 'fail' ? 'ขอบบนของช่วงความเชื่อมั่นต่ำกว่าเกณฑ์ / the upper bound is below the threshold'
      : 'ช่วงความเชื่อมั่นคร่อมเกณฑ์ ยังสรุปไม่ได้ / the interval spans the threshold — not yet decidable' });
const ICC_DATA = {
  overall: icc(0.71, 14), per_domain: perDomain(0.74), n: 14,
  min_auditors: 2, auditors_per_cle: { 1: 6, 2: 8 }, n_at_target: 8, n_below_target: 6,
  inter_auditor: { ...icc(0.66, 8), model: 'ICC(1,1)', n_ratings: 16, k0: 2 },
  inter_auditor_average: { ...icc(0.79, 8), model: 'ICC(A,k)', model_alt: 'ICC(2,k)', k: 2 },
  inter_auditor_note: 'ผู้ตรวจแต่ละคนได้รับ PLE ไม่เท่ากัน จึงรายงานทั้งสองแบบ / raters were not crossed, so both models are reported',
  inter_auditor_per_domain: perDomain(0.62),
  weighted_kappa: {
    pooled: { kappa: 0.58, n: 98, weights: 'quadratic', exact_agreement: 0.41, interpretation: 'Moderate' },
    domains: Object.fromEntries(DOMAINS
      .map((k, i) => [k, { kappa: +(0.4 + 0.06 * i).toFixed(2), n: 14, interpretation: i < 3 ? 'Fair' : 'Moderate' }])),
  },
};

export const FIXTURES = [
  // Ahead of the portal's generic /ples/<uuid> entry below, which would otherwise answer these.
  [new RegExp(`/auditor/ples/${AUDITOR_PLE_OPEN}(\\?|$)`), { messages: AUDITOR_TRANSCRIPT, audit_score: null }],
  [new RegExp(`/auditor/ples/${AUDITOR_PLE_REVEALED}(\\?|$)`), {
    messages: AUDITOR_TRANSCRIPT,
    audit_score: { ...MY_SCORES, ...anchorsOf(['clear', 'moderate', 'ambiguous']),
      notes: 'คะแนนต่ำในหมวดการสื่อสาร เนื่องจากไม่ได้สำรวจความกังวลของผู้ป่วยก่อนเสนอทางเลือก' },
    ai_evaluation: { composite_score: 61.4, ...AI_SCORES, domain_rationale: null,
      provenance: { consistency: { method: 'median3', rule: 'median', calls: 3, max_delta: 6, per_call_scores: [58, 61.4, 64] } } },
    peer_avg: PEER_AVG, peer_n: 2, reveal_locked: false,
  }],
  [/\/auditor\/ples\/[^/]+\/discussion/, [
    { role: 'auditor', content: 'ทำไม AI จึงให้หมวด d5 สูงกว่าที่ข้าพเจ้าให้ ทั้งที่แพทย์ไม่ได้ถามเรื่องความกังวลของผู้ป่วยเลย' },
    { role: 'assistant', content: 'ในบทสนทนารอบที่ ๓ แพทย์ได้กล่าวถึงภาระของครอบครัว ซึ่ง AI ตีความว่าเป็นการสำรวจบริบทของผู้ป่วยบางส่วน **แต่ยังไม่ครบ** ตามเกณฑ์ระดับ ๓' },
  ]],
  // The auditor home: both calibration radars render only when n > 0 and both series are present.
  [/\/auditor\/calibration/, { n: 6, auditor: MY_SCORES, ai: AI_SCORES, peer: PEER_AVG, locked: false }],
  [/\/auditor\/icc/, { icc: 0.71, n: 6 }],

  // ---- oversight (analyst / ethics / superadmin) ---------------------------------------------
  // ThreeWayIcc. ples_all_three = 8 (< SMALL_SAMPLE 10) renders the small-sample note, and a 0.97
  // contract rate (between CONTRACT_WARN and CONTRACT_OK) renders the amber rate — the two raw-palette
  // amber sites in that component. Verdicts of two kinds, so "fail" and "not yet decidable" are both
  // on screen. Must precede /oversight/icc below.
  [/\/oversight\/icc\/three-way/, {
    arms: {
      ai_vs_human: { overall: icc(0.81), per_domain: perDomain(0.8), n: 8, verdict: verdict('insufficient', 0.81) },
      shadow_vs_human: { overall: icc(0.58), per_domain: perDomain(0.6), n: 7, verdict: verdict('fail', 0.58) },
      ai_vs_shadow: { overall: icc(0.9), per_domain: perDomain(0.88), n: 8 },
    },
    coverage: { ples_with_human: 14, ples_with_ai: 30, ples_with_shadow: 9, ples_all_three: 8,
      shadow_failed: 1, shadow_contract_rate: 0.97, shadow_scored_corpus: 33, shadow_failed_corpus: 1,
      shadow_contract_rate_corpus: 0.97 },
    shadow: { available: true, provider: 'vllm', model_version: 'deepseek-v3.1-local@2026-09' },
  }],
  [/\/oversight\/icc(\?|$)/, ICC_DATA],
  [/\/admin\/icc(\?|$)/, ICC_DATA],
  [/\/oversight\/stats/, { counts: { ple_pass: 9, ple_fail_t1: 3, ple_flag_t2: 4, evaluated: 14, ended: 2, active: 5 }, total: 37 }],
  [/\/oversight\/rater-spread/, {
    ok: true, n_scores: 22, n_episodes: 14, n_auditors: 3, n_multi_rated_episodes: 8,
    between_episodes: { sd: 2.44, min: 52, max: 80, range: 28 },
    comparison_on_shared: { n: 8, human_sd: 2.44, ai_sd: 9.84, human_range: 6, ai_range: 20 },
    gate: { measurable: true, why: null, sd_error: 2.69, sd_between_observed: 2.44, sd_between_required: 4.66, meets: false },
    scale_use: { min: 52, max: 80, span_pct_of_scale: 28 },
    per_domain: Object.fromEntries(DOMAINS
      .map((k, i) => [k, { n: 22, sd: i < 2 ? 0 : 0.8, modal_value: 4, modal_share: i < 2 ? 1 : 0.6, distinct: i < 2 ? 1 : 3 }])),
    anchor_clarity: Object.fromEntries(DOMAINS
      .map((k, i) => [k, { answered: 8, unanswered: 14, clear: 4, moderate: 2 + (i % 2), ambiguous: 2 - (i % 2), ambiguous_share: 0.25 }])),
    scored_between: { first: iso(40), last: iso(1) },
    per_auditor: [
      { auditor_id: 'a1', n: 9, mean: 66.2, sd: 3.21, min: 52, max: 80 },
      { auditor_id: 'a2', n: 8, mean: 64.0, sd: 2.1, min: 58, max: 71 },
      { auditor_id: 'a3', n: 5, mean: 70.5, sd: 0, min: 70.5, max: 70.5 },
    ],
  }],

  // ---- integrity queue ----------------------------------------------------------------------
  // GET /admin/integrity-queue?severity= (app/admin/integrity/page.tsx). Without it the page measured its
  // empty state, "No sessions are flagged", on all 8 renders. The first row is the prose session's
  // fixture verbatim (CLICS-wt-prose); the two after it make the card-level badge show all three
  // severities and render the outline "test" badge.
  // One session carrying every signal, so each signal's explanatory note renders.
  [/\/admin\/integrity-queue/, { ples: [{ id: 'i-1', ple_code: 'PLE-301', status: 'evaluated', ended_at: iso(2), turn_count: 14, flags: [
    { signal: 'F1_NEAR_DUPLICATE', severity: 'medium', created_at: iso(2), evidence: { pairs: 2 } },
    { signal: 'F2_CROSS_SESSION_REUSE', severity: 'low', created_at: iso(2), evidence: { other_ple_id: '33333333-3333-4333-8333-333333333333' } },
    { signal: 'F3_PASTE_BURST', severity: 'high', created_at: iso(2), evidence: { chars: 1800, genre: { clinical_density: 12, discourse_density: 1, markdown_marks: 0 } } },
    { signal: 'F5_LATENCY_UNIFORMITY', severity: 'medium', created_at: iso(2), evidence: { cv: 0.04 } },
    { signal: 'F6_REGISTER_DISCONTINUITY', severity: 'medium', created_at: iso(2), evidence: { shifted_features: [{ feature: 'discourse', value: 3.21, z: 4.4 }] } },
    { signal: 'S1_PHYSICIAN_REPORTED_REPLY', severity: 'high', created_at: iso(2), evidence: { report_count: 1, reports: [
      { message_id: '11111111-1111-4111-8111-111111111111', reason: 'unsafe_advice', note: 'ขนาดยาที่แนะนำสูงเกินไปสิบเท่า', turn: 3, provider: 'local', model: 'deepseek-v4', reported_at: iso(2) }] } },
  ] },
  { id: 'i-2', ple_code: 'PLE-302', status: 'evaluated', ended_at: iso(4), turn_count: 9, is_test: true, flags: [
    { signal: 'F1_NEAR_DUPLICATE', severity: 'medium', created_at: iso(4), evidence: { pairs: 1 } },
    { signal: 'F2_CROSS_SESSION_REUSE', severity: 'low', created_at: iso(4), evidence: { other_ple_id: '44444444-4444-4444-8444-444444444444' } },
  ] },
  { id: 'i-3', ple_code: 'PLE-303', status: 'evaluated', ended_at: iso(6), turn_count: 21, is_test: false, flags: [
    { signal: 'F2_CROSS_SESSION_REUSE', severity: 'low', created_at: iso(6), evidence: { other_ple_id: '55555555-5555-4555-8555-555555555555' } },
  ] }] }],

  // ---- QA queue + physician profile ----------------------------------------------------------
  // C4–C6 mixed pass/fail: a failing flag is the small red "C5:" label.
  [/\/admin\/ples\/flagged/, [
    { id: 'f1', status: 'ple_flag_t2', started_at: iso(3), turn_count: 18, token_count: 40200,
      c4_pass: true, c5_pass: false, c6_pass: true, professionals: { full_name_th: LONG_NAME_TH } },
    { id: 'f2', status: 'ple_flag_t2', started_at: iso(5), turn_count: 7, token_count: 12100,
      c4_pass: false, c5_pass: false, c6_pass: false, professionals: { full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ' } },
  ]],
  [/\/admin\/physicians\/[^/]+\/profile/, {
    physician: { full_name_th: LONG_NAME_TH, pseudonym: 'P-001', specialty: 'อายุรศาสตร์' },
    lpdp: [{ composite_score: 58 }, { composite_score: 66.5 }, { composite_score: 71 }, { composite_score: 79.5 }],
    sessions: [
      { id: 's1', status: 'evaluated', chief_complaint: LONG_TH, folder_name: 'หัวใจล้มเหลว', started_at: iso(30), turn_count: 14,
        ai: { composite_score: 71 }, audits: [{ composite_score: 66, auditor_name: 'P-011' }] },
      { id: 's2', status: 'ple_flag_t2', chief_complaint: 'เจ็บหน้าอกร้าวไปแขนซ้าย', started_at: iso(12), turn_count: 9, ai: null, audits: [] },
    ],
  }],

  // ---- physician portal ----------------------------------------------------------------------
  // The reflection page bails to the result screen unless the session is 'ended' with no reflection
  // written, so without this the FORM — one of the three screens this audit exists for — never renders.
  [/\/ples\/[^/]+\/reflection/, { status: 'ended', reflection: null }],
  [/\/ples\/acceptability/, { eligible: true, response: null, completed_ples: 3, items: [
    { key: 'q1', th: 'โดยรวมแล้ว ระบบนี้เป็นวิธีที่ยอมรับได้สำหรับการเก็บหน่วยกิตการศึกษาต่อเนื่อง', en: 'Overall, this is an acceptable way to earn continuing-education credit.' },
    { key: 'q2', th: 'การประเมินสะท้อนการคิดเชิงคลินิกของข้าพเจ้าได้อย่างเป็นธรรม', en: 'The assessment reflected my clinical reasoning fairly.' },
  ] }],
  // ple-chat redirects to the result page unless the session is 'active', so without this the chat
  // shell — which carries .msg-socratic, .msg-refs and .artifact-kind — is never measured.
  [/\/ples\/[0-9a-f-]{8,}$/, {
    id: '00000000-0000-4000-8000-000000000000', status: 'active', ple_code: 'PLE-101',
    chief_complaint: LONG_TH, started_at: iso(0), turn_count: 4, token_count: 9200,
    messages: [
      { role: 'physician', content: LONG_TH, created_at: iso(0) },
      { role: 'assistant', created_at: iso(0),
        content: 'การประเมินเบื้องต้นควรครอบคลุมภาวะน้ำเกิน ระดับอิเล็กโทรไลต์ และการทำงานของหัวใจ โดยเฉพาะในผู้สูงอายุที่มีโรคร่วมหลายระบบ',
        refs: [{ source: 'Thai Heart Association', title: 'แนวทางเวชปฏิบัติภาวะหัวใจล้มเหลว พ.ศ. ๒๕๖๗', year: 2567 }],
        socratic_question: 'ท่านคิดว่าปัจจัยใดที่ทำให้ผู้ป่วยรายนี้ปฏิเสธการฟอกเลือด และท่านจะสำรวจเรื่องนี้กับผู้ป่วยอย่างไร' },
    ],
  }],
  [/\/auth\/identity\/status/, { status: 'rejected', reject_reason: 'ชื่อบนใบอนุญาตไม่ตรงกับชื่อที่ลงทะเบียนไว้ในระบบ กรุณาตรวจสอบและส่งเอกสารยืนยันเพิ่มเติมอีกครั้ง', license_number: 'ว.๑๒๓๔๕' }],

  // ---- privacy review ------------------------------------------------------------------------
  [/\/admin\/privacy-queue/, {
    ples: [
      pleRow(1, 'pending'),
      pleRow(2, 'pending', { privacy_review_note: LONG_NOTE }),
      pleRow(3, 'quarantined', { privacy_review_note: LONG_NOTE }),
      pleRow(4, 'passed', { privacy_review_note: null }),
      pleRow(5, 'excluded', { privacy_review_note: 'ตัดออกตามคำร้องขอของผู้เข้าร่วมวิจัย' }),
    ],
  }],
  [/\/admin\/ples\/[^/]+\/transcript/, {
    messages: [
      { role: 'physician', content: LONG_TH },
      { role: 'assistant', content: `การประเมินเบื้องต้นควรครอบคลุมภาวะน้ำเกิน ระดับอิเล็กโทรไลต์ และการทำงานของหัวใจ **โดยเฉพาะ** ในผู้สูงอายุ\n\n| ประเด็น | ข้อพิจารณา |\n|---|---|\n| ภาวะน้ำเกิน | ชั่งน้ำหนักทุกวัน |\n| อิเล็กโทรไลต์ | ติดตามโพแทสเซียม |`,
        refs: [{ source: 'Thai Heart Association', title: 'แนวทางเวชปฏิบัติภาวะหัวใจล้มเหลว พ.ศ. ๒๕๖๗' }],
        socratic_question: 'ท่านคิดว่าปัจจัยใดที่ทำให้ผู้ป่วยรายนี้ปฏิเสธการฟอกเลือด และจะสำรวจเรื่องนี้อย่างไร' },
    ],
  }],

  // ---- identity ------------------------------------------------------------------------------
  [/\/admin\/identity-queue/, {
    verifications: [
      { id: 'v1', professional_id: 'p1', method: 'national_id_license', status: 'pending',
        national_id_last4: '4821', license_number: 'ว.๑๒๓๔๕', license_check_status: 'verified',
        license_check_source: 'tmc_scrape', submitted_at: iso(2),
        professionals: { full_name_th: LONG_NAME_TH, full_name_en: 'Prof. Prasertsak Wongcharoenrungruangpipat', pseudonym: 'P-001' } },
      { id: 'v2', professional_id: 'p2', method: 'national_id_license', status: 'pending',
        national_id_last4: '0093', license_number: 'ว.๙๙๙', license_check_status: 'name_mismatch',
        license_check_source: 'tmc_scrape', submitted_at: iso(3),
        professionals: { full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', pseudonym: 'P-002' } },
      { id: 'v3', professional_id: 'p3', method: 'thaid', status: 'pending',
        national_id_last4: '7715', license_check_status: 'not_found', submitted_at: iso(4),
        professionals: { full_name_th: 'นายแพทย์ธนกฤต', pseudonym: 'P-003' } },
      { id: 'v4', professional_id: 'p4', method: 'national_id_license', status: 'rejected',
        national_id_last4: '1102', license_check_status: 'unavailable', submitted_at: iso(9),
        decided_at: iso(8), reject_reason: 'ชื่อบนใบอนุญาตไม่ตรงกับชื่อที่ลงทะเบียน กรุณาส่งเอกสารยืนยันเพิ่มเติม',
        professionals: { full_name_th: 'นายแพทย์สมชาย', pseudonym: 'P-004' } },
    ],
  }],

  // ---- governance ----------------------------------------------------------------------------
  // due:true on purpose — the destructive control is disabled until the deadline passes, and a
  // disabled control is exempt from contrast, so leaving it locked would skip the thing worth testing.
  // The page calls /admin/* (app/admin/governance/page.tsx); these were keyed /superadmin/*, so the
  // gate rendered governance with the empty fallback and measured neither table.
  [/\/admin\/retention(\?|$)/, {
    project_end_date: '2026-09-30', retention_years: 5, due_at: '2031-09-30', due: true,
    confirm_phrase: 'DE-IDENTIFY THE RESEARCH DATASET',
    targets: [
      { table: 'oauth_identities', action: 'delete', why: 'the identity vault — real name, email and provider id', rows: 84 },
      { table: 'identity_verifications', action: 'delete', why: 'encrypted national IDs and licence evidence', rows: 76 },
      { table: 'professionals', action: 'nullify', columns: ['full_name_th', 'full_name_en', 'email', 'license_number'],
        why: 'the row must survive so scores stay linkable to a pseudonym, but nothing on it may name a person', rows: 91 },
      { table: 'ple_pii_map', action: 'delete', why: 'the reversible pseudonymisation lookup', rows: 1240 },
    ],
    excluded: [
      { table: 'payment_info', why: 'financial records are kept under accounting rules and sit outside the research dataset' },
      { table: 'payouts', why: 'the compensation ledger is an auditable financial record, not research data, and is retained separately' },
      { table: 'audit_log', why: 'deleting the audit trail would destroy the evidence that this deletion happened' },
    ],
  }],
  [/\/admin\/security-reviews/, {
    reviews: [
      { id: 'r1', period_month: '2026-08-01', reviewed_at: iso(1), incidents_found: true,
        access_review: 'ทบทวนสิทธิ์การเข้าถึงทั้งหมด ๙๑ บัญชี พบบัญชีผู้ตรวจประเมินที่หมดสัญญาแล้ว ๒ บัญชี และได้ระงับการเข้าถึงเรียบร้อยแล้ว',
        audit_review: 'ตรวจสอบ audit log ย้อนหลัง ๓๐ วัน ไม่พบรูปแบบการเข้าถึงที่ผิดปกติ',
        incident_review: 'พบเหตุการณ์ที่ผู้ใช้ส่งข้อมูลระบุตัวผู้ป่วยเข้าระบบ ๑ ครั้ง ระบบกรองออกได้ตามปกติ และได้แจ้งเตือนผู้ใช้แล้ว' },
      { id: 'r2', period_month: '2026-07-01', reviewed_at: iso(31), incidents_found: false,
        access_review: 'ไม่มีการเปลี่ยนแปลงสิทธิ์', audit_review: 'ปกติ', incident_review: 'ไม่พบเหตุการณ์' },
    ],
  }],

  // ---- auditor queue -------------------------------------------------------------------------
  [/\/auditor\/queue/, [
    { id: 'q1', ended_at: iso(1), turn_count: 14, token_count: 31200, scored: false, pseudonym: 'P-011', chief_complaint: LONG_TH },
    { id: 'q2', ended_at: iso(3), turn_count: 9, token_count: 18400, scored: true, pseudonym: 'P-012' },
    { id: 'q3', ended_at: iso(6), turn_count: 22, token_count: 52900, scored: false, pseudonym: 'P-013' },
  ]],

  // ---- compensation (the amber "outstanding" stat) --------------------------------------------
  // GET /admin/payouts is a PayoutReport (lib/types.ts). This was `{ rows, total_owed_thb, … }`, a
  // shape the page never reads — and the page only fetches it as superadmin, which the gate never
  // rendered (it redirected to /home), so the amber "outstanding" stat it was written for never drew.
  [/\/admin\/payouts(\?|$)/, { rate_thb_per_cle: 500, cap_cles: 3, n: 3, recipients: [
    { physician_id: 'p1', name: LONG_NAME_TH, pseudonym: 'P-001', completed_cles: 3, owed_thb: 1500, paid_thb: 0,
      outstanding_thb: 1500, has_payment_info: false, account_masked: null },
    { physician_id: 'p2', name: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', pseudonym: 'P-002', completed_cles: 3, owed_thb: 1500,
      paid_thb: 1500, outstanding_thb: 0, has_payment_info: true, account_masked: 'xxx-x-x4821-x' },
    { physician_id: 'p3', name: 'นายแพทย์ธนกฤต', pseudonym: 'P-003', completed_cles: 2, owed_thb: 1000, paid_thb: 0,
      outstanding_thb: 1000, has_payment_info: true, account_masked: 'PromptPay ••••6612' },
  ] }],
  // One settings object serves compensation (comp_*), users and overview (the UsageSettings keys).
  // The pool sits at 92% so the users page's >= 90% red figure renders.
  [/\/admin\/usage-settings/, { comp_rate_thb: 500, comp_cap_cles: 3, standard_usage_limit_usd: 0.5,
    standard_limit_usd: 0.5, auditor_standard_limit_usd: 0.5, api_budget_pool_usd: 50, total_used_usd: 46.2,
    auditor_api_budget_pool_usd: 10, auditor_total_used_usd: 3.1 }],
  // The superadmin user page's slot pools. Each must be an ARRAY: the fallback envelope reached
  // `(s ?? []).map` and took the page down to the error boundary. remaining 0 renders the red count.
  [/\/admin\/slots(\?|$)/, [
    { role: 'physician', capacity: 100, used: 28, remaining: 72 }, { role: 'auditor', capacity: 14, used: 14, remaining: 0 },
    { role: 'admin', capacity: 5, used: 2, remaining: 3 }, { role: 'superadmin', capacity: 1, used: 1, remaining: 0 },
  ]],
  [/\/admin\/council-slots/, [{ council_id: 'c1', code: 'TMC', name_th: 'แพทยสภา', name_en: 'Thai Medical Council', slots: [
    { role: 'admin', capacity: 2, used: 2, remaining: 0 }, { role: 'auditor', capacity: 14, used: 9, remaining: 5 },
  ] }]],
  [/\/admin\/auditor-requests/, [
    { id: 'ar1', email: 'kanokwan@example.ac.th', created_at: iso(2), full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ' },
  ]],
  [/\/admin\/compensation/, {
    rate_thb_per_cle: 500, cap_cles: 3, n: 9, total_thb: 4500,
    recipients: [
      { physician_id: 'p1', pseudonym: 'P-001', full_name_th: LONG_NAME_TH, completed: 3, amount_thb: 1500, has_payment_info: false },
      { physician_id: 'p2', pseudonym: 'P-002', full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', completed: 3, amount_thb: 1500, has_payment_info: true },
      { physician_id: 'p3', pseudonym: 'P-003', full_name_th: 'นายแพทย์ธนกฤต', completed: 3, amount_thb: 1500, has_payment_info: false },
    ],
  }],

  // ---- invites (the destructive Badge variant, on revoked/expired) -----------------------------
  [/\/admin\/invites(\?|$)/, [
    { id: 'i1', email: 'somchai.wongcharoen@example.ac.th', role: 'physician', status: 'pending', created_at: iso(2), expires_at: iso(-5) },
    { id: 'i2', email: 'kanokwan@example.ac.th', role: 'auditor', status: 'accepted', created_at: iso(10) },
    { id: 'i3', email: 'revoked.account@example.ac.th', role: 'admin', status: 'revoked', created_at: iso(20) },
    { id: 'i4', email: 'expired.invitation@example.ac.th', role: 'physician', status: 'expired', created_at: iso(40), expires_at: iso(9) },
  ]],
  [/\/admin\/specialties/, [{ id: 's1', name_th: 'อายุรศาสตร์', name_en: 'Internal Medicine' }]],
  [/\/admin\/councils/, [{ id: 'c1', name_th: 'แพทยสภา', name_en: 'Thai Medical Council' }]],
  // apiFetchPaged (lib/api.ts) accepts a bare ARRAY only — anything else is logged as a failure and
  // rendered as an empty page. This was `{ users: [...] }`, so /admin/users measured no rows.
  [/\/admin\/users(\?|$)/, [
    { id: 'p1', pseudonym: 'P-001', full_name_th: LONG_NAME_TH, role: 'physician', status: 'active',
      specialty_name_th: 'อายุรศาสตร์', usage_usd: 0.42, usage_limit_usd: 0.5, can_audit: false },
    { id: 'p2', pseudonym: 'P-002', full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', role: 'auditor', status: 'active',
      specialty_name_th: 'สูติศาสตร์-นรีเวชวิทยา', usage_usd: 0.49, usage_limit_usd: 0.5, can_audit: true },
  ]],
  // The overview page fetches /admin/overview-counts (CountRow[]), never /admin/overview. This entry
  // was keyed /admin\/overview/, which also matched -counts and handed the page an object.
  [/\/admin\/overview-counts/, [
    { council_id: 'c1', role: 'physician', n: 28 }, { council_id: 'c1', role: 'auditor', n: 14 },
    { council_id: 'c1', role: 'admin', n: 2 },
  ]],
  [/\/admin\/stats/, { by_status: { evaluated: 14, ple_flag_t2: 9, ple_fail_t1: 6, active: 5 } }],
];

// Anything under the API base that has no fixture returns an empty-but-valid envelope rather than
// hanging or 404ing, so one unmocked call cannot blank a whole page.
export const FALLBACK = { ples: [], verifications: [], reviews: [], users: [], items: [], data: [], rows: [] };

export function fixtureFor(url) {
  for (const [re, body] of FIXTURES) if (re.test(url)) return body;
  return FALLBACK;
}
