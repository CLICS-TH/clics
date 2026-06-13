const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('clics_token');
}

// Session expiry → bounce to /login (which re-enters the portal). Remember where we were FIRST, in
// sessionStorage (same-origin, survives the portal round-trip and the localStorage.clear below) so
// the login gate can return the user to the exact page after they sign back in.
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  try { sessionStorage.setItem('clics_reauth_next', window.location.pathname + window.location.search); } catch {}
  localStorage.clear();
  window.location.href = '/login';
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch {
    // Never REJECT on a network failure — callers check `.error`, so an envelope keeps action buttons
    // (Approve/Reject/Create…) from stranding disabled. Mirrors apiFetchPaged's non-throwing contract.
    return { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error. Please try again.' } as unknown as T;
  }
  if (res.status === 401 && typeof window !== 'undefined') {
    redirectToLogin();
    return undefined as unknown as T; // stop here — the page is navigating away
  }
  // Resolve an {error} envelope instead of THROWING when the body isn't JSON (a Railway proxy 502/504
  // returns an HTML page). An unguarded res.json() reject left action buttons (e.g. invite Create)
  // stranded disabled forever; callers check `.error`, so an envelope re-enables them cleanly.
  const body = await res.json().catch(() => null);
  if (body == null) {
    return { error: 'เซิร์ฟเวอร์ไม่ตอบสนอง กรุณาลองใหม่ / The server did not respond. Please try again.' } as unknown as T;
  }
  return body as T;
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
    redirectToLogin();
    return { items: [], total: 0 };
  }
  const body = await res.json().catch(() => null);
  // A non-ok response carries a JSON error object, not the page array — if it leaked
  // through as `items`, list pages would crash on .map. Log it and return an empty page.
  if (!res.ok || !Array.isArray(body)) {
    console.error(`apiFetchPaged ${path} failed (status ${res.status})`, body);
    return { items: [], total: 0 };
  }
  const items = body as T[];
  const header = res.headers.get('X-Total-Count');
  const parsed = header == null ? NaN : Number(header);
  const total = Number.isFinite(parsed) ? parsed : items.length;
  return { items, total };
}
