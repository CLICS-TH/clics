'use client';
import { getUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

// Tinted-background + foreground-text so it stays legible in both themes. The Thai subtitle is dropped
// on phones (< 640px) wherever the chip shares a row (a PageIntro title, the nav bar) so the row fits
// without horizontal overflow. `fullLabel` keeps it where there is room: the NavBar menu, which
// carries the chip on phones (see NavBar.tsx).
const ROLE: Record<string, { label: string; sub: string; cls: string }> = {
    // bg-coral-active: white on bright --primary measures 3.28:1 at this 13px/500. See badge.tsx.
  superadmin: { label: 'Superadmin', sub: 'ดูแลระบบ', cls: 'bg-coral-active text-primary-foreground' },
  admin: { label: 'Admin', sub: 'จัดการ pilot', cls: 'bg-chart-teal/20 text-foreground' },
  auditor: { label: 'Auditor', sub: 'ผู้ตรวจประเมิน', cls: 'bg-chart-threshold/20 text-foreground' },
  physician: { label: 'Physician', sub: 'แพทย์อาสา', cls: 'bg-primary/15 text-foreground' },
};

export function RoleBadge({ className, fullLabel = false }: { className?: string; fullLabel?: boolean }) {
  const user = getUser();
  if (!user) return null;
  const m = ROLE[user.role] ?? ROLE.physician;
  return (
    <span className={cn('min-w-0 shrink truncate rounded-full px-3 py-1 text-xs font-medium', m.cls, className)}>
      {m.label}<span className={fullLabel ? undefined : 'hidden sm:inline'}> · {m.sub}</span>
    </span>
  );
}
