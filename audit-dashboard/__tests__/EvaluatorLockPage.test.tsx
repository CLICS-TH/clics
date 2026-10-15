// /admin/evaluator-lock — the Model Lock declaration (CCME R2, GitHub #75). The shapes mirror GET/POST
// /admin/evaluator-lock in backend/src/routes/superadmin.js and services/model-lock.js (PR 6b).
//
// What has to be RIGHT here:
//   - a load that failed (503 / 500 / 403 / 401 / a shape it cannot read) is an ERROR, never rendered
//     as "gate not passed" or as an empty, unlocked screen;
//   - every blocker the backend sends is its own bilingual reason, with what it needs to act on it;
//   - the form pre-fills what the manifest states, marks it, and says before sending when a value
//     would be refused as a manifest mismatch;
//   - validation repeats the server's rules, so the form never offers a submit the API would 400;
//   - a refusal stays on the page (not only in the 4.5 s toast), a 401 is a failure, and a
//     re-declaration needs the typed phrase.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const toast = jest.fn();
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => toast(...a) }));

import EvaluatorLockPage from '@/app/admin/evaluator-lock/page';
import { emptyForm, validate, buildBody, decodingValue, manifestValue, fmtValue, fmtDate, shortSha, differsFromManifest } from '@/lib/evaluator-lock';

const PV = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const RV = 'pis7-weights-08b0cb1a';
const MV = 'CCME_LLM_v8.0+qwen-2.5-72b';
const MSHA = 'f'.repeat(64);
const ESHA = 'e'.repeat(64);
const DIGEST = 'a'.repeat(64);
const PHRASE = 'REPLACE THE LOCK';
const T = '2026-10-15T03:00:00.000Z';

const CANDIDATE = { provider: 'local', model_version: MV, prompt_version: PV, rubric_versions: [RV] };
const GATE = {
  state: 'pass', threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 60, why: 'the whole interval is at or above 0.75',
  groups: [
    { provider: 'local', model_version: MV, prompt_version: PV, rows: 60, rubric_versions: [RV], latest: T },
    { provider: 'local', model_version: MV, prompt_version: null, rows: 4, rubric_versions: [null], latest: null },
  ],
};
const MANIFEST = {
  ok: true, sha256: MSHA, file: 'present', code_match: true, drift_keys: [],
  expected_for_candidate: {
    prompt_version: PV, rubric_version: RV, model_version: MV, provider_declared: 'local',
    decoding: { max_tokens: { default: 1500, env: 'EVAL_MAX_TOKENS' }, temperature: 0 },
    declared: { engine: 'vllm', model: 'qwen-2.5-72b' }, evaluator_sha256: ESHA,
  },
};
type State = Record<string, unknown>;
const state = (over: State = {}): State => ({
  locked_at: null, current: null, in_force: false, candidate: CANDIDATE, serving_provider: 'local',
  can_declare: true, blockers: [], blocker_detail: {}, gate: GATE, manifest: MANIFEST, manifest_diff: [],
  migrations_pending: [], confirm_phrases: { replace_lock: PHRASE }, ...over,
});
const RECORD = {
  id: 'r1', locked_at: T, provider: 'local', model_version: MV, weights_sha256: DIGEST, inference_engine: 'vllm 0.21.1',
  quantization: 'Q8_0', system_prompt_version: 'sys-v3', evaluator_prompt_version: PV, rubric_version: RV,
  decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: null }, environment: { os: 'ubuntu 24.04', cuda: '12.4' },
  note: 'first freeze', manifest_sha256: MSHA, evaluator_sha256: ESHA,
};
const OK = { ok: true, locked_at: T, record: RECORD, manifest_sha256: MSHA, evaluator_sha256: ESHA };

