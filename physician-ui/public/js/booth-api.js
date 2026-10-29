/**
 * @typedef {'offline' | 'http'} BoothApiErrorKind
 *   offline  no answer within the call's deadline (Wi-Fi down, CORS failure, server unreachable or too slow)
 *   http     the backend answered non-2xx (status and the body's `reason` attached), or 2xx with a non-JSON body
 */
export class BoothApiError extends Error {
  /** @param {BoothApiErrorKind} kind @param {number} status 0 unless kind is 'http' @param {string | null} reason */
  constructor(kind, status, reason) {
    super(`booth api ${kind}${status ? ` ${status}` : ''}${reason ? ` ${reason}` : ''}`);
    this.name = 'BoothApiError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * @param {string} baseUrl window.CLICS_API_URL (js/config.js), no trailing slash
 * @returns {{
 *   get: (path: string, opts: { timeoutMs: number }) => Promise<any>,
 *   post: (path: string, body: object, opts: { timeoutMs: number }) => Promise<any>,
 * }} Each resolves with the parsed JSON of a 2xx and rejects with a BoothApiError otherwise.
 */
export function createBoothApi(baseUrl) {
  async function request(method, path, body, { timeoutMs } = {}) {
    if (!(timeoutMs > 0)) throw new TypeError('timeoutMs is required');
    const deadline = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: deadline,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BoothApiError('offline', 0, null);
    }
    const parsed = await res.json().catch(() => undefined);
    if (deadline.aborted) throw new BoothApiError('offline', 0, null);
    if (!res.ok) throw new BoothApiError('http', res.status, typeof parsed?.reason === 'string' ? parsed.reason : null);
    if (parsed === undefined) throw new BoothApiError('http', res.status, 'bad_body');
    return parsed;
  }
  return {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
  };
}
