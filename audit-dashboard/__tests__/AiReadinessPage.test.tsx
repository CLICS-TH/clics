// /admin/ai-readiness renders rimpl's /health/deep `checks` as relayed by backend
// GET /admin/ai-readiness (backend/src/routes/superadmin.js) — `{ reachable, checks, models, routing,
// embedding }`. What has to be RIGHT here: a check's status is read the way rimpl reads it
// (rimpl/src/routes/health.js: `up` and `warn` serve, everything else does not), so
//   - `warn` (today only r3_distinct_models, rimpl services/ai.js readiness()) is its own amber state
//     with its `warning` text — never the red "Down" it rendered as before this state existed;
//   - `down` renders exactly as it always has;
//   - a status the screen does not know, or none at all, is Down (the endpoint already counted it as
//     not serving), says what arrived, and never crashes the table.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import AiReadinessPage from '@/app/admin/ai-readiness/page';

const R3_WARNING = 'local-tutor is configured to the same endpoint and model as local (the evaluator): '
  + 'LOCAL_TUTOR_AI_BASE_URL + LOCAL_TUTOR_AI_MODEL equal LOCAL_AI_BASE_URL + LOCAL_AI_MODEL, so the tutor '
  + 'and the evaluator are one model artifact (CCME R3 requires two)';

const body = (over: Record<string, unknown> = {}) => ({
  reachable: true, checks: {}, models: null, routing: null, embedding: null, ...over,
});
const wire = (b: unknown) => { apiFetch.mockReset(); apiFetch.mockResolvedValue(b); };

// The table row whose first cell is the check's key.
async function row(name: string) {
  const cell = await screen.findByRole('cell', { name });
  return cell.closest('tr') as HTMLElement;
}
const cells = (tr: HTMLElement) => within(tr).getAllByRole('cell');

const UP = 'พร้อม / Up';
const WARN = 'คำเตือน / Warning';
const DOWN = 'ไม่พร้อม / Down';

describe('AI readiness — check status', () => {
  it('renders `warn` as an amber Warning with its text, never as Down or Up', async () => {
    wire(body({ checks: {
      local: { status: 'up', model: 'qwen3-32b', context_length: 32768, min_context: 16384 },
      r3_distinct_models: { status: 'warn', warning: R3_WARNING },
    } }));
    render(<AiReadinessPage />);
    const tr = await row('r3_distinct_models');
    const [, status, model, context] = cells(tr);

    const label = within(status).getByText(WARN);
    expect(label).toHaveClass('text-warn');
    expect(label).not.toHaveClass('text-danger');
    // Not colour alone: an icon sits inside the label, beside the words.
    expect(label.querySelector('svg')).toBeInTheDocument();
    expect(within(status).getByText(R3_WARNING)).toBeInTheDocument();
    expect(within(tr).queryByText(DOWN)).not.toBeInTheDocument();
    expect(within(tr).queryByText(UP)).not.toBeInTheDocument();
    // A comparison has no model and no context window: neutral dashes, not red ones, not "Unknown".
    expect(model).toHaveTextContent('—');
    expect(context).toHaveTextContent('—');
    expect(context.querySelector('.text-danger')).toBeNull();
    expect(within(context).queryByText(/Unknown/)).not.toBeInTheDocument();
    expect(tr.querySelector('.text-danger')).toBeNull();

    // The serving provider beside it is untouched by the warning.
    const local = await row('local');
    expect(within(local).getByText(UP)).toHaveClass('text-ok');
  });

  it('a `warn` check that does report a context window still shows it', async () => {
    wire(body({ checks: {
      tutor_measured: { status: 'warn', warning: 'w1', context_length: 8192 },
      tutor_unread: { status: 'warn', warning: 'w2', context_length: 'unknown' },
      tutor_silent: { status: 'warn' },
    } }));
    render(<AiReadinessPage />);
    expect(cells(await row('tutor_measured'))[3]).toHaveTextContent('8,192');
    expect(within(cells(await row('tutor_unread'))[3]).getByText(/ไม่ทราบ \/ Unknown/)).toBeInTheDocument();
    // A warning with no text still reads as a Warning — the label never depends on the text.
    const silent = await row('tutor_silent');
    expect(within(silent).getByText(WARN)).toHaveClass('text-warn');
    expect(cells(silent)[1].querySelectorAll('p')).toHaveLength(0);
  });

  it('renders `down` exactly as before: red Down, its error, a red dash for context', async () => {
    wire(body({ checks: {
      anthropic_provider: { status: 'down', error: 'ANTHROPIC_API_KEY is not set', warning: 'not shown on down' },
    } }));
    render(<AiReadinessPage />);
    const tr = await row('anthropic_provider');
    const [, status, model, context] = cells(tr);

    const label = within(status).getByText(DOWN);
    expect(label).toHaveClass('text-danger');
    expect(label.querySelector('svg')).toBeInTheDocument();
    expect(within(status).getByText('ANTHROPIC_API_KEY is not set')).toBeInTheDocument();
    // A real `down` names no "unrecognised status" — that note is only for statuses the screen cannot read.
    expect(within(status).queryByText(/Unrecognised status|No status reported/)).not.toBeInTheDocument();
    expect(within(status).queryByText('not shown on down')).not.toBeInTheDocument();
    expect(within(tr).queryByText(WARN)).not.toBeInTheDocument();
    expect(model).toHaveTextContent('—');
    expect(within(context).getByText('—')).toHaveClass('text-danger');
  });

  it('falls back to Down for a status it does not know, or none — and says what arrived', async () => {
    wire(body({ checks: {
      future_check: { status: 'degraded', error: 'something new' },
      no_status: { model: 'm' },
      null_check: null,
      number_status: { status: 7 },
    } }));
    render(<AiReadinessPage />);

    for (const name of ['future_check', 'no_status', 'null_check', 'number_status']) {
      const tr = await row(name);
      expect(within(tr).getByText(DOWN)).toHaveClass('text-danger');
      expect(within(tr).queryByText(UP)).not.toBeInTheDocument();
      expect(within(tr).queryByText(WARN)).not.toBeInTheDocument();
      expect(within(cells(tr)[3]).getByText('—')).toHaveClass('text-danger');
    }
    const future = await row('future_check');
    expect(within(future).getByText(/Unrecognised status/)).toHaveTextContent('สถานะที่ไม่รู้จัก / Unrecognised status degraded');
    expect(within(future).getByText('something new')).toBeInTheDocument();
    expect(within(await row('no_status')).getByText('ไม่มีสถานะ / No status reported')).toBeInTheDocument();
    expect(within(await row('null_check')).getByText('ไม่มีสถานะ / No status reported')).toBeInTheDocument();
    expect(within(await row('number_status')).getByText('ไม่มีสถานะ / No status reported')).toBeInTheDocument();
  });

  it('`up` keeps its readings: the context against its floor, or Unknown when it was not read', async () => {
    wire(body({ checks: {
      local: { status: 'up', model: 'qwen3-32b', context_length: 32768, min_context: 16384 },
      local_no_floor: { status: 'up', model: 'qwen3-32b', context_length: 32768 },
      supabase: { status: 'up' },
    } }));
    render(<AiReadinessPage />);
    const local = await row('local');
    expect(cells(local)[2]).toHaveTextContent('qwen3-32b');
    expect(within(cells(local)[3]).getByText('32,768')).toHaveClass('text-ok');
    expect(cells(local)[3]).toHaveTextContent('/ ต้องการ 16,384');
    expect(cells(await row('local_no_floor'))[3]).not.toHaveTextContent('ต้องการ');
    expect(within(cells(await row('supabase'))[3]).getByText(/ไม่ทราบ \/ Unknown/)).toBeInTheDocument();
  });
});

