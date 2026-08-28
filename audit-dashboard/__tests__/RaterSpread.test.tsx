// RaterSpreadPanel renders the explanation of a number the analyst is looking at directly above it.
// Every case here is a reading the panel has to get RIGHT to be worth having: an ICC of −0.315 with
// this panel beside it says "the episodes barely differ"; without it, it says "the AI is wrong".
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RaterSpreadPanel } from '@/components/RaterSpread';
import type { RaterSpread } from '@/lib/types';

const D = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const domain = (over: Partial<RaterSpread['per_domain'][string]> = {}) =>
  ({ n: 5, sd: 0.8, modal_value: 4, modal_share: 0.6, distinct: 3, ...over });

// The real production corpus, 2026-08-28.
const REAL: RaterSpread = {
  ok: true,
  n_scores: 7, n_episodes: 5, n_auditors: 2, n_multi_rated_episodes: 2,
  between_episodes: { sd: 2.44, min: 74, max: 80, range: 6 },
  comparison_on_shared: { n: 5, human_sd: 2.44, ai_sd: 9.84, human_range: 6, ai_range: 20 },
  gate: { measurable: true, why: null, sd_error: 2.69, sd_between_observed: 2.44, sd_between_required: 4.66, meets: false },
  scale_use: { min: 73, max: 80, span_pct_of_scale: 7 },
  per_domain: Object.fromEntries(D.map((d) => [d, domain()])),
  anchor_clarity: Object.fromEntries(D.map((d) => [d, { answered: 0, unanswered: 7, clear: 0, moderate: 0, ambiguous: 0, ambiguous_share: null }])),
  scored_between: { first: '2026-06-07T00:00:00Z', last: '2026-06-15T00:00:00Z' },
  per_auditor: [
    { auditor_id: 'a6a5ba01-2bad-42c2-85f3-e2bb5620b0d0', n: 5, mean: 76.6, sd: 3.21, min: 73, max: 80 },
    { auditor_id: '7c66abf6-0755-4ec6-8bae-4127e8fa0528', n: 2, mean: 75, sd: 0, min: 75, max: 75 },
  ],
};

describe('RaterSpreadPanel', () => {
  it('renders nothing before the fetch resolves', () => {
    const { container } = render(<RaterSpreadPanel data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says so plainly when no auditor has scored anything', () => {
    render(<RaterSpreadPanel data={{ ...REAL, empty: true }} />);
    expect(screen.getByText(/No auditor scores yet/)).toBeInTheDocument();
  });

  it('shows the three gate figures — how far raters differ, how far episodes differ, how far they must', () => {
    render(<RaterSpreadPanel data={REAL} />);
    expect(screen.getByText('2.69')).toBeInTheDocument();   // rater error
    expect(screen.getByText('2.44')).toBeInTheDocument();   // observed between-episode
    expect(screen.getByText('4.66')).toBeInTheDocument();   // required for 0.75
  });

  it('states the diagnosis when episodes differ by LESS than raters disagree', () => {
    // The single sentence the ICC cannot say, and the reason this component exists.
    render(<RaterSpreadPanel data={REAL} />);
    expect(screen.getByText(/differ from each other by less than the/)).toBeInTheDocument();
  });

  it('does NOT state it when the episodes out-spread the rater noise', () => {
    render(<RaterSpreadPanel data={{
      ...REAL,
      gate: { measurable: true, why: null, sd_error: 2.0, sd_between_observed: 12.0, sd_between_required: 3.46, meets: true },
    }} />);
    expect(screen.queryByText(/differ from each other by less than the/)).not.toBeInTheDocument();
  });

  it('reports rater error as unmeasurable rather than as zero', () => {
    // Every episode single-rated. Zero would read as perfect agreement and make the requirement
    // look satisfied — the opposite of the truth.
    render(<RaterSpreadPanel data={{
      ...REAL,
      gate: { measurable: false, why: 'no episode has two or more raters, so single-rating error cannot be measured from this corpus' },
    }} />);
    expect(screen.getByText(/Not yet measurable/)).toBeInTheDocument();
    expect(screen.getByText(/two or more raters/)).toBeInTheDocument();
  });

  it('puts the human range beside the AI range on the same episodes', () => {
    render(<RaterSpreadPanel data={REAL} />);
    expect(screen.getByText(/Range on the same 5 episodes/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText(/humans used 7% of the 0–100 composite/)).toBeInTheDocument();
  });

  it('hides the range block when no episode carries both scores', () => {
    render(<RaterSpreadPanel data={{ ...REAL, comparison_on_shared: { n: 0, human_sd: null, ai_sd: null, human_range: null, ai_range: null } }} />);
    expect(screen.queryByText(/Range on the same/)).not.toBeInTheDocument();
  });

  it('marks a domain everyone scored identically', () => {
    const collapsed = { ...REAL, per_domain: { ...REAL.per_domain, d3: domain({ sd: 0, distinct: 1, modal_share: 1 }) } };
    const { container } = render(<RaterSpreadPanel data={collapsed} />);
    // A collapsed domain contributes nothing to separating episodes, however carefully it was scored.
    expect(container.querySelectorAll('td.text-danger').length).toBeGreaterThan(0);
  });

  it('marks an auditor who gave every episode the same score', () => {
    render(<RaterSpreadPanel data={REAL} />);
    const zero = screen.getAllByText('0').find((el) => el.tagName === 'TD');
    expect(zero).toHaveClass('text-danger');
  });

  it('does not mark an auditor with SD 0 who has only scored once', () => {
    // One rating cannot be "flat" — there is nothing for it to be flat across.
    render(<RaterSpreadPanel data={{ ...REAL, per_auditor: [{ auditor_id: 'solo1234', n: 1, mean: 75, sd: 0, min: 75, max: 75 }] }} />);
    const zero = screen.getAllByText('0').find((el) => el.tagName === 'TD');
    expect(zero).not.toHaveClass('text-danger');
  });

  it('reports an unanswered anchor as not asked, never as clear', () => {
    // Every score in the corpus predates d*_anchor. Rendering those as "0 ambiguous" would report a
    // rubric nobody has assessed as one nobody found ambiguous.
    render(<RaterSpreadPanel data={REAL} />);
    expect(screen.getAllByText(/not asked/).length).toBe(7);
  });

  it('renders the ambiguous count once raters have answered', () => {
    render(<RaterSpreadPanel data={{
      ...REAL,
      anchor_clarity: { ...REAL.anchor_clarity!, d5: { answered: 4, unanswered: 3, clear: 1, moderate: 0, ambiguous: 3, ambiguous_share: 0.75 } },
    }} />);
    expect(screen.getByText('3/4')).toBeInTheDocument();
  });

  it('falls back to a dash rather than rendering null figures', () => {
    render(<RaterSpreadPanel data={{
      ...REAL,
      scale_use: { min: null, max: null, span_pct_of_scale: null },
      per_domain: { d1: { n: 0, sd: null, modal_value: null, modal_share: null, distinct: 0 } },
      anchor_clarity: undefined,
      per_auditor: [{ auditor_id: 'nulls123', n: 0, mean: null, sd: null, min: null, max: null }],
      comparison_on_shared: { n: 2, human_sd: null, ai_sd: null, human_range: null, ai_range: null },
    }} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(3);
  });

  it('says every figure is descriptive, because at this n none of them support inference', () => {
    render(<RaterSpreadPanel data={REAL} />);
    expect(screen.getByText(/descriptive,\s*not inferential/)).toBeInTheDocument();
  });
});
