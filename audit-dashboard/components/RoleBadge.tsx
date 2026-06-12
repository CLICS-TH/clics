'use client';
import { getUser } from '@/lib/auth';

// Tinted-background + foreground-text so it stays legible in both themes.
const ROLE: Record<string, { label: string; cls: string }> = {
  superadmin: { label: 'Superadmin · ดูแลระบบ', cls: 'bg-primary text-primary-foreground' },
  admin: { label: 'Admin · จัดการ pilot', cls: 'bg-[#5db8a6]/20 text-foreground' },
  auditor: { label: 'Auditor · ผู้ตรวจประเมิน', cls: 'bg-[#e8a55a]/20 text-foreground' },
  physician: { label: 'Physician · แพทย์อาสา', cls: 'bg-primary/15 text-foreground' },
};

export function RoleBadge() {
  const user = getUser();
  if (!user) return null;
  const m = ROLE[user.role] ?? ROLE.physician;
  return (
    <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}
