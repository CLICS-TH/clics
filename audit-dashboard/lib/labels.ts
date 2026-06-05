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

// PIS-7 domain weights (must mirror backend/src/services/cle-gate.js).
export const WEIGHTS: Record<string, number> = {
  d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10,
};

// 0–5 domain scores → 0–100 composite (max = 5 × 1.0 × 20).
export function computeComposite(scores: Record<string, number>): number {
  return Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (scores[k] ?? 0) * w, 0) * 20;
}
