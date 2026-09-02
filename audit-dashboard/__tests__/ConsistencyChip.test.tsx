// ConsistencyChip is metadata beside the AI score: how many evaluator calls produced it and which rule
// chose it. The invariant worth pinning is the NEGATIVE one — when RIMPL recorded no consistency block
// (every score today), the chip must render nothing at all, so no older score is described as if it
// had been scored once "for consistency".
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConsistencyChip } from '@/components/ConsistencyChip';

describe('ConsistencyChip', () => {
  it('renders nothing when provenance is absent, null, or has no consistency block', () => {
    for (const p of [undefined, null, {}, { consistency: null }, { temperature: 0, weights_sha256: 'abc' }]) {
      const { container, unmount } = render(<ConsistencyChip provenance={p as never} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renders nothing when the block is malformed (no usable call count)', () => {
    for (const c of [{ rule: 'median-of-3' }, { calls: 0, rule: 'x' }, { calls: 'two', rule: 'x' }, { calls: 2.5 }]) {
      const { container, unmount } = render(<ConsistencyChip provenance={{ consistency: c as never }} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('says "scored N× · rule" in both languages for an agreeing pair', () => {
    render(<ConsistencyChip provenance={{ consistency: {
      method: 'repeat', rule: 'first-of-agreeing-pair', calls: 2, max_delta: 3,
      per_call_scores: [76, 79], json_retries: 0, extra_input_tokens: 4100, extra_output_tokens: 900, latency_ms: 71000,
    } }} />);
    expect(screen.getByText('ให้คะแนน 2 ครั้ง')).toBeInTheDocument();
    expect(screen.getByText('scored 2× · first-of-agreeing-pair')).toBeInTheDocument();
    // The tooltip states the scope: display only.
    expect(screen.getByTitle(/display only/)).toBeInTheDocument();
  });

  it('handles a median-of-3 record and a missing rule without inventing one', () => {
    const { rerender } = render(<ConsistencyChip provenance={{ consistency: { rule: 'median-of-3', calls: 3 } }} />);
    expect(screen.getByText('scored 3× · median-of-3')).toBeInTheDocument();
    rerender(<ConsistencyChip provenance={{ consistency: { calls: 2 } }} />);
    expect(screen.getByText('scored 2×')).toBeInTheDocument();
  });
});
