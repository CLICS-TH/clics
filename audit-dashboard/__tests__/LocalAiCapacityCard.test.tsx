// LocalAiCapacityCard edits the on-prem evaluator's capacity settings and shows the queue. What has
// to be RIGHT here: a 0 token ceiling reads as "no cap" (never "capped at 0"); the backend's bounds
// are enforced before a PATCH leaves; council codes go up the wire upper-cased like the server stores
// them; after a save the card re-reads the settings (the PATCH echo does not carry these keys); and an
// unreachable /health/deep degrades to "—" instead of taking the overview page down with it.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { LocalAiCapacityCard } from '@/components/LocalAiCapacityCard';
import type { HealthDeep, UsageSettings } from '@/lib/types';

const USAGE: UsageSettings = {
  standard_limit_usd: 0.5, auditor_standard_limit_usd: 0.5, api_budget_pool_usd: 50, total_used_usd: 1.2,
  standard_limit_tokens: 300_000, auditor_standard_limit_tokens: 0,
  ple_max_transcript_tokens: 64_000, ple_transcript_warn_pct: 80,
  eval_drain_concurrency: 1, eval_p50_seconds: 90, eval_drain_exclude_councils: '',
};
const HEALTH: HealthDeep = {
  status: 'ok',
  checks: { eval_queue: { queued: 3, scoring: 2, oldest_wait_s: 65, drain: { running: true, in_flight: 2, last_tick_at: '2026-09-02T01:00:00Z', last_error: null } } },
};

// Default wiring: the probe answers, GET returns the fixture, PATCH echoes the old keys only (as the
// backend does today — the new keys are absent from the echo on purpose, see the component header).
function wire(over: { health?: unknown; patch?: unknown; get?: unknown } = {}) {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === '/health/deep') return Promise.resolve(over.health ?? HEALTH);
    if (path === '/admin/usage-settings' && opts?.method === 'PATCH') {
      return Promise.resolve(over.patch ?? { standard_limit_usd: 0.5, api_budget_pool_usd: 50 });
    }
    if (path === '/admin/usage-settings') return Promise.resolve(over.get ?? { ...USAGE, ple_max_transcript_tokens: 96_000 });
    return Promise.resolve({ error: `unexpected ${path}` });
  });
}
const queueRow = () => screen.getByRole('group', { name: /Queue now/ });
const settled = () => waitFor(() => expect(queueRow()).toHaveAttribute('aria-busy', 'false'));
async function renderCard(usage: UsageSettings | null, onChange: (n: UsageSettings) => void = () => {}) {
  const r = render(<LocalAiCapacityCard usage={usage} onChange={onChange} />);
  if (usage) await settled();
  return r;
}
const patchCalls = () => apiFetch.mock.calls.filter(([p, o]) => p === '/admin/usage-settings' && o?.method === 'PATCH');

beforeEach(() => wire());

describe('LocalAiCapacityCard — settings', () => {
  it('shows a skeleton until the settings arrive, and never calls PATCH on its own', () => {
    render(<LocalAiCapacityCard usage={null} onChange={() => {}} />);
    expect(screen.getByText(/Local AI capacity/)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: /Transcript cap/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Queue now/ })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('formats a token ceiling with thousands separators and reads 0 as "no cap"', async () => {
    await renderCard(USAGE);
    expect(screen.getByText('300,000')).toBeInTheDocument();          // physician ceiling
    expect(screen.getByText('ไม่จำกัด / no cap')).toBeInTheDocument(); // auditor ceiling = 0
    expect(screen.getByText('ไม่มี / none')).toBeInTheDocument();     // no excluded councils
  });

  it('reads a NULL ceiling as "no cap" too, with an empty input rather than the string "null"', async () => {
    await renderCard({ ...USAGE, standard_limit_tokens: null, auditor_standard_limit_tokens: null });
    expect(screen.getAllByText('ไม่จำกัด / no cap')).toHaveLength(2);
    expect(screen.getByRole('spinbutton', { name: /Physician token ceiling/ })).toHaveValue(null);
  });

  it('re-sends the value on screen when Save is pressed without typing', async () => {
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.click(screen.getByRole('button', { name: /Save Transcript cap/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(patchCalls()[0][1].body).toBe(JSON.stringify({ ple_max_transcript_tokens: 64000 }));
  });

  it('saves one field through PATCH /admin/usage-settings, then re-reads and hands the fresh settings up', async () => {
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Transcript cap/ }), { target: { value: '96000' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Transcript cap/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(patchCalls()).toEqual([
      ['/admin/usage-settings', { method: 'PATCH', body: JSON.stringify({ ple_max_transcript_tokens: 96000 }) }],
    ]);
    // The value shown comes from the re-read GET, not from the PATCH echo (which lacks the key).
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ple_max_transcript_tokens: 96_000 }));
    expect(screen.getByText('บันทึกแล้ว / Saved')).toBeInTheDocument();
  });

  it('refuses a value outside the backend bounds before any request is made', async () => {
    await renderCard(USAGE);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Warn at/ }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Warn at/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/50 to 95/);
    expect(patchCalls()).toHaveLength(0);
  });

  it('refuses a non-integer and an empty value the same way', async () => {
    await renderCard(USAGE);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Drain concurrency/ }), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Drain concurrency/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 to 8/);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Drain concurrency/ }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Drain concurrency/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 to 8/);
    expect(patchCalls()).toHaveLength(0);
  });

  it('accepts 0 on a token ceiling (= no cap) and sends it as a number', async () => {
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Physician token ceiling/ }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Physician token ceiling/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(patchCalls()[0][1].body).toBe(JSON.stringify({ standard_limit_tokens: 0 }));
  });

  it('upper-cases and trims council codes before sending them', async () => {
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.change(screen.getByRole('textbox', { name: /Exclude councils/ }), { target: { value: ' sandbox, demo ,, ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Exclude councils/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(patchCalls()[0][1].body).toBe(JSON.stringify({ eval_drain_exclude_councils: 'SANDBOX,DEMO' }));
  });

  it('refuses council codes with characters the backend regex would reject', async () => {
    await renderCard(USAGE);
    fireEvent.change(screen.getByRole('textbox', { name: /Exclude councils/ }), { target: { value: 'SANDBOX;DROP' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Exclude councils/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid council codes/);
    expect(patchCalls()).toHaveLength(0);
  });

  it("surfaces the API's error envelope and leaves the parent's settings untouched", async () => {
    wire({ patch: { error: 'Settings are read-only during the smoke' } });
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Eval p50/ }), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Eval p50/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings are read-only during the smoke');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to the value it sent when the re-read fails, so the card never goes blank', async () => {
    wire({ get: { error: 'network' } });
    const onChange = jest.fn();
    await renderCard(USAGE, onChange);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Eval p50/ }), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Eval p50/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...USAGE, eval_p50_seconds: 120 }));
  });
});

