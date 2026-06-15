import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// react-markdown is ESM-only and is a thin 3rd-party wrapper; here we mock it and assert
// TranscriptView's OWN logic: physician vs assistant rendering, Socratic-line stripping, the
// separate question line, and the refs join.
jest.mock('@/components/Markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
// Icons are decorative — stub them so the test doesn't depend on lucide-react's module format.
jest.mock('lucide-react', () => ({
  Paperclip: () => <svg data-testid="icon-paperclip" />,
  HelpCircle: () => <svg data-testid="icon-help" />,
}));

import { TranscriptView } from '@/components/TranscriptView';

describe('TranscriptView', () => {
  it('renders a physician turn as plain text, not through Markdown', () => {
    render(<TranscriptView messages={[{ role: 'physician', content: 'My differential is PE.' }]} />);
    expect(screen.getByText('My differential is PE.')).toBeInTheDocument();
    expect(screen.queryByTestId('md')).not.toBeInTheDocument();
  });

  it('renders an assistant turn through Markdown', () => {
    render(<TranscriptView messages={[{ role: 'assistant', content: 'Consider **sepsis**.' }]} />);
    expect(screen.getByTestId('md')).toHaveTextContent('Consider **sepsis**.');
  });

  it('strips the trailing ❓ Socratic line from the rendered assistant body', () => {
    render(
      <TranscriptView
        messages={[{ role: 'assistant', content: 'Consider sepsis.\n❓ What is the qSOFA?' }]}
      />
    );
    // The ❓ line is shown separately (via socratic_question), so it must not leak into the body.
    expect(screen.getByTestId('md')).toHaveTextContent('Consider sepsis.');
    expect(screen.getByTestId('md').textContent).not.toContain('❓');
  });

  it('renders the socratic_question on its own line', () => {
    const { container } = render(
      <TranscriptView
        messages={[
          { role: 'assistant', content: 'Sepsis is likely.', socratic_question: 'qSOFA score?' },
        ]}
      />
    );
    expect(container.textContent).toContain('qSOFA score?');
  });

  it('joins reference sources with " · "', () => {
    const { container } = render(
      <TranscriptView
        messages={[
          {
            role: 'assistant',
            content: 'See guidelines.',
            refs: [{ source: 'UpToDate' }, { source: 'NEJM' }],
          },
        ]}
      />
    );
    expect(container.textContent).toContain('UpToDate · NEJM');
  });
});
