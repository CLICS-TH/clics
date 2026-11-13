// A responsive strip of headline stat cards — the "numbers at a glance" row shared by the role
// hero (home) and the executive overview. Extracted verbatim from the overview's inline headline
// cards so the two never drift. A card with `href` is a link that drills into its bucket; without
// one it's static. `tone` recolors the big number (default = coral/primary).
import Link from 'next/link';
import type { ReactNode } from 'react';

export type Stat = {
  value: ReactNode;
  label: string;
  href?: string;
  title?: string;
  tone?: 'default' | 'pass' | 'warn' | 'fail';
};

const TONE: Record<NonNullable<Stat['tone']>, string> = {
  // Bright coral is large-text-safe on the canvas (3.11:1, 4xl bold needs 3:1) but 2.71:1 on the
  // --secondary a linked card turns on hover, so the figure moves to --coral-on-tint there (5.65:1).
  // group-hover only fires inside the linked card; a static card never tints and keeps text-primary.
  default: 'text-primary group-hover:text-coral-on-tint',
  pass: 'text-[var(--chart-pass-text)]',
  // text-warn, not --chart-warn: that token is for solid fills and measures 2.55:1 as text here.
  warn: 'text-warn',
  fail: 'text-destructive',
};

export function StatStrip({
  stats,
  className = 'grid grid-cols-2 gap-4 @min-[768px]:grid-cols-4',
}: {
  stats: Stat[];
  className?: string;
}) {
  return (
    <div className={className}>
      {stats.map(s => {
        const inner = (
          <>
            <p className={`text-4xl font-bold tabular-nums ${TONE[s.tone ?? 'default']}`}>{s.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
          </>
        );
        return s.href ? (
          <Link
            key={s.label}
            href={s.href}
            title={s.title ?? 'คลิกเพื่อดูรายการในหมวดนี้ / Click to explore this category'}
            className="group block rounded-xl border p-5 text-center transition-colors hover:bg-secondary hover:border-primary/40 cursor-pointer"
          >
            {inner}
          </Link>
        ) : (
          <div key={s.label} title={s.title} className="rounded-xl border p-5 text-center">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
