'use client';
import { useRouter, usePathname } from 'next/navigation';
import { getUser } from '@/lib/auth';

export function NavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const user = getUser();
  if (!user) return null;

  const adminLinks = [
    { href: '/admin/ples', label: 'PLEs' },
    { href: '/admin/users', label: 'ผู้ใช้งาน / Users' },
    { href: '/admin/flagged', label: 'QA Queue' },
    { href: '/admin/icc', label: 'ICC' },
    { href: '/admin/stats', label: 'สถิติ / Stats' },
  ];
  const auditorLinks = [
    { href: '/auditor/queue', label: 'คิวประเมิน / Queue' },
  ];
  const links = (user.role === 'admin' || user.role === 'superadmin') ? adminLinks : auditorLinks;

  function logout() {
    localStorage.clear();
    router.push('/login');
  }

  return (
    <nav className="border-b border-border bg-background px-6 py-3 flex items-center gap-6">
      <span className="font-heading font-semibold text-primary text-lg mr-4 tracking-tight">CLICS</span>
      <div className="flex items-center gap-4 flex-1">
        {links.map(l => (
          <a
            key={l.href}
            href={l.href}
            className={pathname === l.href ? 'text-primary border-b-2 border-primary pb-0.5 text-sm font-medium' : 'text-muted-foreground hover:text-foreground text-sm'}
          >
            {l.label}
          </a>
        ))}
      </div>
      <div className="text-xs text-muted-foreground mr-4">{user.full_name_th || user.full_name_en}</div>
      <button
        onClick={logout}
        className="text-xs text-muted-foreground hover:text-destructive border border-border rounded-md px-3 py-1 transition-colors"
      >
        ออกจากระบบ / Logout
      </button>
    </nav>
  );
}
