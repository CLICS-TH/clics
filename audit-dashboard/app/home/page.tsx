'use client';
import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { PageIntro } from '@/components/PageIntro';
import { Button } from '@/components/ui/button';
import { useAuthUser } from '@/lib/client-store';

// The 4 roles from the CLICS architecture flowchart.
const ROLES = [
  { key: 'superadmin', code: 'A', title: 'Superadmin', th: 'ดูแลภาพรวมทั้งระบบ', en: 'System oversight · ICC calibration · governance', href: '/admin/overview', cta: 'ภาพรวมผู้บริหาร / Executive overview' },
  { key: 'admin', code: 'B', title: 'Admin', th: 'จัดการ pilot cohort', en: 'Manage CLEs · QA queue · pilot stats', href: '/admin/cles', cta: 'จัดการ CLEs / Manage' },
  { key: 'physician', code: 'C', title: 'Physician · แพทย์อาสา', th: 'ทำ CLE และรับ CPD credit', en: 'Runs CLEs in the separate Physician Portal', href: null, cta: 'พอร์ทัลแพทย์ (แยกต่างหาก)' },
  { key: 'auditor', code: 'D', title: 'Expert Auditor', th: 'ตรวจประเมิน CLE แบบ blind', en: 'Blind PIS-7 scoring for ICC', href: '/auditor/queue', cta: 'เข้าคิวประเมิน / Queue' },
];

export default function HomePage() {
  const user = useAuthUser();
  const role = user?.role;
  // Only admin & auditor reach /home (see app/login redirectByRole); show just their own card.
  const mine = ROLES.find(r => r.key === role);

  return (
    <>
      <NavBar />
      <div className="mx-auto w-full max-w-5xl p-8 md:p-12">
        <PageIntro
          eyebrow="CLICS · Clinical Learning & Intelligence Credit System"
          title={`ยินดีต้อนรับ${user ? `, ${user.full_name_th || user.full_name_en}` : ''}`}
          subtitle="บทบาทของคุณในระบบ CLICS / Your role in CLICS"
        />

        {mine && (
          <div className="max-w-xl rounded-xl border border-primary bg-primary/5 p-8 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{mine.code}</span>
              <h2 className="font-heading text-xl text-foreground">{mine.title}</h2>
              <span className="ml-auto rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">บทบาทของคุณ</span>
            </div>
            <p className="mt-4 text-sm text-foreground">{mine.th}</p>
            <p className="mt-1 text-xs text-muted-foreground">{mine.en}</p>
            {mine.href && (
              <Link href={mine.href}><Button className="mt-6">{mine.cta} →</Button></Link>
            )}
          </div>
        )}
      </div>
    </>
  );
}
