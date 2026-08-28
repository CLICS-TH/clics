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

const cleRow = (i, status, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  cle_code: `CLE-${String(100 + i).padStart(3, '0')}`,
  status: 'evaluated', turn_count: 12 + i, token_count: 24000 + i * 900,
  started_at: iso(i + 2), ended_at: iso(i + 1),
  is_test: i % 3 === 0, privacy_review_status: status,
  ...extra,
});

export const FIXTURES = [
  // ---- physician portal ----------------------------------------------------------------------
  // The reflection page bails to the result screen unless the session is 'ended' with no reflection
  // written, so without this the FORM — one of the three screens this audit exists for — never renders.
  [/\/cles\/[^/]+\/reflection/, { status: 'ended', reflection: null }],
  [/\/cles\/acceptability/, { eligible: true, response: null, completed_ples: 3, items: [
    { key: 'q1', th: 'โดยรวมแล้ว ระบบนี้เป็นวิธีที่ยอมรับได้สำหรับการเก็บหน่วยกิตการศึกษาต่อเนื่อง', en: 'Overall, this is an acceptable way to earn continuing-education credit.' },
    { key: 'q2', th: 'การประเมินสะท้อนการคิดเชิงคลินิกของข้าพเจ้าได้อย่างเป็นธรรม', en: 'The assessment reflected my clinical reasoning fairly.' },
  ] }],
  // cle-chat redirects to the result page unless the session is 'active', so without this the chat
  // shell — which carries .msg-socratic, .msg-refs and .artifact-kind — is never measured.
  [/\/cles\/[0-9a-f-]{8,}$/, {
    id: '00000000-0000-4000-8000-000000000000', status: 'active', cle_code: 'CLE-101',
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
    cles: [
      cleRow(1, 'pending'),
      cleRow(2, 'pending', { privacy_review_note: LONG_NOTE }),
      cleRow(3, 'quarantined', { privacy_review_note: LONG_NOTE }),
      cleRow(4, 'passed', { privacy_review_note: null }),
      cleRow(5, 'excluded', { privacy_review_note: 'ตัดออกตามคำร้องขอของผู้เข้าร่วมวิจัย' }),
    ],
  }],
  [/\/admin\/cles\/[^/]+\/transcript/, {
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
  [/\/superadmin\/retention$/, {
    project_end_date: '2026-09-30', retention_years: 5, due_at: '2031-09-30', due: true,
    confirm_phrase: 'DE-IDENTIFY THE RESEARCH DATASET',
    targets: [
      { table: 'oauth_identities', action: 'delete', why: 'the identity vault — real name, email and provider id', rows: 84 },
      { table: 'identity_verifications', action: 'delete', why: 'encrypted national IDs and licence evidence', rows: 76 },
      { table: 'professionals', action: 'nullify', columns: ['full_name_th', 'full_name_en', 'email', 'license_number'],
        why: 'the row must survive so scores stay linkable to a pseudonym, but nothing on it may name a person', rows: 91 },
      { table: 'cle_pii_map', action: 'delete', why: 'the reversible pseudonymisation lookup', rows: 1240 },
    ],
    excluded: [
      { table: 'payment_info', why: 'financial records are kept under accounting rules and sit outside the research dataset' },
      { table: 'payouts', why: 'the compensation ledger is an auditable financial record, not research data, and is retained separately' },
      { table: 'audit_log', why: 'deleting the audit trail would destroy the evidence that this deletion happened' },
    ],
  }],
  [/\/superadmin\/security-reviews/, {
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
  [/\/admin\/payouts/, { rows: [], total_owed_thb: 4500, total_paid_thb: 1500 }],
  [/\/admin\/usage-settings/, { comp_rate_thb: 500, comp_cap_cles: 3, standard_usage_limit_usd: 0.5 }],
  [/\/admin\/compensation/, {
    rate_thb_per_cle: 500, cap_cles: 3, n: 9, total_thb: 4500,
    recipients: [
      { physician_id: 'p1', pseudonym: 'P-001', full_name_th: LONG_NAME_TH, completed: 3, amount_thb: 1500, has_payment_info: false },
      { physician_id: 'p2', pseudonym: 'P-002', full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', completed: 3, amount_thb: 1500, has_payment_info: true },
      { physician_id: 'p3', pseudonym: 'P-003', full_name_th: 'นายแพทย์ธนกฤต', completed: 3, amount_thb: 1500, has_payment_info: false },
    ],
  }],

  // ---- invites (the destructive Badge variant, on revoked/expired) -----------------------------
  [/\/admin\/invites$/, [
    { id: 'i1', email: 'somchai.wongcharoen@example.ac.th', role: 'physician', status: 'pending', created_at: iso(2), expires_at: iso(-5) },
    { id: 'i2', email: 'kanokwan@example.ac.th', role: 'auditor', status: 'accepted', created_at: iso(10) },
    { id: 'i3', email: 'revoked.account@example.ac.th', role: 'admin', status: 'revoked', created_at: iso(20) },
    { id: 'i4', email: 'expired.invitation@example.ac.th', role: 'physician', status: 'expired', created_at: iso(40), expires_at: iso(9) },
  ]],
  [/\/admin\/specialties/, [{ id: 's1', name_th: 'อายุรศาสตร์', name_en: 'Internal Medicine' }]],
  [/\/admin\/councils/, [{ id: 'c1', name_th: 'แพทยสภา', name_en: 'Thai Medical Council' }]],
  [/\/admin\/users/, { users: [
    { id: 'p1', pseudonym: 'P-001', full_name_th: LONG_NAME_TH, role: 'physician', status: 'active',
      specialty_name_th: 'อายุรศาสตร์', usage_usd: 0.42, usage_limit_usd: 0.5, can_audit: false },
    { id: 'p2', pseudonym: 'P-002', full_name_th: 'แพทย์หญิงกนกวรรณ ศรีสุวรรณโชติ', role: 'auditor', status: 'active',
      specialty_name_th: 'สูติศาสตร์-นรีเวชวิทยา', usage_usd: 0.49, usage_limit_usd: 0.5, can_audit: true },
  ], total: 2 }],
  [/\/admin\/overview/, { councils: 1, physicians: 28, auditors: 14, cles: 34, evaluated: 14, icc: 0.811 }],
  [/\/admin\/stats/, { by_status: { evaluated: 14, cle_flag_t2: 9, cle_fail_t1: 6, active: 5 } }],
];

// Anything under the API base that has no fixture returns an empty-but-valid envelope rather than
// hanging or 404ing, so one unmocked call cannot blank a whole page.
export const FALLBACK = { cles: [], verifications: [], reviews: [], users: [], items: [], data: [], rows: [] };

export function fixtureFor(url) {
  for (const [re, body] of FIXTURES) if (re.test(url)) return body;
  return FALLBACK;
}
