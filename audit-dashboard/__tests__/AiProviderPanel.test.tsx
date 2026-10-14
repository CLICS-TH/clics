// AiProviderPanel chooses which model serves each AI purpose. What has to be RIGHT here: every choice
// the backend offers is rendered (chat and discuss offer THREE since the on-prem tutor, the rest two),
// the selected radio is the one the API reports and moves only when a PATCH echoes the new value back,
// the evaluator never changes without the typed phrase, and a locked evaluator cannot be clicked at
// all. The response shape mirrors readAiProviders() in backend/src/routes/superadmin.js.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { AiProviderPanel } from '@/components/AiProviderPanel';

const CHOICES = {
  chat: ['anthropic', 'local', 'local-tutor'],
  evaluate: ['anthropic', 'local'],
  criteria: ['anthropic', 'local'],
  discuss: ['anthropic', 'local', 'local-tutor'],
  embed: ['openai', 'local'],
};
const PROVIDERS = { chat: 'anthropic', evaluate: 'anthropic', criteria: 'anthropic', discuss: 'anthropic', embed: 'openai' };
const PHRASES = { change_evaluator: 'CHANGE EVALUATOR', unlock_evaluator: 'UNLOCK EVALUATOR', switch_unfit: 'SWITCH ANYWAY', replace_lock: 'REPLACE THE LOCK' };
type Shape = { providers: typeof PROVIDERS; choices: Record<string, string[]>; evaluator_locked_at: string | null; confirm_phrases: typeof PHRASES };
const shape = (over: Partial<Shape> = {}): Shape => ({ providers: { ...PROVIDERS }, choices: CHOICES, evaluator_locked_at: null, confirm_phrases: PHRASES, ...over });

// GET answers with `get`; a PATCH answers with `patch(body)` (default: echo the change, as the backend does).
function wire(get: unknown = shape(), patch?: (b: Record<string, unknown>) => unknown) {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, opts?: RequestInit) => {
    if (path !== '/admin/ai-providers') return Promise.resolve({ error: `unexpected ${path}` });
    if (opts?.method !== 'PATCH') return Promise.resolve(get);
    const body = JSON.parse(String(opts.body));
    if (patch) return Promise.resolve(patch(body));
    const s = shape();
    if (body.purpose) (s.providers as Record<string, string>)[body.purpose] = body.provider;
    if (body.evaluator_locked === true) s.evaluator_locked_at = '2026-10-14T03:00:00Z';
    return Promise.resolve(s);
  });
}
const group = (en: string) => screen.getByRole('radiogroup', { name: `${en} provider` });
const radios = (en: string) => within(group(en)).getAllByRole('radio');
const checked = (en: string) => within(group(en)).getByRole('radio', { checked: true });
const patches = () => apiFetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').map(([, o]) => JSON.parse(o.body));
const loaded = () => screen.findByRole('radiogroup', { name: 'Physician chat provider' });

beforeEach(() => wire());

