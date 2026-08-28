// DomainScorer is the rubric-anchored PIS-7 instrument (#11 — protect ICC at the source). The
// invariants under test are the ones that keep human + AI raters on the same scale: 7 domains, a
// visible "to score" state with NO silent 0, the weight badge, and an onChange that reports the
// exact (domain, level) the rater tapped.
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DomainScorer, ANCHOR_CLARITY } from '@/components/DomainScorer';
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

// A group announced as a radiogroup is operated with ARROWS — that is what the role promises. Both
// groups here were Tab-and-Space only, so a screen-reader user who heard "radio group" pressed an
// arrow key and nothing happened.
describe('DomainScorer — keyboard', () => {
  const scoreGroups = () =>
    screen.getAllByRole('radiogroup').filter((g) => /\(0–5\)/.test(g.getAttribute('aria-label') ?? ''));

  it('an arrow key moves the score selection', () => {
    const onChange = jest.fn();
    render(<DomainScorer scores={{ ...NONE, d1: 3 }} onChange={onChange} />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('d1', 4);
  });

  it('moves backwards too', () => {
    const onChange = jest.fn();
    render(<DomainScorer scores={{ ...NONE, d1: 3 }} onChange={onChange} />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('d1', 2);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('d1', 2);
  });

  it('wraps at BOTH ends rather than dead-ending', () => {
    const onChange = jest.fn();
    const { unmount } = render(<DomainScorer scores={{ ...NONE, d1: 5 }} onChange={onChange} />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('d1', 0);
    unmount();

    render(<DomainScorer scores={{ ...NONE, d1: 0 }} onChange={onChange} />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('d1', 5);
  });

  it('an arrow enters an unanswered group at the first option instead of doing nothing', () => {
    const onChange = jest.fn();
    render(<DomainScorer scores={NONE} onChange={onChange} />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('d1', 0);
  });

  it('exposes ONE tab stop per group, not one per option', () => {
    // Six stops per domain is 42 on this page, which is what made keyboard use impractical.
    render(<DomainScorer scores={{ ...NONE, d1: 2 }} onChange={() => {}} />);
    const stops = within(scoreGroups()[0]).getAllByRole('radio').filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('the anchor group is operable the same way', () => {
    const onAnchorChange = jest.fn();
    render(<DomainScorer scores={NONE} onChange={() => {}} anchors={{ d1_anchor: 'clear' }} onAnchorChange={onAnchorChange} />);
    const g = screen.getAllByRole('radiogroup').filter((x) => /anchor clarity/i.test(x.getAttribute('aria-label') ?? ''))[0];
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(onAnchorChange).toHaveBeenCalledWith('d1_anchor', 'moderate');
  });

  it('leaves every other key alone', () => {
    // The handler sits on the group, so swallowing Tab or Enter here would break the rest of the
    // page's keyboard behaviour to fix this group's.
    const onChange = jest.fn();
    render(<DomainScorer scores={{ ...NONE, d1: 3 }} onChange={onChange} />);
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Home']) {
      fireEvent.keyDown(scoreGroups()[0], { key });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled scorer ignores arrow keys', () => {
    const onChange = jest.fn();
    render(<DomainScorer scores={{ ...NONE, d1: 3 }} onChange={onChange} disabled />);
    fireEvent.keyDown(scoreGroups()[0], { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});


describe('ANCHOR_CLARITY', () => {
  it('offers exactly the three values the API and the CHECK constraint accept', () => {
    // audit_scores_d*_anchor_chk allows clear | moderate | ambiguous, and the request schema enums
    // the same three. A fourth option here would render a button whose click the server rejects.
    expect(ANCHOR_CLARITY.map((a) => a.value)).toEqual(['clear', 'moderate', 'ambiguous']);
  });

  it('labels every option in both languages', () => {
    for (const a of ANCHOR_CLARITY) {
      expect(a.th.trim().length).toBeGreaterThan(0);
      expect(a.en.trim().length).toBeGreaterThan(0);
    }
  });
});