// GET answers with `get` (a value, or a function of the call number); POST with `post(body)`.
let gets = 0;
type Get = ((n: number) => unknown) | Record<string, unknown> | undefined;
function wire(get: Get = state(), post?: (b: Record<string, unknown>) => unknown) {
  gets = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, opts?: RequestInit) => {
    if (path !== '/admin/evaluator-lock') return Promise.resolve({ error: `unexpected ${path}` });
    if (opts?.method === 'POST') return Promise.resolve(post ? post(JSON.parse(String(opts.body))) : OK);
    gets++;
    return Promise.resolve(typeof get === 'function' ? get(gets) : get);
  });
}
const posts = () => apiFetch.mock.calls.filter(([, o]) => o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
const getCount = () => apiFetch.mock.calls.filter(([, o]) => o?.method !== 'POST').length;
const formReady = () => screen.findByRole('form', { name: /Declare what the system cannot read/ });
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(field(label), { target: { value } });
const submitBtn = () => screen.getByRole('button', { name: /Freeze it|Replace the lock|Saving/ });
const fillRequired = () => {
  type(/Weights SHA-256/, DIGEST);
  type(/System prompt version/, 'sys-v3');
};

beforeEach(() => { wire(); toast.mockReset(); });

describe('Model Lock — a load that failed is an error, never a verdict', () => {
  const noVerdict = () => {
    expect(screen.queryByText(/Decisive gate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not yet decidable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Why the lock cannot be declared/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not locked/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  };

  it('shows a loading state first', () => {
    apiFetch.mockReset();
    apiFetch.mockReturnValue(new Promise(() => {}));
    render(<EvaluatorLockPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the lock state');
  });

  it('503 lock_state_unreadable: says the state could not be read, and Retry re-reads it', async () => {
    const msg = 'อ่านสถานะการล็อกผู้ให้คะแนนไม่ได้ในขณะนี้ / The evaluator lock state could not be read, so nothing was changed. Please try again.';
    wire((n) => (n === 1 ? { error: msg, code: 'lock_state_unreadable', httpStatus: 503 } : state()));
    render(<EvaluatorLockPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The lock state could not be read');
    expect(alert).toHaveTextContent(msg);
    expect(alert).toHaveTextContent('unreadable is not unlocked');
    noVerdict();
    fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่ / Retry' }));
    await formReady();
    expect(getCount()).toBe(2);
  });

  it.each([
    [{ error: 'อ่านข้อมูลการล็อกผู้ให้คะแนนไม่สำเร็จ / The evaluator lock could not be read.', code: 'lock_read_failed', detail: 'connection reset', httpStatus: 500 },
      'The lock could not be read', /could not be read\. — connection reset/],
    [{ error: 'superadmin only', httpStatus: 403 }, 'Superadmin only', /superadmin only/],
    [{ error: 'Not found', httpStatus: 404 }, 'This page could not be loaded', /Not found/],
    [{ error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error. Please try again.' }, 'This page could not be loaded', /Network error/],
    [{ locked_at: null }, 'This page could not be loaded', /shape this page cannot read/],
    [{ error: { fieldErrors: { x: ['bad'] } }, httpStatus: 400 }, 'This page could not be loaded', /\{"x":\["bad"\]\}/],
  ])('%j → %s', async (body, title, message) => {
    wire(body);
    render(<EvaluatorLockPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('[object Object]');
    noVerdict();
  });

  it('a 401 (apiFetch resolves undefined) is a session error, not an empty screen', async () => {
    wire(undefined);
    apiFetch.mockImplementation(() => Promise.resolve(undefined));
    render(<EvaluatorLockPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired');
    noVerdict();
  });

  it('a rejected request is a network error', async () => {
    apiFetch.mockReset();
    apiFetch.mockRejectedValue(new Error('boom'));
    render(<EvaluatorLockPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    noVerdict();
  });
});

describe('Model Lock — every blocker is its own reason', () => {
  const blocked = (blockers: string[], over: State = {}) => state({ can_declare: false, blockers, ...over });
  const item = (b: string) => document.querySelector(`[data-blocker="${b}"]`) as HTMLElement;

  it('closes the form and lists each blocker with its detail', async () => {
    wire(blocked(['gate_not_passed', 'no_candidate', 'manifest_unavailable', 'migration_required'], {
      candidate: null,
      gate: { ...GATE, state: 'insufficient', icc: 0.7, lower: 0.41, upper: 0.88, n: 8, why: 'the interval spans 0.75', groups: [] },
      manifest: { ok: false, code: 'manifest_unavailable', reason: 'code_mismatch', file: 'present', code_match: false,
        error: 'model manifest ไม่ตรงกับโค้ด / The committed model manifest is not what the running RIMPL code generates, so the evaluator cannot be locked (code_match: false).' },
      migrations_pending: ['db/migration-evaluator-model-lock.sql', 'db/migration-evaluator-lock-manifest.sql'],
    }));
    render(<EvaluatorLockPage />);
    expect(await screen.findByRole('heading', { name: /Why the lock cannot be declared yet \(4\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByText(/The form opens once none of the reasons above remains/)).toBeInTheDocument();

    // insufficient is "not yet decidable" — never worded as a failure.
    expect(item('gate_not_passed')).toHaveTextContent('has not cleared the decisive threshold');
    expect(item('gate_not_passed')).toHaveTextContent('ยังตัดสินไม่ได้ / Not yet decidable: the interval spans 0.75 (ICC 0.700, 95% CI [0.410, 0.880], n = 8)');
    expect(screen.queryByText(/Decisive gate not met/)).not.toBeInTheDocument();
    expect(item('no_candidate')).toHaveTextContent('No candidate model has shadow-scored');
    expect(screen.getByText('ยังไม่มี / None yet')).toBeInTheDocument();
    expect(item('manifest_unavailable')).toHaveTextContent('is not what the running RIMPL code generates');
    expect(item('manifest_unavailable')).toHaveTextContent('reason: code_mismatch · file: present');
    const files = within(item('migration_required')).getAllByRole('listitem').map((li) => li.textContent);
    expect(files).toEqual(['db/migration-evaluator-model-lock.sql', 'db/migration-evaluator-lock-manifest.sql']);
  });

  it('verdict_unavailable and lock_table_unreadable carry the backend detail', async () => {
    wire(blocked(['verdict_unavailable', 'lock_table_unreadable'], {
      gate: null, blocker_detail: { verdict_unavailable: 'shadow_evaluations: timeout', lock_table_unreadable: 'permission denied' },
    }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    expect(item('verdict_unavailable')).toHaveTextContent('The agreement verdict could not be computed.');
    expect(item('verdict_unavailable')).toHaveTextContent('shadow_evaluations: timeout');
    expect(item('lock_table_unreadable')).toHaveTextContent('permission denied');
    // No verdict: no gate panel, and nothing claims the gate failed.
    expect(document.querySelector('[data-gate]')).toBeNull();
  });

  it('candidate_not_evaluator names the provider', async () => {
    wire(blocked(['candidate_not_evaluator'], { candidate: { ...CANDIDATE, provider: 'local-tutor' } }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    expect(item('candidate_not_evaluator')).toHaveTextContent('Candidate provider: local-tutor');
    expect(item('candidate_not_evaluator')).toHaveTextContent('can never be the evaluator (CCME R3)');
  });

  it('candidate_not_serving shows candidate vs serving, and links to the switch', async () => {
    wire(blocked(['candidate_not_serving'], { serving_provider: 'anthropic' }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    expect(item('candidate_not_serving')).toHaveTextContent('Candidate local · ให้คะแนนอยู่ / Serving anthropic');
    expect(within(item('candidate_not_serving')).getByRole('link', { name: /Open the AI provider switch/ }))
      .toHaveAttribute('href', '/admin/overview#ai-provider');
    expect(screen.getByText(/Not the candidate/)).toHaveClass('text-danger');
  });

  it('manifest_mismatch shows the diff: field, measured value, what the manifest expects, where, and the source', async () => {
    wire(blocked(['manifest_mismatch'], { manifest_diff: [
      { field: 'model_version', source: 'candidate', value: 'CCME_LLM_v8.0+old', expected: MV, manifest_path: 'expected.code.model_version_prefix + expected.declared.local.model' },
      { field: 'candidate_rubric_versions', source: 'candidate', value: [RV, null], expected: RV, manifest_path: 'expected.code.evaluator.rubric_version' },
      { field: 'provider', source: 'odd', value: null, expected: null, manifest_path: 'expected.declared.providers.evaluate' },
    ] }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    const table = within(item('manifest_mismatch')).getByRole('region', { name: /Difference from the model manifest/ });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows[0]).toEqual(['model_version', 'CCME_LLM_v8.0+old', `${MV}expected.code.model_version_prefix + expected.declared.local.model`, 'วัดจากผู้ท้าชิง / Measured']);
    expect(rows[1]).toEqual(['candidate_rubric_versions', `${RV}, null`, `${RV}expected.code.evaluator.rubric_version`, 'วัดจากผู้ท้าชิง / Measured']);
    expect(rows[2]).toEqual(['provider', '— (ไม่มี / none)', '— (ไม่มี / none)expected.declared.providers.evaluate', 'odd']);
  });

  it('a blocker with nothing to add renders only its reason; an unknown blocker is named by its key', async () => {
    wire(blocked(['gate_not_passed', 'manifest_mismatch', 'migration_required', 'manifest_unavailable', 'lock_table_unreadable', 'future_blocker'], {
      gate: null, manifest_diff: null, migrations_pending: [], blocker_detail: {},
    }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared yet \(6\)/);
    for (const b of ['gate_not_passed', 'manifest_mismatch', 'migration_required', 'manifest_unavailable', 'lock_table_unreadable']) {
      expect(item(b).querySelectorAll('p')).toHaveLength(1);
    }
    expect(item('future_blocker')).toHaveTextContent('A reason this screen does not know: future_blocker');
  });

  it('a manifest_unavailable body without its optional fields still renders', async () => {
    wire(blocked(['manifest_unavailable'], { manifest: { ok: false } }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    expect(item('manifest_unavailable')).toHaveTextContent('reason: — · file: —');
  });
});

describe('Model Lock — the candidate, the gate and the manifest', () => {
  it('shows candidate vs serving, the verdict, the corpus groups and the manifest the lock would freeze', async () => {
    wire(state({ manifest: { ...MANIFEST, drift_keys: ['declared.providers.chat', 'declared.providers.evaluate'] } }));
    render(<EvaluatorLockPage />);
    await formReady();
    const panel = screen.getByRole('region', { name: /The candidate and the serving evaluator/ });
    expect(panel).toHaveTextContent(`local · ${MV}`);
    expect(panel).toHaveTextContent(PV);
    expect(within(panel).getByText(/Same as the candidate/)).toHaveClass('text-ok');
    expect(within(panel).getByText(/Decisive gate met/)).toHaveTextContent('ผ่านเกณฑ์ / Decisive gate met (≥ 0.75)');
    expect(panel).toHaveTextContent('ICC 0.820 · 95% CI [0.770, 0.900] · n = 60');
    expect(within(panel).getByText(/Groups in the corpus \(2\)/)).toBeInTheDocument();
    expect(panel).toHaveTextContent(`local · ${MV} · — · 4 rows`);

    const m = screen.getByRole('region', { name: 'Model manifest' });
    expect(within(m).getByText(`${MSHA.slice(0, 12)}…`)).toHaveAttribute('title', MSHA);
    expect(within(m).getByText(`${ESHA.slice(0, 12)}…`)).toHaveAttribute('title', ESHA);
    expect(m).toHaveTextContent('Matches the running code');
    expect(m).toHaveTextContent('2 live value(s) differ from the manifest');
    expect(m).toHaveTextContent('Expected while production runs every purpose on Claude');
  });

  it('a failed gate reads as failed; an unknown state by its name; missing numbers as dashes', async () => {
    wire(state({ can_declare: false, blockers: ['gate_not_passed'], serving_provider: null,
      candidate: { provider: null, model_version: null, prompt_version: null, rubric_versions: [] },
      gate: { ...GATE, state: 'fail', icc: null, lower: null, upper: null, groups: undefined },
      manifest: { ...MANIFEST, expected_for_candidate: null } }));
    const first = render(<EvaluatorLockPage />);
    expect(await screen.findByText(/Decisive gate not met \(≥ 0.75\)/)).toHaveClass('text-danger');
    expect(screen.getByText(/ICC — · 95% CI \[—, —\]/)).toBeInTheDocument();
    expect(screen.queryByText(/Groups in the corpus/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Same as the candidate|Not the candidate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Would freeze/)).not.toBeInTheDocument();
    first.unmount();

    wire(state({ gate: { ...GATE, state: 'mystery' } }));
    render(<EvaluatorLockPage />);
    expect(await screen.findByText(/mystery \(≥ 0.75\)/)).toBeInTheDocument();
  });
});

describe('Model Lock — the form: pre-fill and validation', () => {
  it('pre-fills what the manifest states, marks it, and leaves the rest blank', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    expect(field(/Evaluator prompt version/).value).toBe(PV);
    expect(field(/PIS-7 rubric version/).value).toBe(RV);
    expect(field(/Inference engine/).value).toBe('vllm');
    expect(field(/Temperature/).value).toBe('0');
    expect(field(/Max tokens/).value).toBe('1500');
    expect(field(/Top-p/).value).toBe('');
    expect(field(/^ค่า seed/).value).toBe('');
    expect(field(/Weights SHA-256/).value).toBe('');
    // Each pre-filled field says so, under the input and wired to it — not in the label, where the chip
    // wrapped and put two inputs side by side at different heights.
    expect(screen.getAllByText('จาก manifest / from manifest')).toHaveLength(5);
    const prompt = field(/Evaluator prompt version/);
    const marker = document.getElementById(prompt.getAttribute('aria-describedby')!.split(' ')[1])!;
    expect(marker).toHaveTextContent(`จาก manifest / from manifest${PV}`);
    expect(prompt.closest('div')!.querySelector('label')).not.toHaveTextContent('from manifest');
    // The engine is pre-filled but never compared: editing it drops its marker and never warns.
    type(/Inference engine/, 'vllm 0.21.1');
    expect(screen.getAllByText('จาก manifest / from manifest')).toHaveLength(4);
    expect(screen.getByText('ค่าจาก manifest / From the manifest: vllm')).toBeInTheDocument();
    expect(screen.queryByText(/Differs from the manifest/)).not.toBeInTheDocument();
    // A value equal to the manifest's numerically still carries the marker; a cleared one says what the manifest holds.
    type(/Temperature/, '0.0');
    expect(screen.getAllByText('จาก manifest / from manifest')).toHaveLength(4);
    type(/Temperature/, '');
    expect(screen.getByText('ค่าจาก manifest / From the manifest: 0')).toBeInTheDocument();
  });

  it('warns before sending when a compared value differs from the manifest', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    type(/Evaluator prompt version/, 'pis7-prompt-old');
    const warn = screen.getByText(`ต่างจาก manifest (${PV}) ระบบจะไม่ยอมล็อก / Differs from the manifest (${PV}); the lock will be refused.`);
    expect(warn).toHaveClass('text-warn');
    expect(field(/Evaluator prompt version/).getAttribute('aria-describedby')).toContain(warn.id);
    // Numerically: 0.0 is the manifest's 0, 2048 is not its 1500.
    type(/Temperature/, '0.0');
    type(/Max tokens/, '2048');
    expect(screen.getAllByText(/Differs from the manifest/)).toHaveLength(2);
  });

  it('every control has a label, required ones say so, and hints are wired with aria-describedby', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    for (const l of [/Weights SHA-256/, /Inference engine/, /System prompt version/, /Evaluator prompt version/, /PIS-7 rubric version/]) {
      expect(field(l)).toBeRequired();
      expect(field(l)).toHaveAttribute('aria-required', 'true');
      expect(field(l).getAttribute('aria-describedby')).toMatch(/-hint-0/);
    }
    expect(field(/Quantization/)).not.toBeRequired();
    expect(field(/Quantization/).closest('div')).toHaveTextContent('(ไม่บังคับ / optional)');
    expect(field(/Temperature/)).toHaveAttribute('inputmode', 'decimal');
    expect(field(/Max tokens/)).toHaveAttribute('inputmode', 'numeric');
    // Inputs come from ui/input (border-field, WCAG 1.4.11), never a bare `border`.
    for (const el of screen.getByRole('form').querySelectorAll('input:not([type=checkbox]), textarea')) {
      expect(el).toHaveAttribute('data-slot', expect.stringMatching(/^(input|textarea)$/));
    }
  });

  it('keeps submit closed until the required fields are there, and names what is missing', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent('ล็อกค่าโมเดล / Freeze it');
    const hint = screen.getByText(/still missing or invalid/);
    expect(hint).toHaveTextContent('2 field(s) still missing or invalid: Weights SHA-256, System prompt version.');
    expect(submitBtn()).toHaveAttribute('aria-describedby', hint.id);
    fillRequired();
    expect(submitBtn()).toBeEnabled();
    expect(screen.getByText(/The server re-checks the verdict and the manifest/)).toBeInTheDocument();
  });

  it('validates the weights digest as 64 hex characters', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    type(/Weights SHA-256/, 'abc');
    expect(screen.getByText('ต้องมี 64 ตัว ตอนนี้มี 3 ตัว / Must be 64 characters; this is 3.')).toHaveClass('text-danger');
    expect(field(/Weights SHA-256/)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/Weights SHA-256/).getAttribute('aria-describedby')).toContain('lock-weights_sha256-error');
    type(/Weights SHA-256/, `${'g'.repeat(64)}`);
    expect(screen.getByText(/Contains a character that is not hexadecimal/)).toBeInTheDocument();
    type(/Weights SHA-256/, DIGEST.toUpperCase());
    expect(screen.queryByText(/hexadecimal|Must be 64/)).not.toBeInTheDocument();
    expect(field(/Weights SHA-256/)).not.toHaveAttribute('aria-invalid');
  });

  it.each([
    [/Temperature/, 'abc', 'Must be a number.', 'Temperature'],
    [/Temperature/, '-1', 'Must not be negative.', 'Temperature'],
    [/Top-p/, '1.5', 'Must be between 0 and 1.', 'Top-p'],
    [/Top-p/, '-0.1', 'Must be between 0 and 1.', 'Top-p'],
    [/Max tokens/, '0', 'Must be at least 1.', 'Max tokens'],
    [/Max tokens/, '1.5', 'Must be a whole number.', 'Max tokens'],
    [/^ค่า seed/, '99999999999999999999', 'Too large.', 'Seed'],
    [/^ค่า seed/, 'x', 'Must be a whole number.', 'Seed'],
  ])('decoding %s = %j → %s', async (label, value, msg, name) => {
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    type(label, value);
    expect(screen.getByText(new RegExp(msg.replace(/[.]/g, '\\.')))).toHaveClass('text-danger');
    expect(submitBtn()).toBeDisabled();
    // The hint names the field that is invalid, not only the ones still empty.
    expect(screen.getByText(/still missing or invalid/)).toHaveTextContent(`1 field(s) still missing or invalid: ${name}.`);
  });

  it('validates environment rows, the note length and the 200-character text limit', async () => {
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    type(/Value 1/, 'ubuntu');
    expect(screen.getByText(/Name this entry/)).toBeInTheDocument();
    expect(field(/Name 1/)).toHaveAttribute('aria-invalid', 'true');
    type(/Name 1/, 'os');
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ / Add an entry' }));
    type(/Name 2/, 'os');
    expect(screen.getByText(/Same name as an earlier entry/)).toBeInTheDocument();
    type(/Name 2/, 'cuda');
    expect(submitBtn()).toBeEnabled();

    type(/Quantization/, 'q'.repeat(201));
    expect(screen.getByText(/Longer than 200 characters/)).toBeInTheDocument();
    type(/Quantization/, '');
    fireEvent.change(screen.getByLabelText(/^หมายเหตุ/), { target: { value: 'n'.repeat(4001) } });
    expect(screen.getByText(/Longer than 4,000 characters/)).toBeInTheDocument();
    expect(screen.getByText(/4,001 of 4,000 characters/)).toBeInTheDocument();
    type(/Name 2/, 'os');
    expect(screen.getByText(/still missing or invalid/)).toHaveTextContent('2 field(s) still missing or invalid: Environment, Note.');
    expect(submitBtn()).toBeDisabled();
  });

  it('"No seed is set" disables the seed and is sent as a stated null', async () => {
    wire(state(), () => OK);
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    type(/^ค่า seed/, 'x');
    fireEvent.click(screen.getByLabelText(/No seed is set/));
    expect(field(/^ค่า seed/)).toBeDisabled();
    expect(field(/^ค่า seed/).value).toBe('');
    expect(screen.queryByText(/Must be a whole number/)).not.toBeInTheDocument();
    fireEvent.click(submitBtn());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].decoding).toEqual({ temperature: 0, max_tokens: 1500, seed: null });
  });
});

describe('Model Lock — declaring', () => {
  it('sends the declaration, keeps the success on the page, resets the form and re-reads the state', async () => {
    let release: (v: unknown) => void = () => {};
    wire((n) => (n === 1 ? state() : state({ locked_at: T, current: RECORD, in_force: true })),
      () => new Promise((r) => { release = r; }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    type(/Quantization/, ' Q8_0 ');
    type(/Top-p/, '1');
    type(/^ค่า seed/, '7');
    type(/Name 1/, 'os');
    type(/Value 1/, 'ubuntu 24.04');
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ / Add an entry' }));
    type(/Name 2/, 'scratch');
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ / Add an entry' }));
    type(/Name 3/, 'cuda');
    type(/Value 3/, '12.4');
    fireEvent.click(screen.getByRole('button', { name: 'ลบ / Remove 2' }));
    fireEvent.change(screen.getByLabelText(/^หมายเหตุ/), { target: { value: '  first freeze  ' } });

    fireEvent.click(submitBtn());
    expect(submitBtn()).toHaveTextContent('กำลังบันทึก… / Saving…');
    expect(submitBtn()).toBeDisabled();
    fireEvent.submit(screen.getByRole('form'));   // a second submit while in flight sends nothing
    expect(posts()).toEqual([{
      weights_sha256: DIGEST, inference_engine: 'vllm', quantization: 'Q8_0', system_prompt_version: 'sys-v3',
      evaluator_prompt_version: PV, rubric_version: RV,
      decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: 7 },
      environment: { os: 'ubuntu 24.04', cuda: '12.4' }, note: 'first freeze',
    }]);
    release(OK);

    const done = await screen.findByText(`ล็อกแล้วเมื่อ ${new Date(T).toLocaleString('th-TH')} / Locked at ${new Date(T).toLocaleString('th-TH')}`);
    const panel = done.closest('[data-slot="state-message"]') as HTMLElement;
    expect(panel).toHaveTextContent(`manifest ${MSHA.slice(0, 12)}… · evaluator ${ESHA.slice(0, 12)}…`);
    expect(panel.parentElement).toHaveFocus();
    expect(toast).toHaveBeenCalledWith('ล็อกเรียบร้อย / Configuration frozen.', 'success');
    await waitFor(() => expect(getCount()).toBe(2));
    // The re-read shows the lock in force, and the form is empty again apart from the manifest pre-fill.
    expect(await screen.findByRole('heading', { name: /Locked since/ })).toBeInTheDocument();
    expect(field(/Weights SHA-256/).value).toBe('');
    expect(field(/Evaluator prompt version/).value).toBe(PV);
    expect(screen.getByLabelText(/Type it to confirm/)).toBeInTheDocument();
  });

  it('a 401 on submit is a failure that stays on the page, not a success', async () => {
    wire(state(), () => undefined);
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has expired: ยังไม่ได้ล็อก / Nothing was locked');
    expect(toast).not.toHaveBeenCalled();
    expect(getCount()).toBe(1);
    expect(field(/Weights SHA-256/).value).toBe(DIGEST);
  });

  it('a 400 shows the bilingual error (never [object Object]) and each field the server named', async () => {
    const INVALID = 'ข้อมูลที่ประกาศไม่ครบหรือไม่ถูกต้อง ดูรายละเอียดใน details / The declaration is incomplete or malformed; see details.';
    wire(state(), () => ({ error: INVALID, code: 'invalid_declaration', httpStatus: 400, details: {
      fieldErrors: { weights_sha256: ['expected a 64-character SHA-256 hex digest'], decoding: ['Expected number'], environment: ['Expected string'], note: ['Too long'], quantization: [] },
      formErrors: ['Unrecognized key: "x"'],
    } }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The declaration was refused as incomplete or malformed');
    expect(alert).toHaveTextContent(INVALID);
    expect(alert).not.toHaveTextContent('[object Object]');
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'weights_sha256: expected a 64-character SHA-256 hex digest', 'decoding: Expected number', 'environment: Expected string', 'note: Too long',
    ]);
    expect(alert).toHaveTextContent('Unrecognized key: "x"');
    // …and beside the fields themselves.
    const form = screen.getByRole('form');
    expect(field(/Weights SHA-256/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByText('expected a 64-character SHA-256 hex digest')).toHaveClass('text-danger');
    expect(within(form).getByText('Expected number')).toHaveClass('text-danger');
    expect(within(form).getByText('Expected string')).toHaveClass('text-danger');
    expect(within(form).getByText('Too long')).toHaveClass('text-danger');
    // A 400 is about the request, not the state: no re-read.
    expect(getCount()).toBe(1);
  });

  it('a validation error from an older backend (a zod object in `error`) is still readable', async () => {
    wire(state(), () => ({ error: { fieldErrors: { rubric_version: ['Required'] } }, httpStatus: 400 }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ล็อกไม่สำเร็จ / The lock was not applied');
    expect(alert).toHaveTextContent('{"rubric_version":["Required"]}');
    expect(alert).not.toHaveTextContent('[object Object]');
  });

  it('409 manifest_mismatch shows the diff inline, re-reads the state and keeps what was typed', async () => {
    wire(state(), () => ({
      error: 'ค่าที่จะล็อกไม่ตรงกับ model manifest 1 รายการ / The configuration being frozen does not match the model manifest: decoding.max_tokens: declared 2048, manifest expects 1500.',
      code: 'manifest_mismatch', httpStatus: 409,
      diff: [{ field: 'decoding.max_tokens', source: 'declaration', value: 2048, expected: 1500, manifest_path: 'expected.code.decoding.evaluate.max_tokens' }],
    }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    type(/Max tokens/, '2048');
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('the declaration does not match the manifest');
    const table = within(alert).getByRole('region', { name: /Difference from the model manifest/ });
    expect(within(table).getAllByRole('cell').map((c) => c.textContent))
      .toEqual(['decoding.max_tokens', '2048', '1500expected.code.decoding.evaluate.max_tokens', 'ที่ประกาศ / Declared']);
    await waitFor(() => expect(getCount()).toBe(2));
    expect(field(/Max tokens/).value).toBe('2048');
    expect(field(/Weights SHA-256/).value).toBe(DIGEST);
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    ['migration_required', { migrations: ['db/migration-evaluator-lock-manifest.sql'] }, 'a database migration is needed', 'db/migration-evaluator-lock-manifest.sql'],
    ['manifest_unavailable', { reason: 'unreachable' }, 'no usable model manifest', 'reason: unreachable'],
    ['rollback_incomplete', { inconsistent: [{ step: 'delete_record', left: 'evaluator_model_lock row 9 still exists' }] }, 'manual repair is needed', 'delete_record: evaluator_model_lock row 9 still exists'],
    ['lock_record_unconfirmed', { locked_at: T }, 'the lock record was not confirmed', `locked_at = ${T}`],
    ['verdict_unavailable', { detail: 'timeout' }, 'the agreement verdict could not be computed', 'timeout'],
    ['gate_not_passed', {}, 'the candidate has not cleared the gate', 'insufficient'],
    ['candidate_not_serving', {}, 'the candidate is not serving evaluate', 'Switch evaluate'],
    ['audit_write_failed', {}, 'the audit entry could not be written', 'undone'],
    ['some_new_code', {}, 'The lock was not applied', 'new failure'],
  ])('%s keeps its detail on the page', async (code, extra, title, detail) => {
    const message = {
      gate_not_passed: 'The candidate has not cleared the decisive threshold (insufficient).',
      candidate_not_serving: 'The candidate (local) is not the provider serving evaluate (anthropic). Switch evaluate to local first.',
      audit_write_failed: 'The lock could not be written to the audit trail, so it was undone.',
      some_new_code: 'A new failure.',
    }[code] ?? `failed: ${code}`;
    wire(state(), () => ({ error: message, code, httpStatus: 500, ...extra }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
    expect(alert.parentElement).toHaveFocus();
    await waitFor(() => expect(getCount()).toBe(2));
  });

  it('a 200 that is not { ok: true } is not treated as success', async () => {
    wire(state(), () => ({ locked_at: T }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The lock was not applied');
    expect(alert).toHaveTextContent('The server gave no reason.');
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('Model Lock — replacing a lock', () => {
  it('a lock in force: the banner says what was frozen, and replacing it needs the exact phrase', async () => {
    wire(state({ locked_at: T, current: RECORD, in_force: true }));
    render(<EvaluatorLockPage />);
    const banner = await screen.findByRole('region', { name: /Locked since/ });
    expect(banner).toHaveTextContent(`Locked since ${new Date(T).toLocaleString('th-TH')}`);
    for (const t of ['local', MV, `${MSHA.slice(0, 12)}…`, `${ESHA.slice(0, 12)}…`, `${DIGEST.slice(0, 12)}…`, 'vllm 0.21.1', 'Q8_0', 'sys-v3',
      'temperature 0 · top_p 1 · max_tokens 1500 · seed ไม่ได้ตั้ง / none', 'os = ubuntu 24.04', 'cuda = 12.4', 'first freeze']) {
      expect(banner).toHaveTextContent(t);
    }
    expect(within(banner).getByText(`${ESHA.slice(0, 12)}…`)).toHaveAttribute('title', ESHA);
    expect(banner).not.toHaveTextContent(/before it could be bound/);

    fillRequired();
    expect(submitBtn()).toHaveTextContent('แทนที่การล็อก / Replace the lock');
    expect(submitBtn()).toBeDisabled();
    expect(screen.getByText('พิมพ์วลียืนยันให้ตรงก่อน / Type the confirmation phrase first.')).toBeInTheDocument();
    const confirm = screen.getByLabelText(/Type it to confirm/);
    expect(confirm).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByText(PHRASE)).toHaveClass('font-mono');
    fireEvent.change(confirm, { target: { value: 'replace the lock' } });
    expect(submitBtn()).toBeDisabled();
    fireEvent.change(confirm, { target: { value: PHRASE } });
    expect(submitBtn()).toBeEnabled();
    fireEvent.click(submitBtn());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].confirm_relock).toBe(PHRASE);
  });

  it('409 confirmation_required (a lock landed after the page loaded) opens the confirmation and resends with it', async () => {
    let n = 0;
    wire((g) => (g === 1 ? state() : state({ locked_at: T, current: RECORD, in_force: true })),
      (b) => (++n === 1
        ? { error: 'The evaluator was locked on 2026-10-15. Replacing that lock means stopping scoring.', code: 'confirmation_required', confirm_phrase: 'REPLACE IT NOW', locked_at: T, httpStatus: 409 }
        : (b.confirm_relock === 'REPLACE IT NOW' ? OK : { error: 'wrong phrase', code: 'confirmation_required', httpStatus: 409 })));
    render(<EvaluatorLockPage />);
    await formReady();
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
    fillRequired();
    fireEvent.click(submitBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Replacing the lock needs the typed confirmation');
    expect(alert).toHaveTextContent('Type the confirmation phrase in the form below');
    // The phrase is the one the 409 sent, not a hard-coded copy.
    expect(screen.getByText('REPLACE IT NOW')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Type it to confirm/), { target: { value: 'REPLACE IT NOW' } });
    fireEvent.click(submitBtn());
    await screen.findByText(/Locked at/);
    expect(posts()[1].confirm_relock).toBe('REPLACE IT NOW');
    expect(posts()[0].confirm_relock).toBeUndefined();
  });

  it('a 409 without its own phrase falls back to the one GET published', async () => {
    wire(state(), () => ({ error: 'locked', code: 'confirmation_required', httpStatus: 409 }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    await screen.findByRole('alert');
    expect(await screen.findByLabelText(/Type it to confirm/)).toBeInTheDocument();
    expect(screen.getByText(PHRASE)).toBeInTheDocument();
  });

  it('a lock taken before manifest binding is flagged in the banner', async () => {
    wire(state({ locked_at: T, current: { ...RECORD, evaluator_sha256: null, manifest_sha256: null, quantization: null, note: null, decoding: null, environment: null }, in_force: true }));
    render(<EvaluatorLockPage />);
    const banner = await screen.findByRole('region', { name: /Locked since/ });
    expect(banner).toHaveTextContent('This lock was taken before it could be bound to the model manifest');
    expect(within(banner).getAllByText('ไม่ได้ประกาศ / Not declared')).toHaveLength(2);
    expect(banner).not.toHaveTextContent('Quantization');
  });

  it('a legacy hand-set lock (flag, no record) warns that it must be replaced, and asks for the phrase', async () => {
    wire(state({ locked_at: T, current: null, in_force: false }));
    const first = render(<EvaluatorLockPage />);
    const warn = await screen.findByText('ล็อกไว้โดยไม่มีบันทึกรองรับ / Locked, with no record behind it');
    const box = warn.closest('[role="status"]') as HTMLElement;
    expect(box).toHaveTextContent('retired quick-lock switch or by hand');
    expect(box).toHaveTextContent('no weights digest, no agreement verdict, no manifest');
    expect(box).not.toHaveTextContent('The latest record on file');
    expect(screen.queryByRole('region', { name: /Locked since/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Type it to confirm/)).toBeInTheDocument();
    first.unmount();

    // …and when an older record exists, it is not mistaken for the lock in force.
    wire(state({ locked_at: T, current: { ...RECORD, locked_at: '2026-09-01T00:00:00Z' }, in_force: false }));
    render(<EvaluatorLockPage />);
    expect(await screen.findByText(/The latest record on file/)).toHaveTextContent(new Date('2026-09-01T00:00:00Z').toLocaleString('th-TH'));
  });

  it('unlocked: says so, with or without an earlier record on file; an unparseable date is shown as sent', async () => {
    wire(state({ current: { ...RECORD, locked_at: 'yesterday' } }));
    const first = render(<EvaluatorLockPage />);
    expect(await screen.findByText(/Not locked\. The last declaration \(yesterday\) stays on file/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
    first.unmount();

    wire(state());
    render(<EvaluatorLockPage />);
    expect(await screen.findByText('ผู้ให้คะแนนยังไม่ถูกล็อก / The evaluator is not locked.')).toBeInTheDocument();
  });
});

describe('Model Lock — sparse records and missing optional fields', () => {
  it('a lock in force whose record carries almost nothing renders dashes, not blanks or crashes', async () => {
    wire(state({
      locked_at: T, in_force: true, confirm_phrases: undefined,
      current: { locked_at: T },
      candidate: { provider: 'local', model_version: null, prompt_version: null, rubric_versions: [] },
      gate: { ...GATE, groups: [{ provider: null, model_version: null, prompt_version: null, rows: 1, rubric_versions: [], latest: null }] },
    }));
    render(<EvaluatorLockPage />);
    const banner = await screen.findByRole('region', { name: /Locked since/ });
    const values = within(banner).getAllByRole('definition').map((dd) => dd.textContent);
    expect(values.slice(0, 6)).toEqual(['—', '—', '—', '—', '—', '—']);
    expect(screen.getByText(/สำหรับ \/ For/)).toHaveTextContent(/For local\s*$/);
    expect(screen.getByRole('region', { name: /candidate and the serving/ })).toHaveTextContent('— · — · — · 1 rows');
    // Locked, but GET published no phrase: no confirmation block until a 409 supplies one.
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
    expect(submitBtn()).toHaveTextContent('Freeze it');
  });

  it('a 409 with no phrase anywhere leaves the form as it was', async () => {
    wire(state({ confirm_phrases: undefined }), () => ({ error: 'locked', code: 'confirmation_required', httpStatus: 409 }));
    render(<EvaluatorLockPage />);
    await formReady();
    fillRequired();
    fireEvent.click(submitBtn());
    await screen.findByRole('alert');
    expect(screen.queryByLabelText(/Type it to confirm/)).not.toBeInTheDocument();
  });

  it('blocker details tolerate a missing candidate, serving provider and an unknown gate state', async () => {
    wire(state({ can_declare: false, blockers: ['gate_not_passed', 'candidate_not_serving', 'candidate_not_evaluator'],
      candidate: null, serving_provider: null, gate: { ...GATE, state: 'mystery', why: 'w' } }));
    render(<EvaluatorLockPage />);
    await screen.findByText(/Why the lock cannot be declared/);
    const item = (b: string) => document.querySelector(`[data-blocker="${b}"]`) as HTMLElement;
    expect(item('gate_not_passed')).toHaveTextContent('mystery: w');
    expect(item('candidate_not_serving')).toHaveTextContent('Candidate — · ให้คะแนนอยู่ / Serving —');
    expect(item('candidate_not_evaluator')).toHaveTextContent('Candidate provider: —');
  });
});

describe('Model Lock — the pure helpers', () => {
  it('decodingValue reads a number or the default of an env-tunable value', () => {
    expect(decodingValue(0)).toBe(0);
    expect(decodingValue({ default: 1500, env: 'X' })).toBe(1500);
    expect(decodingValue({ env: 'X' })).toBeNull();
    expect(decodingValue(null)).toBeNull();
    expect(decodingValue(undefined)).toBeNull();
  });

  it('manifestValue is null without a usable manifest or for a key the manifest does not state', () => {
    expect(manifestValue(null, 'rubric_version')).toBeNull();
    expect(manifestValue({ ok: false }, 'rubric_version')).toBeNull();
    const m = { ...MANIFEST, expected_for_candidate: { ...MANIFEST.expected_for_candidate, decoding: null, declared: null, prompt_version: null, rubric_version: null } } as never;
    expect(manifestValue(m, 'decoding.temperature')).toBeNull();
    expect(manifestValue(m, 'inference_engine')).toBeNull();
    expect(manifestValue(m, 'evaluator_prompt_version')).toBeNull();
    expect(manifestValue(m, 'rubric_version')).toBeNull();
    expect(manifestValue(MANIFEST as never, 'decoding.top_p')).toBeNull();
    expect(manifestValue(MANIFEST as never, 'system_prompt_version')).toBeNull();
    const nullDefault = { ...MANIFEST, expected_for_candidate: { ...MANIFEST.expected_for_candidate, decoding: { temperature: { env: 'T' } } } } as never;
    expect(manifestValue(nullDefault, 'decoding.temperature')).toBeNull();
  });

  it('buildBody omits every blank optional value and never sends an empty decoding/environment', () => {
    const f = emptyForm();
    expect(buildBody(f)).toEqual({});
    f.env.push({ id: 9, key: '  ', value: 'orphan' });
    expect(buildBody(f, null)).toEqual({});
    expect(validate(f).errors['env.9.key']).toMatch(/Name this entry/);
  });

  it('differsFromManifest ignores blank values and fields the server does not compare', () => {
    expect(differsFromManifest('rubric_version', '', RV)).toBe(false);
    expect(differsFromManifest('rubric_version', 'x', null)).toBe(false);
    expect(differsFromManifest('inference_engine', 'tgi', 'vllm')).toBe(false);
    expect(differsFromManifest('decoding.temperature', '0.00', '0')).toBe(false);
  });

  it('formatters', () => {
    expect(shortSha(null)).toBe('—');
    expect(fmtDate(null)).toBe('—');
    expect(fmtValue([])).toBe('— (ไม่มี / none)');
    expect(fmtValue(3)).toBe('3');
  });
});
