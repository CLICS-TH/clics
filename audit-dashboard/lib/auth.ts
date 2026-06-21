export interface ClicsUser {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'physician' | 'auditor' | 'analyst' | 'ethics';
  full_name_th: string;
  full_name_en: string;
  council_id?: string | null;
  /** Structured specialty (the layer under council) + its display names (from /auth/me + login). */
  specialty_id?: string | null;
  specialty_name_th?: string | null;
  specialty_name_en?: string | null;
  /** Position ladder (ตำแหน่ง): extern…staff…gp (General Practitioner). */
  position?: string | null;
  /** External identity providers linked to this account (e.g. ['google']) — from /auth/me. */
  linked_providers?: string[];
  /** Dual-role: a physician with can_audit=true also passes auditor gates. */
  can_audit?: boolean;
}

export function getUser(): ClicsUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('clics_user');
  if (!raw) return null;
  // Guard the parse: a corrupt clics_user (truncated write, manual tampering) would otherwise throw
  // on every render and trap the page behind the error boundary (whose Retry just re-throws). Drop
  // the bad value and treat the user as logged-out instead.
  try {
    return JSON.parse(raw) as ClicsUser;
  } catch {
    localStorage.removeItem('clics_user');
    return null;
  }
}

// The single "may this user audit?" predicate — an auditor, or a physician with can_audit
// (the "Special" dual role). Mirrors the backend requireRole('auditor') admittance. Use this
// instead of re-spelling the boolean in each client gate (queue page, NavBar, …).
export function canAudit(u?: Pick<ClicsUser, 'role' | 'can_audit'> | null): boolean {
  return !!u && (u.role === 'auditor' || (u.role === 'physician' && !!u.can_audit));
}
