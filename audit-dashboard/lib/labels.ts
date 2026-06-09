// Single source of truth for status/role labels and the PIS-7 weighting,
// shared across the admin and auditor pages.

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
  admin: 'Admin',
  physician: 'แพทย์',
  auditor: 'Auditor',
};

// Account lifecycle (NOT the same as PLE status above).
export const ACCOUNT_STATUS_MAP: Record<string, string> = {
  active: 'ใช้งาน / Active',
  deactivated: 'ปิดใช้งาน / Deactivated',
};

// Access-request lifecycle.
export const REQUEST_STATUS_MAP: Record<string, string> = {
  pending: 'รออนุมัติ / Pending',
  approved: 'อนุมัติแล้ว / Approved',
  rejected: 'ปฏิเสธ / Rejected',
};

// Provider label for an access request / linked identity.
export const PROVIDER_LABELS: Record<string, string> = {
  email: 'Email',
  google: 'Google',
  line: 'LINE',
};

// Invite lifecycle (POST/GET /admin/invites).
export const INVITE_STATUS_MAP: Record<string, string> = {
  pending: 'รอตอบรับ / Pending',
  accepted: 'ตอบรับแล้ว / Accepted',
  revoked: 'เพิกถอน / Revoked',
  expired: 'หมดอายุ / Expired',
};

// License verification status on a professional row (license_status).
export const LICENSE_STATUS_MAP: Record<string, string> = {
  unverified: 'ยังไม่ตรวจสอบ / Unverified',
  verified: 'ตรวจสอบแล้ว / Verified',
  not_found: 'ไม่พบใบอนุญาต / Not found',
  name_mismatch: 'ชื่อไม่ตรงกัน / Name mismatch',
  manual_verified: 'ตรวจสอบโดยเจ้าหน้าที่ / Manual verified',
};

// PIS-7 domain weights (must mirror backend/src/services/cle-gate.js).
export const WEIGHTS: Record<string, number> = {
  d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10,
};

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
