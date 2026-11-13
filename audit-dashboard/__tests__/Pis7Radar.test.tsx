// The radar's legend labels are TEXT, and recharts paints legend text in the series colour — a mark
// colour held to 3:1, not a text colour. Measured as 12px text: coral 2.71:1 on --secondary (the auditor
// reveal panel) and 3.11:1 on the light page; slate-blue and violet 3.31–4.48:1 across both themes.
// The swatch keeps the series colour; the label is body text.
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { comparisonName, legendLabel } from '@/components/Pis7Radar';

describe('Pis7Radar comparison series name', () => {
  const scores = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 };

  it('names the series by the label, whichever series it is', () => {
    expect(comparisonName({ ai: scores, label: 'คะแนนสาธิต / Demo score' })).toBe('คะแนนสาธิต / Demo score');
    expect(comparisonName({ peer: scores, label: 'อีกคน / Other' })).toBe('อีกคน / Other');
  });

  it('defaults to AI for the ai series and to the average for the peer series', () => {
    expect(comparisonName({ ai: scores })).toBe('AI');
    expect(comparisonName({ peer: scores })).toBe('ค่าเฉลี่ย / Avg');
    expect(comparisonName({ ai: scores, peer: scores })).toBe('AI');
  });
});

describe('Pis7Radar legend', () => {
  it('renders the label in the body colour, which overrides the series colour recharts sets on its wrapper', () => {
    const { container } = render(<span style={{ color: '#cc785c' }}>{legendLabel('คุณ / You')}</span>);
    const label = container.querySelector('span > span');
    expect(label).toHaveClass('text-foreground');
    expect(label).toHaveTextContent('คุณ / You');
  });
});
