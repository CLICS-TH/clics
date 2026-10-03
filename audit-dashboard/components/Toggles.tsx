'use client';
import { Sun, Moon, SunMoon, Smartphone, Monitor, MonitorSmartphone } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { useViewport } from './ViewportProvider';
import { NEXT_PREF, type ThemePref } from '@/lib/theme';

const BTN = 'inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors';

const THEME_LABEL: Record<ThemePref, { th: string; en: string }> = {
  system: { th: 'ตามระบบ', en: 'System' },
  light: { th: 'สว่าง', en: 'Light' },
  dark: { th: 'มืด', en: 'Dark' },
};

// One button that steps System → Light → Dark. It shows the CURRENT choice (icon always; label from
// sm up) and its accessible name says both what is set and what a press does.
export function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : SunMoon;
  return (
    <button type="button" onClick={cycle} className={BTN}
      aria-label={`Theme: ${THEME_LABEL[pref].en}. Switch to ${THEME_LABEL[NEXT_PREF[pref]].en}`}>
      <Icon className="size-3.5" />
      <span className="hidden sm:inline">{THEME_LABEL[pref].th}</span>
    </button>
  );
}

export function ViewportToggle() {
  const { view, setView } = useViewport();
  const order: Array<'auto' | 'mobile' | 'desktop'> = ['auto', 'mobile', 'desktop'];
  const cycle = () => setView(order[(order.indexOf(view) + 1) % order.length]);
  // Icon-only on phones (text labels would overflow the nav action cluster < 640px).
  const content =
    view === 'mobile' ? <><Smartphone className="size-3.5" /><span className="hidden sm:inline">Mobile</span></> :
    view === 'desktop' ? <><Monitor className="size-3.5" /><span className="hidden sm:inline">Desktop</span></> :
    <><MonitorSmartphone className="size-3.5" /><span className="hidden sm:inline">Auto</span></>;
  return (
    <button type="button" onClick={cycle} className={BTN} aria-label={`Layout view: ${view}`}>
      {content}
    </button>
  );
}
