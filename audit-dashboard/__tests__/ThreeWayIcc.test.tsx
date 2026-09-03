// ThreeWayIcc renders the shadow-evaluator comparison. The invariants under test are the ones that
// keep the panel HONEST and keep the auditors BLIND:
//   - the human auditor is the reference standard; the model-vs-model arm is a secondary signal
//   - coverage (shared-set n) and the candidate's contract-failure rate are as visible as the ICCs
//   - shadow.available === false is a calm empty state, not an error
//   - the component renders NOTHING for a role outside analyst/ethics/superadmin (blinding)
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
const getUser = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/lib/auth', () => ({ getUser: () => getUser() }));

import { ThreeWayIcc } from '@/components/ThreeWayIcc';
import type { ThreeWayIccData } from '@/lib/types';

const stat = (icc: number, n = 24) => ({
  icc,
  lower: icc - 0.1,
  upper: icc + 0.05,
  n,
  interpretation: icc >= 0.75 ? 'Good' : 'Below target',
});
// Each domain gets its OWN value so a per-domain cell can never be mistaken for the arm's overall
// figure (and so the exact-text queries below stay unambiguous).
const domains = (base: number) =>
  Object.fromEntries(
    ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((k, i) => [
      k,
      stat(Number((base - 0.01 * (i + 1)).toFixed(3))),
    ])
  );

const FULL: ThreeWayIccData = {
  arms: {
    ai_vs_human: { overall: stat(0.82), per_domain: domains(0.82), n: 24 },
    shadow_vs_human: { overall: stat(0.61), per_domain: domains(0.61), n: 24 },
    ai_vs_shadow: { overall: stat(0.91), per_domain: domains(0.91), n: 24 },
  },
  coverage: {
    ples_with_human: 30,
    ples_with_ai: 40,
    ples_with_shadow: 26,
    ples_all_three: 24,
    shadow_failed: 2,
    shadow_contract_rate: 0.92,
  },
  shadow: { available: true, provider: 'ollama', model_version: 'qwen2.5:32b' },
};

beforeEach(() => {
  apiFetch.mockReset();
  getUser.mockReset();
  getUser.mockReturnValue({ role: 'analyst' });
  apiFetch.mockResolvedValue(FULL);
});

