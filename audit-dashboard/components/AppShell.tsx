'use client';
import { cn } from '@/lib/utils';
import { useViewport } from './ViewportProvider';

// Wraps the whole app. In forced-mobile it caps the width to a centered phone
// frame (demo affordance); otherwise it's a transparent full-width flex column
// so the Footer's mt-auto still pins to the bottom.
export function AppShell({ children }: { children: React.ReactNode }) {
  const { forcedMobile } = useViewport();
  return (
    <div
      data-app-shell
      className={cn(
        // `@container` makes this the query container so layout grids use container queries
        // (@min-[…]) instead of viewport breakpoints — that's what lets the forced-mobile frame
        // (and real phones) actually collapse multi-column grids to one column.
        '@container flex min-h-screen w-full flex-col',
        forcedMobile && 'mx-auto max-w-[460px] border-x border-border shadow-2xl'
      )}
    >
      {children}
    </div>
  );
}
