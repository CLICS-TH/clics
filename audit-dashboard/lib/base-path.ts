// The dashboard is served under /audit on the Portal's origin (ADR 0012). next/link and the router add the
// base path themselves; a plain <img src>, window.location or stored path does not.
export const BASE_PATH = '/audit';

export function withBasePath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `${BASE_PATH}${path}` : path;
}

export function stripBasePath(path: string): string {
  if (path === BASE_PATH) return '/';
  return path.startsWith(`${BASE_PATH}/`) ? path.slice(BASE_PATH.length) : path;
}
