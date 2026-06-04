export interface ClicsUser {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'physician' | 'auditor';
  full_name_th: string;
  full_name_en: string;
}

export function getUser(): ClicsUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('clics_user');
  return raw ? JSON.parse(raw) : null;
}
