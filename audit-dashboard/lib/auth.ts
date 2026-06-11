export interface ClicsUser {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'physician' | 'auditor';
  full_name_th: string;
  full_name_en: string;
  council_id?: string | null;
  /** Dual-role: a physician with can_audit=true also passes auditor gates. */
  can_audit?: boolean;
}

export function getUser(): ClicsUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('clics_user');
  return raw ? JSON.parse(raw) : null;
}

// The single "may this user audit?" predicate — an auditor, or a physician with can_audit
// (the "Special" dual role). Mirrors the backend requireRole('auditor') admittance. Use this
// instead of re-spelling the boolean in each client gate (queue page, NavBar, …).
export function canAudit(u?: Pick<ClicsUser, 'role' | 'can_audit'> | null): boolean {
  return !!u && (u.role === 'auditor' || (u.role === 'physician' && !!u.can_audit));
}
