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
