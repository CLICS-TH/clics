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
    <nav className="border-b bg-white px-6 py-3 flex items-center gap-6">
      <span className="font-bold text-blue-600 text-lg mr-4">CLICS</span>
      <div className="flex items-center gap-4 flex-1">
        {links.map(l => (
          <a
            key={l.href}
            href={l.href}
            className={`text-sm font-medium ${pathname === l.href ? 'text-blue-600 border-b-2 border-blue-600 pb-0.5' : 'text-slate-600 hover:text-blue-600'}`}
          >
            {l.label}
          </a>
        ))}
      </div>
      <div className="text-xs text-slate-400 mr-4">{user.full_name_th || user.full_name_en}</div>
      <button
        onClick={logout}
        className="text-xs text-slate-500 hover:text-red-500 border rounded px-3 py-1"
      >
        ออกจากระบบ / Logout
      </button>
    </nav>
  );
}