describe('AI readiness — the rest of the screen', () => {
  it('says RIMPL could not be reached, with the reason', async () => {
    wire({ reachable: false, error: 'fetch failed', checks: {}, models: null, routing: null, embedding: null });
    render(<AiReadinessPage />);
    expect(await screen.findByText(/Could not reach the RIMPL layer/)).toBeInTheDocument();
    expect(screen.getByText('fetch failed')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('an {error} envelope from apiFetch shows the banner, not an empty table', async () => {
    wire({ error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error. Please try again.' });
    render(<AiReadinessPage />);
    expect(await screen.findByText(/Network error/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a rejected fetch is reported as a failed probe', async () => {
    apiFetch.mockReset();
    apiFetch.mockRejectedValue(new Error('boom'));
    render(<AiReadinessPage />);
    expect(await screen.findByText('ไม่สามารถตรวจสอบได้ / Probe failed')).toBeInTheDocument();
  });

  it('re-check fetches again and shows its pending label meanwhile', async () => {
    wire(body({ checks: { supabase: { status: 'up' } } }));
    render(<AiReadinessPage />);
    const btn = await screen.findByRole('button', { name: /ตรวจซ้ำ \/ Re-check/ });
    let release: (v: unknown) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: /กำลังตรวจ \/ Checking/ })).toBeDisabled();
    release(body({ checks: { supabase: { status: 'up' } } }));
    await screen.findByRole('button', { name: /ตรวจซ้ำ \/ Re-check/ });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenCalledWith('/admin/ai-readiness');
  });

  it('embedding: a fitting dimension against the corpus, a misfit with its reason, and an unmeasurable one', async () => {
    wire(body({ embedding: { provider: 'openai', model: 'text-embedding-3-small', fit: true, dimension: 1536, required: 1536, reason: null } }));
    const first = render(<AiReadinessPage />);
    const fit = await screen.findByText('1,536');
    expect(fit).toHaveClass('text-ok');
    expect(screen.getByText('/ คลังเอกสาร 1,536')).toBeInTheDocument();
    first.unmount();

    wire(body({ embedding: { provider: 'local', model: null, fit: false, dimension: 1024, required: null, reason: 'corpus is 1536-d' } }));
    const second = render(<AiReadinessPage />);
    const misfit = await screen.findByText('1,024');
    expect(misfit).toHaveClass('text-danger');
    expect(screen.queryByText(/คลังเอกสาร/)).not.toBeInTheDocument();
    expect(screen.getByText('corpus is 1536-d')).toBeInTheDocument();
    second.unmount();

    wire(body({ embedding: { provider: 'local', model: 'bge-m3', fit: false, dimension: null, required: 1536, reason: null } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/วัดไม่ได้ \/ Not measurable/)).toBeInTheDocument();
  });

  it('lists which provider serves each purpose, and when the evaluator was locked', async () => {
    wire(body({
      models: { chat: { provider: 'local-tutor', model: 'tutor-7b' }, evaluate: { provider: 'local', model: null } },
      routing: { source: 'database', evaluator_locked_at: '2026-10-14T03:00:00Z' },
    }));
    const first = render(<AiReadinessPage />);
    expect(await screen.findByText('tutor-7b')).toBeInTheDocument();
    expect(screen.getByText('local-tutor')).toBeInTheDocument();
    expect(screen.getByText(/Evaluator locked at 2026-10-14T03:00:00Z/)).toBeInTheDocument();
    first.unmount();

    wire(body({ models: { chat: { provider: 'anthropic', model: 'claude' } }, routing: { source: 'env' } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText('claude')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Evaluator locked at/)).not.toBeInTheDocument());
  });
});
