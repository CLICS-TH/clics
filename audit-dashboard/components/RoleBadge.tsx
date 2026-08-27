'use client';
import { getUser } from '@/lib/auth';

// Tinted-background + foreground-text so it stays legible in both themes. The Thai subtitle is dropped
// on phones (< 640px) so the nav action cluster fits without horizontal overflow.
const ROLE: Record<string, { label: string; sub: string; cls: string }> = {
    // bg-coral-active: white on bright --primary measures 3.28:1 at this 13px/500. See badge.tsx.
  superadmin: { label: 'Superadmin', sub: 'ดูแลระบบ', cls: 'bg-coral-active text-primary-foreground' },
  admin: { label: 'Admin', sub: 'จัดการ pilot', cls: 'bg-[#5db8a6]/20 text-foreground' },
  auditor: { label: 'Auditor', sub: 'ผู้ตรวจประเมิน', cls: 'bg-[#e8a55a]/20 text-foreground' },
  physician: { label: 'Physician', sub: 'แพทย์อาสา', cls: 'bg-primary/15 text-foreground' },
};

export function RoleBadge() {
  const user = getUser();
  if (!user) return null;
  const m = ROLE[user.role] ?? ROLE.physician;
  return (
    <span className={`min-w-0 shrink truncate rounded-full px-3 py-1 text-xs font-medium ${m.cls}`}>
      {m.label}<span className="hidden sm:inline"> · {m.sub}</span>
    </span>
  );
}
