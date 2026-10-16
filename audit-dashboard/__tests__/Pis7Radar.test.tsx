// The radar's legend labels are TEXT, and recharts paints legend text in the series colour — a mark
// colour held to 3:1, not a text colour. Measured as 12px text: coral 2.71:1 on --secondary (the auditor
// reveal panel) and 3.11:1 on the light page; slate-blue and violet 3.31–4.48:1 across both themes.
// The swatch keeps the series colour; the label is body text.
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { legendLabel } from '@/components/Pis7Radar';

describe('Pis7Radar legend', () => {
  it('renders the label in the body colour, which overrides the series colour recharts sets on its wrapper', () => {
    const { container } = render(<span style={{ color: '#cc785c' }}>{legendLabel('คุณ / You')}</span>);
    const label = container.querySelector('span > span');
    expect(label).toHaveClass('text-foreground');
    expect(label).toHaveTextContent('คุณ / You');
  });
});
