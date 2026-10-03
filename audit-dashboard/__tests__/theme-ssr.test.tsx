/**
 * @jest-environment node
 */
// The two getServerSnapshot callbacks only run when React renders on the server, which needs a
// non-DOM environment (react-dom/server wants MessageChannel). Kept separate from theme.test.tsx for
// that reason. SSR and the first client render must agree, or hydration warns and the page flashes.
import { renderToString } from 'react-dom/server';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';

function Probe() {
  const { theme, pref } = useTheme();
  return <p>{`${pref}/${theme}`}</p>;
}

it('server render uses the safe defaults: system / light', () => {
  expect(renderToString(<ThemeProvider><Probe /></ThemeProvider>)).toContain('system/light');
});
