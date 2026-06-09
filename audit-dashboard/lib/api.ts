const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('clics_token');
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.clear();
    window.location.href = '/login';
  }
  return res.json() as Promise<T>;
}

// Paged fetch: returns the JSON array body plus the total row count from the
// 'X-Total-Count' response header (see backend pagination contract). Falls back
// to the page length when the header is missing/unparseable so callers can
// still render. Mirrors apiFetch's 401 handling.
export async function apiFetchPaged<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ items: T[]; total: number }> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.clear();
    window.location.href = '/login';
  }
  const items = ((await res.json()) ?? []) as T[];
  const header = res.headers.get('X-Total-Count');
  const parsed = header == null ? NaN : Number(header);
  const total = Number.isFinite(parsed) ? parsed : items.length;
  return { items, total };
}
