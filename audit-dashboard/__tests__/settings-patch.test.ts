// patchUsageSetting: a settings write counts only when the API echoes a value back, and the ECHO is
// what the UI must show. calibration_reveal_locked has to stay exact — a lock that looks released but
// is not is the failure this exists to prevent.
import { patchUsageSetting } from '@/lib/settings-patch';
import { apiFetch } from '@/lib/api';

jest.mock('@/lib/api', () => ({ apiFetch: jest.fn() }));
const mockFetch = apiFetch as jest.Mock;

beforeEach(() => mockFetch.mockReset());

describe('patchUsageSetting', () => {
  it('a good save: sends only that key and reports the echoed value', async () => {
    mockFetch.mockResolvedValue({ calibration_reveal_locked: true });
    const r = await patchUsageSetting('calibration_reveal_locked', true);
    expect(r).toEqual({ status: 'saved', value: true });
    expect(mockFetch).toHaveBeenCalledWith('/admin/usage-settings', {
      method: 'PATCH', body: JSON.stringify({ calibration_reveal_locked: true }),
    });
  });

  it('a good save of false is a save, not a failure (false is not "missing")', async () => {
    mockFetch.mockResolvedValue({ calibration_reveal_locked: false });
    expect(await patchUsageSetting('calibration_reveal_locked', false)).toEqual({ status: 'saved', value: false });
  });

  it('an {error} body is a failure and carries its reason', async () => {
    mockFetch.mockResolvedValue({ error: 'ไม่ได้รับอนุญาต' });
    expect(await patchUsageSetting('calibration_reveal_locked', true)).toEqual({ status: 'failed', reason: 'ไม่ได้รับอนุญาต' });
  });

  it('an {error} that is not a string is still a failure, with no reason', async () => {
    mockFetch.mockResolvedValue({ error: { code: 1 } });
    expect(await patchUsageSetting('hold_result_until_audited', true)).toEqual({ status: 'failed', reason: undefined });
  });

  it('undefined (a 401 while the page navigates to login) is a failure', async () => {
    mockFetch.mockResolvedValue(undefined);
    expect(await patchUsageSetting('calibration_reveal_locked', true)).toEqual({ status: 'failed', reason: undefined });
  });

  it('a field the API did not echo is a failure (a setting the backend does not know)', async () => {
    mockFetch.mockResolvedValue({ standard_limit_usd: 1 });
    expect(await patchUsageSetting('calibration_reveal_locked', true)).toEqual({ status: 'failed', reason: undefined });
  });

  it('an echo that differs from the request is a mismatch and carries the SERVER value', async () => {
    mockFetch.mockResolvedValue({ calibration_reveal_locked: false });
    const r = await patchUsageSetting('calibration_reveal_locked', true);
    expect(r).toEqual({ status: 'mismatch', value: false });   // the lock is still OFF on the server
  });

  it('a clamped number is a mismatch too', async () => {
    mockFetch.mockResolvedValue({ min_auditors_per_cle: 10 });
    expect(await patchUsageSetting('min_auditors_per_cle', 12)).toEqual({ status: 'mismatch', value: 10 });
  });

  it('a thrown error is a failure', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    expect(await patchUsageSetting('calibration_reveal_locked', true)).toEqual({ status: 'failed' });
  });
});
