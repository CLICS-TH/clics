'use client';
import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { PageIntro } from '@/components/PageIntro';
import { Button } from '@/components/ui/button';
import { useAuthUser } from '@/lib/client-store';

// The 4 roles from the CLICS architecture flowchart.
const ROLES = [
  { key: 'superadmin', code: 'A', title: 'Superadmin', th: 'ดูแลภาพรวมทั้งระบบ', en: 'System oversight · ICC calibration · governance', href: '/admin/overview', cta: 'ภาพรวมผู้บริหาร / Executive overview' },
  { key: 'admin', code: 'B', title: 'Admin', th: 'จัดการ pilot cohort', en: 'Manage PLEs · QA queue · pilot stats', href: '/admin/ples', cta: 'จัดการ PLEs / Manage' },
  { key: 'physician', code: 'C', title: 'Physician · แพทย์อาสา', th: 'ทำ PLE และรับ CPD credit', en: 'Runs PLEs in the separate Physician Portal', href: null, cta: 'พอร์ทัลแพทย์ (แยกต่างหาก)' },
  { key: 'auditor', code: 'D', title: 'Expert Auditor', th: 'ตรวจประเมิน PLE แบบ blind', en: 'Blind PIS-7 scoring for ICC', href: '/auditor/queue', cta: 'เข้าคิวประเมิน / Queue' },
];

export default function HomePage() {
  const user = useAuthUser();
  const role = user?.role;

  return (
    <>
      <NavBar />
      <div className="mx-auto w-full max-w-5xl p-8 md:p-12">
        <PageIntro
          eyebrow="CLICS · Clinical Learning & Intelligence Credit System"
          title={`ยินดีต้อนรับ${user ? `, ${user.full_name_th || user.full_name_en}` : ''}`}
          subtitle="ระบบ 4 บทบาทตามผังสถาปัตยกรรม / The four roles in the CLICS architecture"
        />

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {ROLES.map(r => {
            const active = r.key === role;
            return (
              <div
                key={r.key}
                className={`rounded-xl border p-8 transition-all hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card'}`}
              >
                <div className="flex items-center gap-3">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{r.code}</span>
                  <h2 className="font-heading text-xl text-foreground">{r.title}</h2>
                  {active && <span className="ml-auto rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">บทบาทของคุณ</span>}
                </div>
                <p className="mt-4 text-sm text-foreground">{r.th}</p>
                <p className="mt-1 text-xs text-muted-foreground">{r.en}</p>
                {active && r.href && (
                  <Link href={r.href}><Button className="mt-6">{r.cta} →</Button></Link>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
