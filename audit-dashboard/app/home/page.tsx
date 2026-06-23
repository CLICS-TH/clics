'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { PageIntro } from '@/components/PageIntro';
import { RoleBadge } from '@/components/RoleBadge';
import { RoleHero, type HeroAction } from '@/components/RoleHero';
import { CardGridSkeleton } from '@/components/Skeleton';
import { apiFetch } from '@/lib/api';
import { canAudit } from '@/lib/auth';
import { useAuthUser } from '@/lib/client-store';
import { cleStatusCards } from '@/lib/labels';
import type { Stat } from '@/components/StatStrip';
import type { CleStats } from '@/lib/types';

type IccResp = { icc: number | null; n: number };
type QueueItem = { id: string; scored?: boolean };

// /home is the role-aware hero landing for Admin (B) and Auditor (D). Superadmin (A) lands on
// /admin/overview; Physician (C) lives in the separate portal. Each role gets a greeting + a strip
// of their key numbers (from existing endpoints) + their primary action.
export default function HomePage() {
  const user = useAuthUser();
  const router = useRouter();
  const [adminStats, setAdminStats] = useState<CleStats | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [icc, setIcc] = useState<IccResp | null>(null);

  const role = user?.role;
  const isAdmin = role === 'admin';
  const isAuditor = canAudit(user);

  // Fetch only sets state in async callbacks (keeps the synchronous reset out of the effect so the
  // blocking react-hooks/set-state-in-effect lint passes — mirrors auditor/queue/page.tsx).
  const load = useCallback(() => {
    if (isAdmin) {
      apiFetch<CleStats>('/admin/stats').then(d => setAdminStats(d ?? {})).catch(() => setAdminStats({}));
    }
    if (isAuditor) {
      apiFetch<QueueItem[]>('/auditor/queue').then(d => setQueue(Array.isArray(d) ? d : [])).catch(() => setQueue([]));
      apiFetch<IccResp>('/auditor/icc').then(d => setIcc(d ?? { icc: null, n: 0 })).catch(() => setIcc({ icc: null, n: 0 }));
    }
  }, [isAdmin, isAuditor]);

  useEffect(() => {
    if (role === 'superadmin') { router.replace('/admin/overview'); return; } // exec overview is their hero
    load();
  }, [role, router, load]);

  const name = user ? (user.full_name_th || user.full_name_en) : '';
  const greeting = `สวัสดี, ${name}`;

  function body() {
    if (!user || role === 'superadmin') return <CardGridSkeleton cards={5} />; // first render / redirecting

    if (isAdmin) {
      if (!adminStats) {
        return (
          <>
            <PageIntro eyebrow="Admin · ภาพรวมของสภา / Council overview" title={greeting} action={<RoleBadge />} />
            <CardGridSkeleton cards={5} />
          </>
        );
      }
      const stats: Stat[] = cleStatusCards(adminStats).map(c => ({
        value: c.value,
        label: c.label,
        href: `/admin/cles${c.key ? `?status=${c.key}` : ''}`,
      }));
      const actions: HeroAction[] = [
        { label: 'จัดการ CLEs / Manage CLEs', href: '/admin/cles' },
        { label: 'QA Queue', href: '/admin/flagged', variant: 'outline' },
        { label: 'คำเชิญ / Invites', href: '/admin/invites', variant: 'outline' },
      ];
      return (
        <RoleHero
          eyebrow="Admin · ภาพรวมของสภา / Council overview"
          greeting={greeting}
          subtitle="จัดการ pilot cohort — CLEs · QA · คำเชิญ / Manage your council's CLEs, QA queue and invites."
          badge={<RoleBadge />}
          stats={stats}
          statsClassName="grid grid-cols-2 gap-4 @min-[480px]:grid-cols-3 @min-[768px]:grid-cols-5"
          actions={actions}
        />
      );
    }

    if (isAuditor) {
      if (!queue || !icc) {
        return (
          <>
            <PageIntro eyebrow="Auditor · คิวการประเมิน / Scoring queue" title={greeting} action={<RoleBadge />} />
            <CardGridSkeleton cards={4} />
          </>
        );
      }
      const toScore = queue.filter(q => !q.scored).length;
      const scored = queue.filter(q => q.scored).length;
      const stats: Stat[] = [
        { value: toScore, label: 'รอประเมิน / To score', tone: toScore > 0 ? 'warn' : 'default' },
        { value: scored, label: 'ประเมินแล้ว / Scored', tone: 'pass' },
        { value: queue.length, label: 'ได้รับมอบหมาย / Assigned' },
        { value: icc.icc != null ? icc.icc.toFixed(2) : '—', label: `ICC ของฉัน / My ICC${icc.n ? ` · n=${icc.n}` : ''}` },
      ];
      const actions: HeroAction[] = [{ label: 'เริ่มประเมิน / Start scoring', href: '/auditor/queue' }];
      return (
        <RoleHero
          eyebrow="Auditor · คิวการประเมิน / Scoring queue"
          greeting={greeting}
          subtitle="Blind PIS-7 scoring — เลือก CLE เพื่อให้คะแนน (คะแนน AI ถูกซ่อนไว้) / Score assigned CLEs blind."
          badge={<RoleBadge />}
          stats={stats}
          actions={actions}
        />
      );
    }

    // Defensive fallback (a physician without can_audit shouldn't reach /home — they use the portal).
    return (
      <PageIntro
        eyebrow="CLICS · Continuous Learning & Intelligence Credit System"
        title={greeting}
        subtitle="บทบาทของคุณในระบบ CLICS / Your role in CLICS"
      />
    );
  }

  return (
    <>
      <NavBar />
      <div className="mx-auto w-full max-w-5xl p-8 md:p-12">{body()}</div>
    </>
  );
}