describe('AiProviderPanel — choices', () => {
  it('shows a skeleton, then every choice the API offers: three for chat and discuss, two elsewhere', async () => {
    const { container } = render(<AiProviderPanel />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
    await loaded();
    expect(radios('Physician chat')).toHaveLength(3);
    expect(radios('Auditor calibration tutor')).toHaveLength(3);
    expect(radios('C1–C6 screening')).toHaveLength(2);
    expect(radios('PIS-7 evaluator')).toHaveLength(2);
    expect(radios('Reference retrieval (RAG)')).toHaveLength(2);
    // The tutor is offered where the backend offers it, and nowhere else.
    expect(within(group('Physician chat')).getByRole('radio', { name: /โมเดลผู้สอนในองค์กร.*on-premise tutor/ })).toBeInTheDocument();
    expect(within(group('Auditor calibration tutor')).getByRole('radio', { name: /on-premise tutor/ })).toBeInTheDocument();
    expect(within(group('PIS-7 evaluator')).queryByRole('radio', { name: /tutor/ })).not.toBeInTheDocument();
    expect(within(group('C1–C6 screening')).queryByRole('radio', { name: /tutor/ })).not.toBeInTheDocument();
  });

  it('labels each option with WHERE the data goes, as its own text (not only a tooltip)', async () => {
    render(<AiProviderPanel />);
    await loaded();
    const tutor = within(group('Physician chat')).getByRole('radio', { name: /on-premise tutor/ });
    expect(within(tutor).getByText('โมเดลผู้สอนในองค์กร')).toBeInTheDocument();
    expect(within(tutor).getByText('on-premise tutor')).toBeInTheDocument();
    expect(tutor).toHaveAttribute('title', 'โมเดลผู้สอนในองค์กร — on-premise tutor');
    expect(checked('Physician chat')).toHaveAccessibleName(/Claude/);
    expect(checked('Reference retrieval (RAG)')).toHaveAccessibleName(/OpenAI/);
  });

  it('marks the provider the API reports as selected, including the tutor', async () => {
    wire(shape({ providers: { ...PROVIDERS, discuss: 'local-tutor' } }));
    render(<AiProviderPanel />);
    await loaded();
    expect(checked('Auditor calibration tutor')).toHaveAccessibleName(/on-premise tutor/);
    expect(radios('Auditor calibration tutor').filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('renders a provider it has no copy for by its key rather than dropping it', async () => {
    wire(shape({ choices: { ...CHOICES, criteria: ['anthropic', 'mystery'] } }));
    render(<AiProviderPanel />);
    await loaded();
    const m = within(group('C1–C6 screening')).getByRole('radio', { name: /mystery/ });
    expect(m).toHaveAttribute('title', 'mystery — mystery');
  });

  // jsdom cannot measure a layout, so this pins the classes that the browser measurement depends on.
  // With three choices, a `shrink-0` group pushed the options 300–370px past the card on 320–390px
  // phones and squeezed the description beside it to ~30px at 768px. A wrapping group of nowrap
  // labels measured clean at 320/375/390/768/1280, light and dark.
  it('lets the options wrap instead of overflowing, and never splits a label', async () => {
    render(<AiProviderPanel />);
    await loaded();
    const g = group('Physician chat');
    expect(g).toHaveClass('flex-wrap');
    expect(g).not.toHaveClass('shrink-0');
    expect(g).not.toHaveClass('overflow-hidden');   // it clipped the focus outline
    for (const r of radios('Physician chat')) {
      r.querySelectorAll('span').forEach(s => expect(s).toHaveClass('whitespace-nowrap'));
    }
  });

  it('every option is a real button, so it is reachable by Tab and activates on Enter/Space', async () => {
    render(<AiProviderPanel />);
    await loaded();
    for (const r of radios('Physician chat')) {
      expect(r.tagName).toBe('BUTTON');
      expect(r).not.toHaveAttribute('tabindex', '-1');
      expect(r).toBeEnabled();
    }
  });
});

describe('AiProviderPanel — operational switches', () => {
  it('switches chat to the tutor with one PATCH and moves the selection only once the API echoes it', async () => {
    let release: (v: unknown) => void = () => {};
    wire(shape(), (b) => new Promise(res => { release = () => res({ ...shape(), providers: { ...PROVIDERS, chat: b.provider as string } }); }));
    render(<AiProviderPanel />);
    await loaded();
    const tutor = within(group('Physician chat')).getByRole('radio', { name: /on-premise tutor/ });
    tutor.focus();
    fireEvent.click(tutor);
    expect(patches()).toEqual([{ purpose: 'chat', provider: 'local-tutor' }]);
    // In flight: this purpose's options are aria-disabled, NOT disabled — a disabled button blurs, and
    // a keyboard user would land back on <body>. The old choice is still the selected one.
    radios('Physician chat').forEach(r => { expect(r).toHaveAttribute('aria-disabled', 'true'); expect(r).toBeEnabled(); });
    expect(tutor).toHaveFocus();
    expect(radios('C1–C6 screening')[0]).not.toHaveAttribute('aria-disabled');
    expect(checked('Physician chat')).toHaveAccessibleName(/Claude/);
    // A second press while the first save is in flight sends nothing.
    fireEvent.click(within(group('Physician chat')).getByRole('radio', { name: /DGX/ }));
    expect(patches()).toHaveLength(1);
    release(null);
    await waitFor(() => expect(checked('Physician chat')).toHaveAccessibleName(/on-premise tutor/));
  });

  it('does nothing when the already-selected option is pressed', async () => {
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(checked('Physician chat'));
    expect(patches()).toEqual([]);
  });

  it('keeps the old selection and shows the API error when a switch is refused', async () => {
    wire(shape(), () => ({ error: '"local-tutor" cannot serve criteria.', code: 'invalid_provider' }));
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(within(group('Auditor calibration tutor')).getByRole('radio', { name: /on-premise tutor/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot serve criteria');
    expect(checked('Auditor calibration tutor')).toHaveAccessibleName(/Claude/);
  });

  it('falls back to a generic message when a failed save carries no error text', async () => {
    wire(shape(), () => undefined);
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(within(group('Physician chat')).getByRole('radio', { name: /DGX/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.');
  });
});

describe('AiProviderPanel — loading failures', () => {
  it('shows the API error instead of an endless skeleton', async () => {
    wire({ error: 'superadmin only' });
    render(<AiProviderPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('superadmin only');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('shows a generic message when the load resolves to nothing (a 401 resolves to undefined)', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(undefined);   // not wire(undefined): that would take the default fixture
    render(<AiProviderPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load provider settings.');
  });

  it('shows the generic message if the request itself rejects', async () => {
    apiFetch.mockReset();
    apiFetch.mockRejectedValue(new Error('boom'));
    render(<AiProviderPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load provider settings.');
  });
});

describe('AiProviderPanel — the evaluator', () => {
  it('asks for the typed phrase before changing the evaluator, and sends it with the change', async () => {
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(within(group('PIS-7 evaluator')).getByRole('radio', { name: /DGX/ }));
    expect(patches()).toEqual([]);
    expect(screen.getByText('เปลี่ยนผู้ให้คะแนน PIS-7 เป็น DGX ในองค์กร?')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'ยืนยัน / Confirm' });
    expect(confirm).toBeDisabled();
    const input = screen.getByLabelText(/Type it to confirm/);
    fireEvent.change(input, { target: { value: 'change evaluator' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'CHANGE EVALUATOR' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(checked('PIS-7 evaluator')).toHaveAccessibleName(/DGX/));
    expect(patches()).toEqual([{ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR' }]);
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
  });

  it('names an unknown evaluator provider by its key in the confirmation', async () => {
    wire(shape({ choices: { ...CHOICES, evaluate: ['anthropic', 'mystery'] } }));
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(within(group('PIS-7 evaluator')).getByRole('radio', { name: /mystery/ }));
    expect(screen.getByText('เปลี่ยนผู้ให้คะแนน PIS-7 เป็น mystery?')).toBeInTheDocument();
  });

  it('Cancel drops the pending change without a PATCH', async () => {
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(within(group('PIS-7 evaluator')).getByRole('radio', { name: /DGX/ }));
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก / Cancel' }));
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
    expect(patches()).toEqual([]);
    expect(checked('PIS-7 evaluator')).toHaveAccessibleName(/Claude/);
  });

  it('locks the evaluator with one PATCH', async () => {
    render(<AiProviderPanel />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Lock the evaluator for the pilot/ }));
    await screen.findByText(/locked/, { selector: 'span' });
    expect(patches()).toEqual([{ evaluator_locked: true }]);
  });

  it('once locked, the evaluator options are disabled and unlocking needs its own phrase', async () => {
    wire(shape({ evaluator_locked_at: '2026-10-14T03:00:00Z' }),
      () => shape());
    render(<AiProviderPanel />);
    await loaded();
    radios('PIS-7 evaluator').forEach(r => expect(r).toBeDisabled());
    // Locking the evaluator does not freeze the operational purposes.
    radios('Physician chat').forEach(r => expect(r).toBeEnabled());
    fireEvent.click(radios('PIS-7 evaluator')[1]);
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ปลดล็อก / Unlock…' }));
    expect(screen.getByText('ปลดล็อกผู้ให้คะแนน PIS-7?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Type it to confirm/), { target: { value: 'UNLOCK EVALUATOR' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน / Confirm' }));
    await waitFor(() => expect(radios('PIS-7 evaluator')[1]).toBeEnabled());
    expect(patches()).toEqual([{ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' }]);
  });
});
