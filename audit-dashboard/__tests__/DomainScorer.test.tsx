// DomainScorer is the rubric-anchored PIS-7 instrument (#11 — protect ICC at the source). The
// invariants under test are the ones that keep human + AI raters on the same scale: 7 domains, a
// visible "to score" state with NO silent 0, the weight badge, and an onChange that reports the
// exact (domain, level) the rater tapped.
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DomainScorer } from '@/components/DomainScorer';
import { PIS7_RUBRIC, PIS7_EVIDENCE_NOTE } from '@/lib/pis7-rubric';
import { WEIGHTS } from '@/lib/labels';

const NONE: Record<string, number | null> = Object.fromEntries(
  PIS7_RUBRIC.map((d) => [d.key, null])
);

describe('DomainScorer', () => {
  it('renders one radiogroup per PIS-7 domain, each with 6 levels (0–5)', () => {
    render(<DomainScorer scores={NONE} onChange={() => {}} />);
    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(PIS7_RUBRIC.length);
    for (const g of groups) {
      expect(within(g).getAllByRole('radio')).toHaveLength(6);
    }
  });

  it('shows each domain weight as a percentage derived from WEIGHTS', () => {
    const { container } = render(<DomainScorer scores={NONE} onChange={() => {}} />);
    // d2 is the heaviest at 20% — its presence proves the % comes from WEIGHTS, not a hardcoded literal.
    expect(WEIGHTS.d2).toBe(0.2);
    expect(container.textContent).toContain('20%');
    expect(container.textContent).toContain('15%');
  });

  it('marks unset domains "to score" — no silent 0 default', () => {
    render(<DomainScorer scores={NONE} onChange={() => {}} />);
    expect(screen.getAllByText('ยังไม่ให้คะแนน')).toHaveLength(PIS7_RUBRIC.length);
    for (const r of screen.getAllByRole('radio')) {
      expect(r).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('reports the exact (domain, level) tapped via onChange', () => {
    const onChange = jest.fn();
    render(<DomainScorer scores={NONE} onChange={onChange} />);
    const firstGroup = screen.getAllByRole('radiogroup')[0];
    fireEvent.click(within(firstGroup).getByRole('radio', { name: /^4 / }));
    expect(onChange).toHaveBeenCalledWith(PIS7_RUBRIC[0].key, 4);
  });

  it('reflects a picked score: aria-checked, n/5, and the high-evidence note for ≥4', () => {
    const scores = { ...NONE, [PIS7_RUBRIC[0].key]: 5 };
    const { container } = render(<DomainScorer scores={scores} onChange={() => {}} />);
    const firstGroup = screen.getAllByRole('radiogroup')[0];
    expect(within(firstGroup).getByRole('radio', { name: /^5 / })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByText('5/5')).toBeInTheDocument();
    // The "a 4–5 needs a quotable utterance" guard appears once a high score is chosen.
    expect(container.textContent).toContain(PIS7_EVIDENCE_NOTE);
  });

  it('omits the high-evidence note for a low score (≤3)', () => {
    const scores = { ...NONE, [PIS7_RUBRIC[0].key]: 3 };
    const { container } = render(<DomainScorer scores={scores} onChange={() => {}} />);
    expect(container.textContent).not.toContain(PIS7_EVIDENCE_NOTE);
  });

  it('disables every chip when disabled', () => {
    render(<DomainScorer scores={NONE} onChange={() => {}} disabled />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
  });
});

// Anchor clarity: how clear this domain's behavioural anchor was for THIS transcript. The approved
// assessment form asks it per domain, and the calibration workshop's stated output is a map of
// exactly this — where raters disagree and which anchors are ambiguous. The rubric may only be
// refined AFTER the primary analysis, so a judgement not captured while it is being made is gone.
describe('DomainScorer — anchor clarity', () => {
  const anchorGroups = () =>
    screen.getAllByRole('radiogroup').filter((g) => /anchor clarity/i.test(g.getAttribute('aria-label') ?? ''));

  it('offers the three choices per domain when the handler is supplied', () => {
    render(<DomainScorer scores={NONE} onChange={() => {}} anchors={{}} onAnchorChange={() => {}} />);
    const groups = anchorGroups();
    expect(groups).toHaveLength(PIS7_RUBRIC.length);
    for (const g of groups) expect(within(g).getAllByRole('radio')).toHaveLength(3);
  });

  it('reports the exact domain key and value the rater picked', () => {
    const onAnchorChange = jest.fn();
    render(<DomainScorer scores={NONE} onChange={() => {}} anchors={{}} onAnchorChange={onAnchorChange} />);
    fireEvent.click(within(anchorGroups()[0]).getAllByRole('radio')[2]);
    // Keyed to match the column the API persists, so a rename cannot silently drop the field.
    expect(onAnchorChange).toHaveBeenCalledWith('d1_anchor', 'ambiguous');
  });

  it('marks the current choice, so a rater can see what they already answered', () => {
    render(<DomainScorer scores={NONE} onChange={() => {}} anchors={{ d1_anchor: 'clear' }} onAnchorChange={() => {}} />);
    expect(within(anchorGroups()[0]).getAllByRole('radio')[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('is absent entirely without a handler — scoring never depends on it', () => {
    // A missing judgement here is a missing judgement. It must never be able to block an assessment.
    render(<DomainScorer scores={NONE} onChange={() => {}} />);
    expect(anchorGroups()).toHaveLength(0);
  });
});
