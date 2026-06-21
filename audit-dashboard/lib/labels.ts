// Single source of truth for status/role labels and the PIS-7 weighting,
// shared across the admin and auditor pages.
import { CHART } from './chart-colors';

export const STATUS_MAP: Record<string, string> = {
  active: 'กำลังดำเนินการ',
  ended: 'สิ้นสุด',
  cle_pass: 'ผ่าน CLE',
  cle_fail_t1: 'ไม่ผ่าน T1',
  cle_flag_t2: 'รอตรวจสอบ',
  evaluated: 'ประเมินแล้ว',
};

export const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin',
  admin: 'ผู้ดูแลสภา / Admin',
  physician: 'แพทย์',
  auditor: 'Auditor',
};

// "special" is a UI-only role value = a physician who ALSO holds auditor rights (can_audit).
// These two helpers are the single home for that virtual-role encoding, so the rule can't drift
// across the invites + users admin pages.
export function roleToWire(uiRole: string): { role: string; can_audit: boolean } {
  return uiRole === 'special' ? { role: 'physician', can_audit: true } : { role: uiRole, can_audit: false };
}
export function roleToUi(role: string, can_audit?: boolean | null): string {
  return role === 'physician' && can_audit ? 'special' : role;
}

// Position ladder (ตำแหน่ง) — mirrors backend lib/specialties POSITIONS ('gp' = General Practitioner).
export const POSITION_OPTIONS: { key: string; label: string }[] = [
  { key: 'extern', label: 'เอกซ์เทิร์น / Extern' },
  { key: 'intern', label: 'อินเทิร์น / Intern' },
  { key: 'resident', label: 'แพทย์ประจำบ้าน / Resident' },
  { key: 'fellowship', label: 'ต่อยอด / Fellowship' },
  { key: 'staff', label: 'อาจารย์แพทย์ / Staff' },
  { key: 'gp', label: 'แพทย์ทั่วไป / General Practitioner' },
];
export const positionLabel = (key?: string | null) => POSITION_OPTIONS.find(p => p.key === key)?.label ?? null;
// Thai-only label for compact spots (nav-bar identity line).
export const POSITION_TH: Record<string, string> = {
  extern: 'เอกซ์เทิร์น', intern: 'อินเทิร์น', resident: 'แพทย์ประจำบ้าน',
  fellowship: 'แพทย์ประจำบ้านต่อยอด', staff: 'อาจารย์แพทย์', gp: 'แพทย์ทั่วไป',
};

// Account lifecycle (NOT the same as CLE status above).
export const ACCOUNT_STATUS_MAP: Record<string, string> = {
  active: 'ใช้งาน / Active',
  deactivated: 'ปิดใช้งาน / Deactivated',
};

// Invite lifecycle (POST/GET /admin/invites).
export const INVITE_STATUS_MAP: Record<string, string> = {
  pending: 'รอตอบรับ / Pending',
  accepted: 'ตอบรับแล้ว / Accepted',
  revoked: 'เพิกถอน / Revoked',
  expired: 'หมดอายุ / Expired',
};

// PIS-7 domain weights (must mirror backend/src/services/cle-gate.js).
export const WEIGHTS: Record<string, number> = {
  d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10,
};

// PIS-7 domain keys + abbreviated labels, positionally aligned (ICC dashboard + executive overview).
export const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const DOMAIN_LABELS = ['CQI', 'RD', 'CI', 'II', 'CA', 'RS', 'ALPS'];

// Headline CLE cards from GET /admin/stats. Covers EVERY status so the cards reconcile to the
// total (Evaluated + Awaiting QA + Did-not-pass + In-progress = Total) — cle_fail_t1 once had no
// card and the numbers never added up. key '' = all; in_progress = active+ended+cle_pass (the
// same UI bucket the CLEs page filters by).
export function cleStatusCards(stats: Record<string, number> | null | undefined) {
  const s = stats ?? {};
  const inProgress = (s.active ?? 0) + (s.ended ?? 0) + (s.cle_pass ?? 0);
  return [
    { label: 'CLEs ทั้งหมด / Total', value: s.total ?? 0, key: '' },
    { label: 'ประเมินแล้ว / Evaluated', value: s.evaluated ?? 0, key: 'evaluated' },
    { label: 'รอ QA / Awaiting QA', value: s.cle_flag_t2 ?? 0, key: 'cle_flag_t2' },
    { label: 'ไม่ผ่านเกณฑ์ / Did not pass', value: s.cle_fail_t1 ?? 0, key: 'cle_fail_t1' },
    { label: 'กำลังดำเนินการ / In progress', value: inProgress, key: 'in_progress' },
  ];
}

// Org API-budget meter tone — one set of thresholds everywhere (amber ≥75%, red ≥90%).
// Colors come from the shared CHART palette so the meter, charts, and --chart-* tokens never drift.
export function budgetToneHex(fraction: number): string {
  return fraction >= 0.9 ? CHART.fail : fraction >= 0.75 ? CHART.warn : CHART.pass;
}

// 0–5 domain scores → 0–100 composite (max = 5 × 1.0 × 20).
export function computeComposite(scores: Record<string, number>): number {
  return Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (scores[k] ?? 0) * w, 0) * 20;
}

// Coarse clinical topic from a chief complaint — used to categorize a user's sessions "by case type".
export function caseCategory(chief?: string | null): string {
  const c = (chief || '').toLowerCase();
  if (/chest pain|substernal|angina|acs/.test(c)) return 'เจ็บหน้าอก / Chest pain';
  if (/dyspn|breathless|short(ness)? of breath|\bsob\b|หายใจ/.test(c)) return 'หอบเหนื่อย / Dyspnea';
  if (/fever|cough|pneumonia|sepsis|ไข้|ไอ/.test(c)) return 'ไข้/ไอ / Fever & cough';
  if (/abdom|\brlq\b|appendic|ปวดท้อง/.test(c)) return 'ปวดท้อง / Abdominal';
  if (/headache|occipital|thunderclap|ปวดหัว|ปวดศีรษะ/.test(c)) return 'ปวดศีรษะ / Headache';
  return 'อื่นๆ / Other';
}
