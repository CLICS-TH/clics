// apiDownload's failure path: the backend's own {error} reaches the toast (the booth export's 503 says the audit-log
// row could not be written, so nothing was exported); a body that is not the backend's JSON falls back to the status.
import { apiDownload } from '@/lib/api';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function respond(status: number, json: () => Promise<unknown>) {
  global.fetch = jest.fn(async () => ({ status, ok: status < 400, json } as unknown as Response)) as unknown as typeof fetch;
}

describe('apiDownload error reason', () => {
  it("shows the backend's {error} when the body has one", async () => {
    respond(503, async () => ({ error: 'The export could not be recorded in the audit log, so nothing was exported — try again' }));
    await expect(apiDownload('/admin/booth/export.json', 'f.json')).resolves.toEqual({
      error: 'The export could not be recorded in the audit log, so nothing was exported — try again',
    });
  });

  it('falls back to the status when the body is not JSON (a proxy page)', async () => {
    respond(502, async () => { throw new SyntaxError('Unexpected token <'); });
    await expect(apiDownload('/x', 'f')).resolves.toEqual({ error: 'ดาวน์โหลดไม่สำเร็จ / Download failed (status 502).' });
  });

  it('falls back to the status when the JSON has no error string', async () => {
    respond(500, async () => ({ message: 'x' }));
    await expect(apiDownload('/x', 'f')).resolves.toEqual({ error: 'ดาวน์โหลดไม่สำเร็จ / Download failed (status 500).' });
  });
});
