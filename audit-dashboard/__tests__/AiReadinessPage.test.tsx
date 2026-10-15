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
import { NULL_DIGEST_REASONS, nullDigestLock } from './fixtures/model-lock-check';

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

// GET /admin/ai-readiness relays rimpl's PUBLIC manifest block ({ sha256, claimed_sha256, file,
// code_match, drift }) and the backend's lock verdict (services/model-lock.js modelLockCheck).
describe('AI readiness — the model manifest and the Model Lock', () => {
  const SHA = 'ab'.repeat(32);
  const LIVE = 'cd'.repeat(32);

  it('shows the manifest as a short sha, its file, code_match, and the drift KEYS only', async () => {
    wire(body({ manifest: { sha256: SHA, claimed_sha256: SHA, file: 'present', code_match: true, evaluator_drift_keys: [], evaluator_provider: 'anthropic', drift: [
      { key: 'declared.providers.evaluate', expected: 'local', live: 'anthropic' },
      { key: 'declared.local.model', expected: 'deepseek', live_present: true, live_sha256_12: '0123456789ab' },
      { expected: 'no key' },
    ] } }));
    render(<AiReadinessPage />);
    const sha = await screen.findByText(`${SHA.slice(0, 12)}…`);
    expect(sha).toHaveAttribute('title', SHA);
    expect(screen.getByText('present')).toBeInTheDocument();
    expect(screen.getByText(/Matches the code/)).toHaveClass('text-ok');
    // The backend puts neither key in the evaluator's scope, so both are deployment-target drift: muted,
    // and the only kind the "expected while production runs on Claude" sentence is allowed to describe.
    expect(screen.getByText(/2 declared value\(s\) differ from what is running/)).toHaveClass('text-muted-foreground');
    expect(screen.queryByText(/evaluator’s scope/)).not.toBeInTheDocument();
    expect(screen.getByText('declared.providers.evaluate')).toBeInTheDocument();
    expect(screen.getByText('declared.local.model')).toBeInTheDocument();
    // Keys, never values — not even the hashed ones.
    expect(screen.queryByText(/anthropic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0123456789ab/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deepseek/)).not.toBeInTheDocument();
    expect(screen.getByText(/Expected while production runs every purpose on Claude/)).toBeInTheDocument();
  });

  it('an unverified manifest, a code mismatch, an unknown match, and no drift each say so', async () => {
    wire(body({ manifest: { sha256: null, file: 'invalid', code_match: false, drift: [] } }));
    const first = render(<AiReadinessPage />);
    expect(await screen.findByText(/sha256 not verified/)).toHaveClass('text-danger');
    expect(screen.getByText(/Differs from the code/)).toHaveClass('text-danger');
    expect(screen.getByText(/No live value differs from the manifest/)).toBeInTheDocument();
    expect(screen.queryByText(/Expected while production/)).not.toBeInTheDocument();
    first.unmount();

    wire(body({ manifest: { sha256: SHA, file: null, code_match: null } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/Code match unknown/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('unlocked: the lock check is Up and says Not locked', async () => {
    wire(body({ model_lock: { status: 'up', locked: false, locked_at: null, manifest_sha256: null, live_sha256: SHA, match: null } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText('ยังไม่ล็อก / Not locked')).toBeInTheDocument();
    expect(screen.getByText('Evaluator Model Lock', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(UP)).toHaveClass('text-ok');
    expect(screen.queryByText(/frozen manifest/)).not.toBeInTheDocument();
  });

  it('locked and matching, with the tutor/router note', async () => {
    wire(body({ model_lock: { status: 'up', locked: true, locked_at: '2026-10-14T03:00:00Z', provider: 'local',
      manifest_sha256: SHA, evaluator_sha256: 'e'.repeat(64), live_sha256: LIVE, live_evaluator_sha256: 'e'.repeat(64), match: true,
      note: 'tutor_or_router_changed_since_lock' } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/Locked since/)).toHaveTextContent(new Date('2026-10-14T03:00:00Z').toLocaleString('th-TH'));
    expect(screen.getByText(/frozen manifest/)).toHaveTextContent(`local · frozen manifest ${SHA.slice(0, 12)}… · live ${LIVE.slice(0, 12)}… · evaluator match`);
    expect(screen.getByText(/the scoring instrument did not/)).toBeInTheDocument();
  });

  // The four reasons modelLockCheck returns before it reads the live manifest, in the body the backend
  // really sends: `match: false` with `live_evaluator_sha256: null`. Nothing was compared, so the screen
  // must not say MISMATCH (nor match) — the false "evaluator MISMATCH" an earlier fixture (match: null)
  // could not catch. The list is pinned to the backend by backend-mirrors.test.ts.
  const NULL_DIGEST_WORDS: Record<(typeof NULL_DIGEST_REASONS)[number], RegExp> = {
    lock_record_unmigrated: /has not been migrated/,
    lock_record_unreadable: /lock record could not be read/,
    lock_not_bound_to_manifest: /names no evaluator digest/,
    live_manifest_unknown: /could not be read or verified/,
  };
  it.each(NULL_DIGEST_REASONS)('%s: Down, in words, and "evaluator —" — nothing was compared, so never MISMATCH', async (reason) => {
    wire(body({ model_lock: nullDigestLock(reason) }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(NULL_DIGEST_WORDS[reason])).toBeInTheDocument();
    expect(screen.getAllByText(DOWN).some((el) => el.classList.contains('text-danger'))).toBe(true);
    const line = screen.getByText(/frozen manifest/);
    expect(line).toHaveTextContent(`local · frozen manifest ${SHA.slice(0, 12)}… · live ${LIVE.slice(0, 12)}… · evaluator —`);
    expect(line.textContent).not.toMatch(/MISMATCH|match|drifted/);
  });

  it('a compared mismatch says MISMATCH; a reason it does not know is shown by its key; an odd date as sent', async () => {
    wire(body({ model_lock: { status: 'down', locked: true, locked_at: 'not-a-date', provider: null, manifest_sha256: null,
      evaluator_sha256: 'e'.repeat(64), live_sha256: null, live_evaluator_sha256: 'd'.repeat(64), match: false, reason: 'evaluator_changed_since_lock' } }));
    const r = render(<AiReadinessPage />);
    expect(await screen.findByText(/differs from what was frozen/)).toBeInTheDocument();
    expect(screen.getAllByText(DOWN).some((el) => el.classList.contains('text-danger'))).toBe(true);
    // An unparseable timestamp is shown as sent rather than as "Invalid Date".
    expect(screen.getByText(/Locked since not-a-date/)).toBeInTheDocument();
    expect(screen.getByText(/frozen manifest/)).toHaveTextContent('— · frozen manifest — · live — · evaluator MISMATCH');
    r.unmount();

    wire(body({ model_lock: { status: 'down', locked: true, locked_at: null, provider: null, live_evaluator_sha256: null, match: false, reason: 'brand_new_reason' } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/^brand_new_reason$/)).toBeInTheDocument();
    expect(screen.getByText(/frozen manifest/)).toHaveTextContent('· evaluator —');
  });

  it('an unreadable lock state is Unknown, never Not locked; an unknown note is shown by its key', async () => {
    wire(body({ model_lock: { status: 'unknown', locked: null, error: 'connection reset', note: 'odd_note' } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText('อ่านสถานะการล็อกไม่ได้ / Lock state unreadable')).toBeInTheDocument();
    expect(screen.getByText('ไม่ทราบ / Unknown')).toHaveClass('text-muted-foreground');
    expect(screen.queryByText('ยังไม่ล็อก / Not locked')).not.toBeInTheDocument();
    expect(screen.getByText('connection reset')).toBeInTheDocument();
    expect(screen.getByText('odd_note')).toBeInTheDocument();
  });

  // services/model-lock.js modelLockCheck (#160): the frozen evaluator DIGEST matches, but the running
  // rimpl overrides an evaluator value. Down, with `match: true` — so the screen must not print a bare
  // "evaluator match" beside it.
  const LIVE_KEYS = ['code.decoding.evaluate.temperature', 'declared.local.model'];
  const liveDrift = (over: Record<string, unknown> = {}) => ({ status: 'down', locked: true, locked_at: '2026-10-14T03:00:00Z', provider: 'local',
    manifest_sha256: SHA, evaluator_sha256: 'e'.repeat(64), live_sha256: SHA, live_evaluator_sha256: 'e'.repeat(64), match: true,
    drift_keys: LIVE_KEYS, reason: 'evaluator_live_drift', ...over });

  it('evaluator_live_drift: Down, the reason in words, the drifted keys listed, and the digest match qualified', async () => {
    wire(body({ model_lock: liveDrift() }));
    render(<AiReadinessPage />);
    const section = (await screen.findByText(/Evaluator Model Lock/)).closest('section') as HTMLElement;
    expect(within(section).getByText(DOWN)).toHaveClass('text-danger');
    // The reason, in both languages, never the bare key.
    expect(within(section).getByText(/^ค่าที่ผู้ให้คะแนนใช้งานอยู่จริงถูกเปลี่ยนหลังล็อก คะแนนที่ออกตอนนี้จึงไม่ได้มาจากการตั้งค่าที่ล็อกไว้ แม้ส่วนผู้ให้คะแนนใน manifest จะยังตรงกันก็ตาม \//)).toHaveTextContent(
      'The settings the evaluator is actually running with have changed since the lock, so the scores it gives now do not come from the locked configuration, even though the evaluator part of the manifest still matches.');
    expect(within(section).queryByText('evaluator_live_drift')).not.toBeInTheDocument();
    // The digest comparison says what it compared, and that the live config drifted.
    const line = within(section).getByText(/frozen manifest/);
    expect(line).toHaveTextContent(`local · frozen manifest ${SHA.slice(0, 12)}… · live ${SHA.slice(0, 12)}… · evaluator digest match, live config drifted`);
    expect(line.textContent).not.toMatch(/evaluator match/);
    // The keys, by name, under a caption that counts them.
    expect(within(section).getByText(/2 evaluator value\(s\) on the running RIMPL differ from the manifest/)).toHaveClass('text-muted-foreground');
    const list = within(section).getByRole('list', { name: /Evaluator-scope values that differ/ });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(LIVE_KEYS);
    // Explicit, not implied: jsdom infers `list` from <ul>, but Safari/VoiceOver drops it (and the label)
    // under Tailwind's `list-style: none` unless the role is stated (components/DriftKeyList.tsx).
    expect(list).toHaveAttribute('role', 'list');
  });

  it('drift is qualified however it arrives: a reason without its list, a mismatch with one, an unknown match; odd entries are dropped', async () => {
    wire(body({ model_lock: liveDrift({ drift_keys: undefined }) }));
    let r = render(<AiReadinessPage />);
    expect(await screen.findByText(/frozen manifest/)).toHaveTextContent('· evaluator digest match, live config drifted');
    expect(screen.queryByRole('list', { name: /Evaluator-scope values/ })).not.toBeInTheDocument();
    r.unmount();

    wire(body({ model_lock: liveDrift({ match: false, live_evaluator_sha256: 'd'.repeat(64), reason: 'evaluator_changed_since_lock', drift_keys: ['code.decoding.evaluate.temperature', 7, null] }) }));
    r = render(<AiReadinessPage />);
    expect(await screen.findByText(/frozen manifest/)).toHaveTextContent('· evaluator MISMATCH, live config drifted');
    expect(screen.getByText(/differs from what was frozen/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: /Evaluator-scope values/ })).getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['code.decoding.evaluate.temperature']);
    expect(screen.getByText(/1 evaluator value\(s\) on the running RIMPL/)).toBeInTheDocument();
    r.unmount();

    wire(body({ model_lock: liveDrift({ match: null }) }));
    r = render(<AiReadinessPage />);
    expect(await screen.findByText(/frozen manifest/)).toHaveTextContent('· evaluator —, live config drifted');
    r.unmount();

    // No live digest: nothing was compared, so `match` is not read — the drift is still said.
    wire(body({ model_lock: liveDrift({ live_evaluator_sha256: null, match: false }) }));
    render(<AiReadinessPage />);
    const line = await screen.findByText(/frozen manifest/);
    expect(line).toHaveTextContent('· evaluator —, live config drifted');
    expect(line.textContent).not.toMatch(/MISMATCH/);
  });

  it('live_manifest_unknown says why the live manifest was refused', async () => {
    wire(body({ model_lock: nullDigestLock('live_manifest_unknown') }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/could not be read or verified/)).toBeInTheDocument();
    expect(screen.getByText('live manifest: unreachable')).toHaveClass('font-mono');
    expect(screen.queryByText(/live config drifted/)).not.toBeInTheDocument();
  });

  it('a locked lock with no locked_at still renders', async () => {
    wire(body({ model_lock: { status: 'down', locked: true, locked_at: null } }));
    render(<AiReadinessPage />);
    expect(await screen.findByText('ล็อกตั้งแต่ — / Locked since —')).toBeInTheDocument();
  });
});

describe('AI readiness — drift by what it means for the instrument', () => {
  // The evaluator's keys are the BACKEND's list (manifest.evaluator_drift_keys); the screen never decides
  // that itself. These lists are ones a front-end rule would get wrong (num_ctx IN for an on-prem
  // evaluator, a consistency key OUT), so a re-implemented rule here would fail.
  const SHA = 'ab'.repeat(32);
  const KEYS = ['code.decoding.evaluate.temperature', 'code.consistency.evaluate_mode', 'code.decoding.num_ctx.local',
    'code.models.anthropic', 'declared.providers.chat', 'declared.local.model', 'code.decoding.chat.temperature'];
  const EVAL = ['code.decoding.evaluate.temperature', 'code.decoding.num_ctx.local', 'declared.local.model'];
  const manifest = (over: Record<string, unknown> = {}) => ({ sha256: SHA, file: 'present', code_match: true,
    drift: KEYS.map((key) => ({ key, expected: null, live: null })), evaluator_drift_keys: EVAL, evaluator_provider: 'local', ...over });
  const group = (label: RegExp) => screen.getByRole('list', { name: label });
  const items = (label: RegExp) => within(group(label)).getAllByRole('listitem').map((li) => li.textContent);

  it('the backend’s evaluator keys are listed by name in warning tone; only the remaining declared keys are expected', async () => {
    wire(body({ manifest: manifest() }));
    render(<AiReadinessPage />);
    expect((await screen.findByText(/Live values in the evaluator’s scope differ from the manifest \(3\)/)).closest('p')).toHaveClass('text-warn');
    expect(screen.getByText(/ผู้ให้คะแนน \/ Evaluator:/)).toHaveTextContent('Evaluator: local');
    expect(items(/Evaluator-scope values/)).toEqual(EVAL);
    expect(items(/Declared values that differ/)).toEqual(['declared.providers.chat']);
    expect(items(/Other values that differ/)).toEqual(['code.consistency.evaluate_mode', 'code.models.anthropic', 'code.decoding.chat.temperature']);
    const expected = screen.getByText(/Expected while production runs every purpose on Claude/);
    expect(expected.parentElement).toContainElement(group(/Declared values that differ/));
    expect(expected.parentElement).not.toContainElement(group(/Evaluator-scope values/));
    expect(screen.queryByText(/Could not classify/)).not.toBeInTheDocument();
  });

  it.each([
    ['null (the backend could not compute it)', null],
    ['absent (an older backend)', undefined],
  ])('evaluator_drift_keys %s: "could not classify", every key listed as it is, none called expected', async (_what, keys) => {
    wire(body({ manifest: manifest({ evaluator_drift_keys: keys, evaluator_provider: null }) }));
    render(<AiReadinessPage />);
    expect((await screen.findByText(/Could not classify the live drift \(7\)/)).closest('p')).toHaveClass('text-warn');
    expect(items(/Values that differ, unclassified/)).toEqual(KEYS);
    expect(screen.getByText(/none of them is treated as expected/)).toBeInTheDocument();
    expect(screen.queryByText(/Expected while production/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /Declared values that differ|Evaluator-scope values|Other values/ })).not.toBeInTheDocument();
  });

  it('only evaluator-scope drift, without a provider name: no "expected" sentence, no provider line', async () => {
    wire(body({ manifest: manifest({ drift: [{ key: 'code.decoding.evaluate.max_tokens' }], evaluator_drift_keys: ['code.decoding.evaluate.max_tokens'], evaluator_provider: null }) }));
    render(<AiReadinessPage />);
    await screen.findByText(/evaluator’s scope differ from the manifest \(1\)/);
    expect(screen.queryByText(/Expected while production/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No live value differs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Evaluator:/)).not.toBeInTheDocument();
  });

  it('no drift: says so, classified or not', async () => {
    wire(body({ manifest: manifest({ drift: [], evaluator_drift_keys: [] }) }));
    const first = render(<AiReadinessPage />);
    expect(await screen.findByText(/No live value differs from the manifest/)).toBeInTheDocument();
    first.unmount();
    wire(body({ manifest: manifest({ drift: [], evaluator_drift_keys: null }) }));
    render(<AiReadinessPage />);
    expect(await screen.findByText(/No live value differs from the manifest/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not classify/)).not.toBeInTheDocument();
  });
});
