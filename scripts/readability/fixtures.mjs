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
const D7 = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const byDomain = (vals) => Object.fromEntries(D7.map((k, i) => [k, vals[i]]));
const iccStat = (icc, n = 24) => ({ icc, lower: +(icc - 0.1).toFixed(3), upper: +(icc + 0.05).toFixed(3), n, interpretation: icc >= 0.75 ? 'Good' : 'Below target' });

const pleRow = (i, status, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  ple_code: `PLE-${String(100 + i).padStart(3, '0')}`,
  status: 'evaluated', turn_count: 12 + i, token_count: 24000 + i * 900,
  started_at: iso(i + 2), ended_at: iso(i + 1),
  is_test: i % 3 === 0, privacy_review_status: status,
  ...extra,
});

export const FIXTURES = [
  // ---- auditor scoring (/auditor/ples/:id) ---------------------------------------------------
  // FIRST, because the physician-session pattern below (/ples/<uuid>$) would otherwise answer these
  // too. .a1 is unscored: the transcript with its Socratic questions, the scorer's instructions and
  // evidence rule. .a2 is scored with the AI revealed and a peer average, so both radar conclusions
  // render, and its tutor chat is empty, so the example-question prompt renders.
  [/\/auditor\/ples\/[^/]+\/discussion/, []],
  [/\/auditor\/ples\/[0-9a-f-]+a1$/, { messages: [
    { role: 'physician', content: LONG_TH },
    { role: 'assistant', content: 'การประเมินเบื้องต้นควรครอบคลุมภาวะน้ำเกิน ระดับอิเล็กโทรไลต์ และการทำงานของหัวใจ',
      refs: [{ source: 'Thai Heart Association' }],
      socratic_question: 'ท่านคิดว่าปัจจัยใดที่ทำให้ผู้ป่วยรายนี้ปฏิเสธการฟอกเลือด และท่านจะสำรวจเรื่องนี้กับผู้ป่วยอย่างไร' },
    { role: 'reflection', content: 'บทเรียนสำคัญคือการสื่อสารเรื่องเป้าหมายการรักษากับผู้ป่วยสูงอายุต้องเริ่มจากคุณค่าที่ผู้ป่วยให้ความสำคัญ' },
  ], audit_score: null }],
  [/\/auditor\/ples\/[0-9a-f-]+a2$/, { messages: [{ role: 'physician', content: LONG_TH }],
    audit_score: { ...byDomain([3, 4, 4, 2, 3, 4, 3]), notes: null },
    ai_evaluation: { composite_score: 71.4, ...byDomain([4, 3, 4, 3, 2, 4, 3]) },
    peer_avg: byDomain([3.5, 3, 4, 2.5, 3, 4.5, 3]), peer_n: 2 }],
  [/\/auditor\/calibration/, { n: 6, auditor: byDomain([3.2, 3.5, 4, 2.4, 3.1, 4, 3]), ai: byDomain([3.8, 3.1, 4, 3, 2.2, 3.9, 3.4]),
    peer: byDomain([3.4, 3.3, 3.8, 2.6, 2.9, 4.1, 3.2]) }],
  [/\/auditor\/icc/, { icc: 0.71, n: 6 }],

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
  // Mounted at /admin, not /superadmin (backend/src/index.js mounts routes/superadmin.js there): the
  // old /superadmin/ patterns never matched, so governance rendered empty in every earlier run.
  [/\/admin\/retention$/, {
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
  [/\/admin\/payouts/, { rows: [], total_owed_thb: 4500, total_paid_thb: 1500 }],
  [/\/admin\/usage-settings/, { comp_rate_thb: 500, comp_cap_cles: 3, standard_usage_limit_usd: 0.5,
    standard_limit_usd: 0.5, auditor_standard_limit_usd: 0.5, api_budget_pool_usd: 50, total_used_usd: 12.4,
    pilot_test_mode: true, peer_calibration_enabled: true, hold_result_until_audited: true, min_auditors_per_cle: 2,
    standard_limit_tokens: 300000, auditor_standard_limit_tokens: 0, ple_max_transcript_tokens: 64000,
    ple_transcript_warn_pct: 80, eval_drain_concurrency: 1, eval_p50_seconds: 90, eval_drain_exclude_councils: 'SBX' }],
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
  // ---- superadmin overview, reliability, Model Lock, readiness ----------------------------------
  [/\/admin\/ai-providers/, {
    providers: { chat: 'anthropic', evaluate: 'local', criteria: 'anthropic', discuss: 'anthropic', embed: 'openai' },
    choices: { chat: ['anthropic', 'local', 'local-tutor'], evaluate: ['anthropic', 'local'], criteria: ['anthropic', 'local'],
      discuss: ['anthropic', 'local', 'local-tutor'], embed: ['openai', 'local'] },
    evaluator_locked_at: iso(1), evaluator_lock: { locked: true, record: 'found', manifest_bound: false },
    confirm_phrases: { change_evaluator: 'CHANGE EVALUATOR', unlock_evaluator: 'UNLOCK EVALUATOR', switch_unfit: 'SWITCH ANYWAY', replace_lock: 'REPLACE THE LOCK' },
  }],
  [/\/health\/deep/, { status: 'ok', service: 'backend', checks: { eval_queue: { queued: 3, scoring: 2, oldest_wait_s: 65,
    drain: { running: true, in_flight: 2, last_tick_at: iso(0), last_error: null } } } }],
  [/\/admin\/slots/, [{ role: 'admin', capacity: 10, used: 4, remaining: 6 }, { role: 'auditor', capacity: 30, used: 14, remaining: 16 },
    { role: 'physician', capacity: 200, used: 91, remaining: 109 }]],
  [/\/admin\/overview-counts/, [{ council_id: 'c1', role: 'physician', n: 28 }, { council_id: 'c1', role: 'auditor', n: 14 }]],
  [/\/admin\/icc/, {
    overall: iccStat(0.81, 34), per_domain: byDomain([0.71, 0.66, 0.79, 0.52, 0.83, 0.77, 0.69].map((v) => iccStat(v))),
    per_council: { c1: { council: { id: 'c1', code: 'TMC', name_th: 'แพทยสภา', name_en: 'Thai Medical Council' }, overall: iccStat(0.81, 30), n: 30 } },
    n: 34, min_auditors: 2, auditors_per_cle: { 1: 10, 2: 20, 3: 4 }, n_at_target: 24, n_below_target: 10,
    inter_auditor: { ...iccStat(0.58), model: 'ICC(1,1)' }, inter_auditor_average: { ...iccStat(0.73), model: 'ICC(A,k)', model_alt: 'ICC(2,k)', k: 2 },
    inter_auditor_per_domain: byDomain([0.51, 0.44, 0.62, 0.31, 0.71, 0.55, 0.49].map((v) => ({ ...iccStat(v), model: 'ICC(1,1)' }))),
    weighted_kappa: { domains: byDomain([0.6, 0.5, 0.7, 0.3, 0.8, 0.55, 0.45].map((k) => ({ kappa: k, n: 24, interpretation: 'moderate' }))),
      pooled: { kappa: 0.58, n: 168, exact_agreement: 0.48, interpretation: 'moderate' } },
  }],
  [/\/admin\/ai-readiness/, {
    reachable: true,
    checks: { local: { status: 'up', model: 'qwen3-32b', context_length: 32768, min_context: 16384 },
      r3_distinct_models: { status: 'warn', warning: 'local-tutor is configured to the same endpoint and model as local (the evaluator)' } },
    models: { evaluate: { provider: 'local', model: 'qwen3-32b' } }, routing: { evaluator_locked_at: iso(1) },
    embedding: { provider: 'local', model: 'bge-m3', fit: false, dimension: 1024, required: 1536, reason: null },
    manifest: { sha256: 'f'.repeat(64), file: 'present', code_match: true, evaluator_provider: 'local',
      drift: [{ key: 'LOCAL_AI_MODEL' }, { key: 'EVAL_MAX_TOKENS' }, { key: 'CHAT_TEMPERATURE' }], evaluator_drift_keys: ['LOCAL_AI_MODEL', 'EVAL_MAX_TOKENS'] },
    model_lock: { status: 'down', locked: true, locked_at: iso(1), provider: 'local', reason: 'evaluator_live_drift', drift_keys: ['LOCAL_AI_MODEL'] },
  }],
  // can_declare with a lock in force: the form renders with every hint, and so does the re-lock warning.
  [/\/admin\/evaluator-lock/, {
    locked_at: iso(1), in_force: true, serving_provider: 'local', can_declare: true, blockers: [], blocker_detail: {},
    current: { id: 'r1', locked_at: iso(1), provider: 'local', model_version: 'CCME_LLM_v8.0+qwen-2.5-72b', weights_sha256: 'a'.repeat(64),
      inference_engine: 'vllm 0.21.1', quantization: 'Q8_0', system_prompt_version: 'sys-v3', evaluator_prompt_version: 'pis7-prompt-59561c29',
      rubric_version: 'pis7-weights-08b0cb1a', decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: null }, environment: { os: 'ubuntu 24.04' },
      note: 'first freeze', manifest_sha256: 'f'.repeat(64), evaluator_sha256: 'e'.repeat(64) },
    candidate: { provider: 'local', model_version: 'CCME_LLM_v8.0+qwen-2.5-72b', prompt_version: 'pis7-prompt-59561c29', rubric_versions: ['pis7-weights-08b0cb1a'] },
    gate: { state: 'pass', threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 60, why: 'the whole interval is at or above 0.75',
      groups: [{ provider: 'local', model_version: 'CCME_LLM_v8.0+qwen-2.5-72b', prompt_version: 'pis7-prompt-59561c29', rows: 60, rubric_versions: ['pis7-weights-08b0cb1a'] }] },
    manifest: { ok: true, sha256: 'f'.repeat(64), file: 'present', code_match: true, drift_keys: ['CHAT_TEMPERATURE', 'RAG_TOP_K'], evaluator_drift_keys: [],
      expected_for_candidate: { prompt_version: 'pis7-prompt-59561c29', rubric_version: 'pis7-weights-08b0cb1a', model_version: 'CCME_LLM_v8.0+qwen-2.5-72b',
        provider_declared: 'local', decoding: { max_tokens: { default: 1500, env: 'EVAL_MAX_TOKENS' }, temperature: 0 }, declared: { engine: 'vllm' }, evaluator_sha256: 'e'.repeat(64) } },
    manifest_diff: [], migrations_pending: [], confirm_phrases: { replace_lock: 'REPLACE THE LOCK' },
  }],
  // One session carrying every signal, so each signal's explanatory note renders.
  [/\/admin\/integrity-queue/, { ples: [{ id: 'i-1', ple_code: 'PLE-301', status: 'evaluated', ended_at: iso(2), turn_count: 14, flags: [
    { signal: 'F1_NEAR_DUPLICATE', severity: 'medium', created_at: iso(2), evidence: { pairs: 2 } },
    { signal: 'F2_CROSS_SESSION_REUSE', severity: 'low', created_at: iso(2), evidence: { other_ple_id: '33333333-3333-4333-8333-333333333333' } },
    { signal: 'F3_PASTE_BURST', severity: 'high', created_at: iso(2), evidence: { chars: 1800, genre: { clinical_density: 12, discourse_density: 1, markdown_marks: 0 } } },
    { signal: 'F5_LATENCY_UNIFORMITY', severity: 'medium', created_at: iso(2), evidence: { cv: 0.04 } },
    { signal: 'F6_REGISTER_DISCONTINUITY', severity: 'medium', created_at: iso(2), evidence: { shifted_features: [{ feature: 'discourse', value: 3.21, z: 4.4 }] } },
    { signal: 'S1_PHYSICIAN_REPORTED_REPLY', severity: 'high', created_at: iso(2), evidence: { report_count: 1, reports: [
      { message_id: '11111111-1111-4111-8111-111111111111', reason: 'unsafe_advice', note: 'ขนาดยาที่แนะนำสูงเกินไปสิบเท่า', turn: 3, provider: 'local', model: 'deepseek-v4', reported_at: iso(2) }] } },
  ] }] }],

  // ---- analyst (aggregate only) ------------------------------------------------------------------
  [/\/oversight\/icc\/three-way/, { arms: { ai_vs_human: { overall: iccStat(0.82), n: 24, verdict: { state: 'pass', threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 24, why: 'the whole interval is at or above 0.75' } },
    shadow_vs_human: null, ai_vs_shadow: null }, coverage: { ples_with_human: 30, ples_with_ai: 40, ples_with_shadow: 0, ples_all_three: 0, shadow_failed: 0, shadow_contract_rate: null },
    shadow: { available: false, provider: null, model_version: null } }],
  [/\/oversight\/icc/, { overall: iccStat(0.81, 34), per_domain: byDomain([0.71, 0.66, 0.79, 0.52, 0.83, 0.77, 0.69].map((v) => iccStat(v))), n: 34 }],
  [/\/oversight\/stats/, { counts: { ple_pass: 9, ple_fail_t1: 3, ple_flag_t2: 5, evaluated: 14, ended: 2, active: 4 }, total: 37 }],
  [/\/oversight\/rater-spread/, { ok: true, n_scores: 7, n_episodes: 5, n_auditors: 2, n_multi_rated_episodes: 2,
    between_episodes: { sd: 2.44, min: 74, max: 80, range: 6 }, comparison_on_shared: { n: 5, human_sd: 2.44, ai_sd: 9.84, human_range: 6, ai_range: 20 },
    gate: { measurable: true, why: null, sd_error: 2.69, sd_between_observed: 2.44, sd_between_required: 4.66, meets: false },
    scale_use: { min: 73, max: 80, span_pct_of_scale: 7 },
    per_domain: Object.fromEntries(D7.map((d) => [d, { n: 5, sd: 0.8, modal_value: 4, modal_share: 0.6, distinct: 3 }])),
    scored_between: { first: iso(20), last: iso(10) },
    per_auditor: [{ auditor_id: 'a6a5ba01-2bad-42c2-85f3-e2bb5620b0d0', n: 5, mean: 76.6, sd: 3.21, min: 73, max: 80 }] }],
  [/\/admin\/overview/, { councils: 1, physicians: 28, auditors: 14, ples: 34, evaluated: 14, icc: 0.811 }],
  [/\/admin\/stats/, { by_status: { evaluated: 14, ple_flag_t2: 9, ple_fail_t1: 6, active: 5 } }],
];

// Anything under the API base that has no fixture returns an empty-but-valid envelope rather than
// hanging or 404ing, so one unmocked call cannot blank a whole page.
export const FALLBACK = { ples: [], verifications: [], reviews: [], users: [], items: [], data: [], rows: [] };

export function fixtureFor(url) {
  for (const [re, body] of FIXTURES) if (re.test(url)) return body;
  return FALLBACK;
}
