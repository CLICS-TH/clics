// apiFetch attaches the HTTP status to ERROR envelopes as `httpStatus`, so a page can tell "not yours"
// (404/403) from "down for a moment" (503) without parsing message text. Success bodies are untouched.
import { apiFetch } from '@/lib/api';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function respond(status: number, json: () => Promise<unknown>) {
  global.fetch = jest.fn(async () => ({ status, json } as unknown as Response)) as unknown as typeof fetch;
}

describe('apiFetch httpStatus on error envelopes', () => {
  it('a JSON error body keeps its fields and gains httpStatus', async () => {
    respond(503, async () => ({ error: 'unavailable', code: 'deidentify_unavailable' }));
    await expect(apiFetch('/x')).resolves.toEqual({ error: 'unavailable', code: 'deidentify_unavailable', httpStatus: 503 });
  });

  it('a non-JSON error page (proxy 502) still says which status it was', async () => {
    respond(502, async () => { throw new SyntaxError('Unexpected token <'); });
    const r = await apiFetch<{ error?: string; httpStatus?: number }>('/x');
    expect(r.error).toMatch(/did not respond/);
    expect(r.httpStatus).toBe(502);
    expect((r as { unreadableBody?: boolean }).unreadableBody).toBe(true);
  });

  it('a success body is returned exactly as sent, even one with its own `status` field', async () => {
    respond(200, async () => ({ status: 'active', n: 1 }));
    await expect(apiFetch('/x')).resolves.toEqual({ status: 'active', n: 1 });
  });

  it('an array error body is not reshaped into an object', async () => {
    respond(400, async () => ['bad']);
    await expect(apiFetch('/x')).resolves.toEqual(['bad']);
  });
});
