// One write to /admin/usage-settings, classified. The page turns the outcome into state and a toast.
//
// apiFetch never rejects: a failed PATCH resolves with an {error} body, a 401 resolves with undefined
// (while the page navigates to login), and a field the backend does not know is simply not echoed.
// The caller used to read the echo as undefined and write that into state, so a switch flipped to
// "off" while the server kept the old value. A write is only trusted when the API echoes a value back,
// and the echo — not the request — is what the UI shows, because the server is the truth. That matters
// most for calibration_reveal_locked: a lock that looks released but is not.
import { apiFetch } from '@/lib/api';
import type { UsageSettings } from '@/lib/types';

export type PatchOutcome<K extends keyof UsageSettings> =
  | { status: 'saved'; value: UsageSettings[K] }
  /** The API accepted the write but echoed a DIFFERENT value (clamped, or changed by someone else). */
  | { status: 'mismatch'; value: UsageSettings[K] }
  | { status: 'failed'; reason?: string };

export async function patchUsageSetting<K extends keyof UsageSettings>(
  key: K,
  value: UsageSettings[K],
): Promise<PatchOutcome<K>> {
  try {
    const next = await apiFetch<UsageSettings & { error?: unknown }>('/admin/usage-settings', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
    if (!next || next.error || next[key] === undefined) {
      return { status: 'failed', reason: typeof next?.error === 'string' ? next.error : undefined };
    }
    return next[key] === value
      ? { status: 'saved', value: next[key] }
      : { status: 'mismatch', value: next[key] };
  } catch {
    return { status: 'failed' };
  }
}
