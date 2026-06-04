'use client';
import { useTheme } from './ThemeProvider';
import { useViewport } from './ViewportProvider';

const BTN = 'rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle} className={BTN}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
      {theme === 'dark' ? '☀️ สว่าง' : '🌙 มืด'}
    </button>
  );
}

export function ViewportToggle() {
  const { view, setView } = useViewport();
  const order: Array<'auto' | 'mobile' | 'desktop'> = ['auto', 'mobile', 'desktop'];
  const cycle = () => setView(order[(order.indexOf(view) + 1) % order.length]);
  const label = view === 'mobile' ? '📱 Mobile' : view === 'desktop' ? '💻 Desktop' : '🖥 Auto';
  return (
    <button type="button" onClick={cycle} className={BTN} aria-label={`Layout view: ${view}`}>
      {label}
    </button>
  );
}
