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
import { pleStatusCards } from '@/lib/labels';
import { Pis7Radar } from '@/components/Pis7Radar';
import { pis7Conclusion } from '@/lib/pis7-delta';
import type { Stat } from '@/components/StatStrip';
import type { CleStats, AuditorCalibration } from '@/lib/types';

type IccResp = { icc: number | null; n: number; locked?: boolean };
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
  const [calib, setCalib] = useState<AuditorCalibration | null>(null);

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
      apiFetch<AuditorCalibration>('/auditor/calibration').then(d => setCalib(d ?? { n: 0, auditor: null, ai: null })).catch(() => setCalib({ n: 0, auditor: null, ai: null }));
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
      const stats: Stat[] = pleStatusCards(adminStats).map(c => ({
        value: c.value,
        label: c.label,
        href: `/admin/ples${c.key ? `?status=${c.key}` : ''}`,
      }));
      const actions: HeroAction[] = [
        { label: 'จัดการ PLEs / Manage PLEs', href: '/admin/ples' },
        { label: 'QA Queue', href: '/admin/flagged', variant: 'outline' },
        { label: 'คำเชิญ / Invites', href: '/admin/invites', variant: 'outline' },
      ];
      return (
        <RoleHero
          eyebrow="Admin · ภาพรวมของสภา / Council overview"
          greeting={greeting}
          subtitle="จัดการ pilot cohort — PLEs · QA · คำเชิญ / Manage your council's PLEs, QA queue and invites."
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
        { value: toScore, label: 'รอประเมิน / To score', tone: toScore > 0 ? 'warn' : 'default', href: '/auditor/queue' },
        { value: scored, label: 'ประเมินแล้ว / Scored', tone: 'pass', href: '/auditor/queue' },
        { value: queue.length, label: 'ได้รับมอบหมาย / Assigned', href: '/auditor/queue' },
        // During a calibration round this is withheld, not absent. A bare '—' is what a rater who has
        // never scored anything sees, so without the label the console reads as having lost their work.
        { value: icc.locked ? '🙈' : icc.icc != null ? icc.icc.toFixed(2) : '—',
          label: icc.locked ? 'ICC ของฉัน / My ICC · ปิดระหว่างรอบสอบเทียบ' : `ICC ของฉัน / My ICC${icc.n ? ` · n=${icc.n}` : ''}` },
      ];
      const actions: HeroAction[] = [{ label: 'เริ่มประเมิน / Start scoring', href: '/auditor/queue' }];
      return (
        <div className="space-y-8">
          <RoleHero
            eyebrow="Auditor · คิวการประเมิน / Scoring queue"
            greeting={greeting}
            subtitle="Blind PIS-7 scoring — เลือก PLE เพื่อให้คะแนน (คะแนน AI ถูกซ่อนไว้) / Score assigned PLEs blind."
            badge={<RoleBadge />}
            stats={stats}
            actions={actions}
          />
          {/* Withheld for the round, and said so. Both radars below are gated on n > 0, so with the
              lock on they simply vanish — indistinguishable from having scored nothing. Wording
              mirrors the score page's locked banner so the same round explains itself the same way. */}
          {calib?.locked && (
            <div className="rounded-xl border p-5">
              <h2 className="font-sans text-lg font-semibold mb-1">🙈 ปิดการเผยคะแนนไว้ระหว่างรอบสอบเทียบ <span className="text-sm font-normal text-muted-foreground">/ Comparisons locked for this round</span></h2>
              <p className="text-xs text-muted-foreground leading-relaxed">
                คะแนนที่คุณส่งไปแล้วถูกบันทึกครบ ระหว่างรอบสอบเทียบระบบจะยังไม่แสดงการเทียบกับ AI และกับผู้ตรวจท่านอื่น
                เพื่อให้แต่ละ PLE ถูกให้คะแนนอย่างเป็นอิสระ ผู้ประสานงานจะเปิดให้ดูเมื่อทุกท่านให้คะแนนครบแล้ว •
                Every score you have submitted is saved. Your comparisons against the AI and against other
                auditors stay hidden for the duration of the round so each PLE is scored independently.
                The coordinator opens them once every rater has finished.
              </p>
            </div>
          )}
          {/* Aggregate calibration radar: your mean PIS-7 vs the AI's across everything you've scored.
              Only meaningful once at least one scored PLE has an AI evaluation to pair with (n>0). */}
          {calib && calib.n > 0 && calib.auditor && calib.ai && (
            <div className="rounded-xl border p-5">
              <h2 className="font-sans text-lg font-semibold mb-1">การปรับเทียบของคุณ vs AI <span className="text-sm font-normal text-muted-foreground">/ Your calibration vs AI · n={calib.n}</span></h2>
              <p className="text-xs text-muted-foreground mb-3">ค่าเฉลี่ยรายหมวด PIS-7 จาก PLE ที่คุณประเมินแล้ว / Mean PIS-7 by domain across the PLEs you have scored.</p>
              <Pis7Radar ai={calib.ai} human={calib.auditor} />
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{pis7Conclusion(calib.ai, calib.auditor)}</p>
            </div>
          )}
          {/* Peer calibration (toggle): your mean vs the auditor-cohort mean across the same PLEs. */}
          {calib && calib.n > 0 && calib.auditor && calib.peer && (
            <div className="rounded-xl border p-5">
              <h2 className="font-sans text-lg font-semibold mb-1">การปรับเทียบของคุณ vs ค่าเฉลี่ยผู้ประเมิน <span className="text-sm font-normal text-muted-foreground">/ Your calibration vs auditor average · n={calib.n}</span></h2>
              <p className="text-xs text-muted-foreground mb-3">ค่าเฉลี่ยรายหมวด PIS-7 ของคุณเทียบกับค่าเฉลี่ยของผู้ประเมินทั้งหมด / Your mean PIS-7 vs the auditor-cohort mean across the PLEs you have scored.</p>
              <Pis7Radar peer={calib.peer} human={calib.auditor} />
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{pis7Conclusion(calib.peer, calib.auditor, { th: 'ค่าเฉลี่ยผู้ประเมิน', en: 'the auditor average' })}</p>
            </div>
          )}
        </div>
      );
    }

    // Defensive fallback (a physician without can_audit shouldn't reach /home — they use the portal).
    return (
      <PageIntro
        eyebrow="CLICS · Case-based Learning Intelligence Credit System"
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