describe('LocalAiCapacityCard — queue now', () => {
  it('renders queued · scoring · oldest wait (m:ss) · drain state from /health/deep', async () => {
    await renderCard(USAGE);
    await waitFor(() => expect(within(queueRow()).getByText(/queued/)).toHaveTextContent('3'));
    expect(within(queueRow()).getByText(/scoring/)).toHaveTextContent('2');
    expect(within(queueRow()).getByText(/oldest wait/)).toHaveTextContent('1:05');
    expect(within(queueRow()).getByText(/^drain/)).toHaveTextContent('ทำงาน / running');
    expect(within(queueRow()).queryByText(/last error/)).not.toBeInTheDocument();
  });

  it('shows the drain as stopped and surfaces its last error', async () => {
    wire({ health: { status: 'degraded', checks: { eval_queue: { queued: 12, scoring: 0, oldest_wait_s: 4500,
      drain: { running: false, in_flight: 0, last_tick_at: null, last_error: '503:rimpl_down' } } } } });
    await renderCard(USAGE);
    await waitFor(() => expect(within(queueRow()).getByText(/^drain/)).toHaveTextContent('หยุด / stopped'));
    expect(within(queueRow()).getByText(/oldest wait/)).toHaveTextContent('75:00');   // minutes are not folded into hours
    expect(within(queueRow()).getByText(/last error/)).toHaveTextContent('503:rimpl_down');
  });

  it('degrades to "—" when the probe is unreachable, and the settings still render', async () => {
    wire({ health: { error: 'เครือข่ายขัดข้อง / Network error.' } });
    await renderCard(USAGE);
    await waitFor(() => expect(within(queueRow()).getByText(/queue status unavailable/)).toBeInTheDocument());
    for (const label of [/queued/, /scoring/, /oldest wait/, /^drain/]) {
      expect(within(within(queueRow()).getByText(label)).getByText('—')).toBeInTheDocument();
    }
    expect(screen.getByText('300,000')).toBeInTheDocument();
  });

  it('renders "—" for the counts when only the drain block came back (the count query timed out)', async () => {
    wire({ health: { status: 'ok', checks: { eval_queue: { drain: { running: true, in_flight: 0 }, error: 'timeout' } } } });
    await renderCard(USAGE);
    await waitFor(() => expect(within(queueRow()).getByText(/^drain/)).toHaveTextContent('ทำงาน / running'));
    expect(within(within(queueRow()).getByText(/queued/)).getByText('—')).toBeInTheDocument();
    expect(within(queueRow()).getByText(/last error/)).toHaveTextContent('timeout');
  });

  it('degrades the same way if the fetch layer ever REJECTS (apiFetch resolves envelopes by contract, but the card must not depend on it)', async () => {
    apiFetch.mockImplementation((path: string) =>
      path === '/health/deep' ? Promise.reject(new Error('boom')) : Promise.resolve(USAGE));
    render(<LocalAiCapacityCard usage={USAGE} onChange={() => {}} />);
    await settled();
    await waitFor(() => expect(within(queueRow()).getByText(/queue status unavailable/)).toBeInTheDocument());
    expect(screen.getByText('300,000')).toBeInTheDocument();
  });

  it('re-reads the probe on Refresh', async () => {
    await renderCard(USAGE);
    await waitFor(() => expect(within(queueRow()).getByText(/queued/)).toHaveTextContent('3'));
    const before = apiFetch.mock.calls.filter(([p]) => p === '/health/deep').length;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(apiFetch.mock.calls.filter(([p]) => p === '/health/deep').length).toBe(before + 1));
  });
});