describe('ThreeWayIcc', () => {
  it('renders all three arms with ICC, 95% CI and n', async () => {
    render(<ThreeWayIcc />);
    expect(await screen.findByText('0.820')).toBeInTheDocument(); // Claude vs auditor
    expect(screen.getByText('0.610')).toBeInTheDocument(); // candidate vs auditor
    expect(screen.getByText('0.910')).toBeInTheDocument(); // model vs model (secondary)
    const ci = screen.getAllByText(/95% CI \[/);
    expect(ci).toHaveLength(3);
    for (const el of ci) expect(el).toHaveTextContent('n = 24');
  });

  it('names the human auditor as the reference standard and Claude as not', async () => {
    const { container } = render(<ThreeWayIcc />);
    await screen.findByText('0.820');
    expect(container.textContent).toContain('Human auditors are the reference standard; Claude is not.');
  });

  it('subordinates the model-vs-model arm: correlated-error caveat, and the gate excludes it', async () => {
    const { container } = render(<ThreeWayIcc />);
    await screen.findByText('0.910');
    expect(container.textContent).toContain('possibly similarly wrong');
    // Same invariant, sharper wording: this arm can REJECT a candidate cheaply and can never accept
    // one. It used to read "the 0.75 gate does not apply to it", which became untrue once the arm
    // got a screening threshold of its own — the thing that must stay true is that it cannot accept.
    expect(container.textContent).toContain('it can never accept one');
    expect(container.textContent).toContain('SCREENING');
  });

  it('makes the 0.75 gate explicit', async () => {
    const { container } = render(<ThreeWayIcc />);
    await screen.findByText('0.820');
    expect(container.textContent).toContain('ICC ≥ 0.75');
  });

  it('shows coverage: the shared-set n and the contract-failure rate, not as a footnote', async () => {
    const { container } = render(<ThreeWayIcc />);
    await screen.findByText('0.820');
    expect(screen.getByText('24')).toBeInTheDocument(); // ples_all_three tile
    expect(container.textContent).toContain('the shared set every arm below uses');
    expect(screen.getByText('92.0%')).toBeInTheDocument(); // shadow_contract_rate
    expect(container.textContent).toContain('ล้มเหลว 2 ครั้ง'); // shadow_failed
    expect(container.textContent).toContain('excluded from every ICC');
  });

  it('warns when the shared sample is small', async () => {
    apiFetch.mockResolvedValue({
      ...FULL,
      coverage: { ...FULL.coverage!, ples_all_three: 4 },
    });
    const { container } = render(<ThreeWayIcc />);
    await screen.findByText('0.820');
    expect(container.textContent).toContain('Small shared sample');
  });

  // REGRESSION (confirmed 2026-08-24). available=false has TWO opposite causes: nothing attempted,
  // or every attempt failed. Rendering the same calm "not collecting yet" copy for both presents the
  // single most disqualifying result about the candidate as an absence of data.
  it('a candidate that FAILED every run is reported as a failure, not as "not collecting yet"', async () => {
    apiFetch.mockResolvedValue({
      arms: { ai_vs_human: FULL.arms!.ai_vs_human, shadow_vs_human: null, ai_vs_shadow: null },
      coverage: {
        ...FULL.coverage!, ples_with_shadow: 0,
        shadow_failed: 40, shadow_contract_rate: 0,
        shadow_scored_corpus: 0, shadow_failed_corpus: 40, shadow_contract_rate_corpus: 0,
      },
      shadow: { available: false, provider: 'local', model_version: 'deepseek-v4-flash' },
    } as ThreeWayIccData);
    const { container } = render(<ThreeWayIcc />);
    // Wait for the rendered result, not merely for the fetch to fire.
    await screen.findByText(/0%/);
    const text = container.textContent ?? '';
    // The disqualifying numbers must be on screen...
    expect(text).toContain('40');
    expect(text).toContain('0%');
    // ...and the "hasn't started" framing must NOT be.
    expect(text).not.toContain('not collecting scores yet');
    expect(text).not.toContain('ยังไม่มีการเก็บคะแนนจากโมเดลผู้ท้าชิง');
  });

  it('renders a calm empty state (no error wording, no shadow numbers) when the candidate is not collecting', async () => {
    apiFetch.mockResolvedValue({
      arms: { ai_vs_human: null, shadow_vs_human: null, ai_vs_shadow: null },
      coverage: { ...FULL.coverage!, ples_with_shadow: 0, shadow_failed: 0, shadow_contract_rate: null },
      shadow: { available: false, provider: null, model_version: null },
    } as ThreeWayIccData);
    const { container } = render(<ThreeWayIcc />);
    expect(
      await screen.findByText('ยังไม่มีการเก็บคะแนนจากโมเดลผู้ท้าชิง')
    ).toBeInTheDocument();
    expect(container.textContent).toContain('not collecting scores yet');
    expect(container.textContent).not.toMatch(/Could not load|error/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('tolerates a degenerate (null) ICC without crashing', async () => {
    apiFetch.mockResolvedValue({
      ...FULL,
      arms: {
        ai_vs_human: {
          overall: { icc: null, lower: null, upper: null, n: 3, interpretation: 'Insufficient variance' },
          per_domain: {},
          n: 3,
        },
        shadow_vs_human: null,
        ai_vs_shadow: null,
      },
    } as ThreeWayIccData);
    render(<ThreeWayIcc />);
    expect(await screen.findByText('Insufficient variance')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('BLINDING: renders nothing — and never fetches — for an auditor', async () => {
    getUser.mockReturnValue({ role: 'auditor' });
    const { container } = render(<ThreeWayIcc />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('BLINDING: renders nothing for a council admin or a physician', async () => {
    for (const role of ['admin', 'physician']) {
      getUser.mockReturnValue({ role });
      const { container } = render(<ThreeWayIcc />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('requests the analyst endpoint with include_test', async () => {
    render(<ThreeWayIcc includeTest />);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/oversight/icc/three-way?include_test=true')
    );
  });

  it('shows a calm retry line when the endpoint errors', async () => {
    apiFetch.mockResolvedValue({ error: 'boom' });
    render(<ThreeWayIcc />);
    expect(await screen.findByText(/Could not load the comparison/)).toBeInTheDocument();
  });
});

// The server now sends a verdict per arm. The point of rendering it is the THIRD state: `fail` and
// `insufficient` must not look alike. One says the candidate missed the bar; the other says nobody
// knows yet, and early in a study that is the honest answer almost every time. Colouring them the
// same way would present the absence of evidence as evidence against.
describe('ThreeWayIcc — verdicts', () => {
  const withVerdicts = (v: Record<string, { state: string; why: string; threshold?: number }>) => ({
    ...FULL,
    arms: Object.fromEntries(
      Object.entries(FULL.arms ?? {}).map(([k, arm]) => [
        k,
        arm && v[k] ? { ...arm, verdict: { threshold: 0.75, icc: 0.8, lower: 0.7, upper: 0.9, n: 24, ...v[k] } } : arm,
      ])
    ) as ThreeWayIccData['arms'],
  });

  it('states the threshold rather than leaving the reader to assume it', async () => {
    apiFetch.mockResolvedValue(withVerdicts({ shadow_vs_human: { state: 'pass', why: 'the whole interval is at or above 0.75' } }));
    render(<ThreeWayIcc />);
    await waitFor(() => expect(screen.getByText(/Meets ≥ 0\.75/)).toBeInTheDocument());
  });

  it('says "not yet decidable" for insufficient — never "below"', async () => {
    apiFetch.mockResolvedValue(withVerdicts({
      shadow_vs_human: { state: 'insufficient', why: '3 pairs cannot support a confidence interval' },
    }));
    render(<ThreeWayIcc />);
    await waitFor(() => expect(screen.getByText(/Not yet decidable/)).toBeInTheDocument());
    expect(screen.queryByText(/Below ≥/)).not.toBeInTheDocument();
    // The reason travels with the verdict, so "why can't we tell?" is answered in place.
    expect(screen.getByText(/3 pairs cannot support/)).toBeInTheDocument();
  });

  it('gives fail and insufficient visibly different treatments', async () => {
    apiFetch.mockResolvedValue(withVerdicts({
      shadow_vs_human: { state: 'fail', why: 'the whole interval is below 0.75' },
      ai_vs_shadow: { state: 'insufficient', why: 'the interval spans 0.75' },
    }));
    render(<ThreeWayIcc />);
    const failed = await screen.findByText(/Below ≥ 0\.75/);
    const undecided = await screen.findByText(/Not yet decidable/);
    // Different wording AND a different colour class. The class check is only worth anything because
    // __tests__/theme-tokens.test.ts separately proves `text-danger` is MAPPED in @theme inline —
    // on its own it passed while the token generated no CSS at all and both states rendered
    // identically in body text. jsdom applies no Tailwind, so neither test can see the real colour;
    // together they cover it, and it is worth naming why rather than trusting the pair by accident.
    expect(failed.closest('p')?.className).toContain('text-danger');
    expect(undecided.closest('p')?.className).not.toContain('text-danger');
  });

  it('renders nothing extra when an arm carries no verdict', async () => {
    apiFetch.mockResolvedValue(FULL);
    render(<ThreeWayIcc />);
    await waitFor(() => expect(screen.queryByText(/Not yet decidable/)).not.toBeInTheDocument());
  });
});
