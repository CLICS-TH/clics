'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getUser, canAudit } from '@/lib/auth';
import { RoleBadge } from './RoleBadge';
import { ThemeToggle, ViewportToggle } from './Toggles';
import { useViewport } from './ViewportProvider';

// Role-keyed nav. Users is council-scoped for admins (read-only view); Overview + ICC stay
// superadmin-only (those endpoints 403 for admins). Requests was retired with the
// request-access flow (onboarding = Google self-service + invites).
const ADMIN_LINKS = [
  { href: '/admin/ples', label: 'PLEs' },
  { href: '/admin/invites', label: 'คำเชิญ / Invites' },
  { href: '/admin/users', label: 'ผู้ใช้งาน / Users' },
  { href: '/admin/flagged', label: 'QA Queue' },
  { href: '/admin/stats', label: 'สถิติ / Stats' },
];
const SUPERADMIN_LINKS = [
  { href: '/admin/overview', label: 'ภาพรวม / Overview' },
  { href: '/admin/ples', label: 'PLEs' },
  { href: '/admin/invites', label: 'คำเชิญ / Invites' },
  { href: '/admin/users', label: 'ผู้ใช้งาน / Users' },
  { href: '/admin/flagged', label: 'QA Queue' },
  { href: '/admin/icc', label: 'ICC' },
  { href: '/admin/stats', label: 'สถิติ / Stats' },
];
const AUDITOR_LINKS = [{ href: '/auditor/queue', label: 'คิวประเมิน / Queue' }];

export function NavBar() {
  const pathname = usePathname();
  const { forcedMobile, forcedDesktop } = useViewport();
  const [isNarrow, setIsNarrow] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Close the mobile menu on navigation.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Auth/viewport state is client-only — render nothing until mounted so the
  // server HTML and first client render match (avoids hydration mismatch).
  const user = mounted ? getUser() : null;
  if (!mounted || !user) return null;

  const links =
    user.role === 'superadmin' ? SUPERADMIN_LINKS :
    user.role === 'admin' ? ADMIN_LINKS :
    // Auditors and dual-role physicians (can_audit) get the auditor workspace.
    canAudit(user) ? AUDITOR_LINKS : [];
  const mobile = forcedMobile || (!forcedDesktop && isNarrow);

  function logout() {
    // Clearing only our (dashboard-origin) token isn't enough — the PORTAL origin still holds a valid
    // token and autoForward there would re-log us straight back in. Bounce to the portal's logout,
    // which clears its own storage and shows the login form (so you can sign in as another account).
    localStorage.clear();
    const portal = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://physician-ui.vercel.app';
    window.location.href = `${portal}/?logout=1`;
  }

  const linkClass = (href: string) =>
    pathname === href
      ? 'text-primary border-b-2 border-primary pb-0.5 text-sm font-medium'
      : 'text-muted-foreground hover:text-foreground text-sm';

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background px-6 py-4 md:px-8">
      <div className="flex items-center gap-4">
        <Link href="/home" className="font-heading font-semibold text-primary text-lg tracking-tight">CLICS</Link>

        {/* Desktop links */}
        {!mobile && (
          <div className="flex flex-1 items-center gap-5">
            {links.map(l => <Link key={l.href} href={l.href} className={linkClass(l.href)}>{l.label}</Link>)}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <RoleBadge />
          <ViewportToggle />
          <ThemeToggle />
          {!mobile && (
            <button onClick={logout}
              className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive">
              ออกจากระบบ / Logout
            </button>
          )}
          {mobile && (
            <button onClick={() => setOpen(o => !o)} aria-label="เมนู / Menu" aria-expanded={open}
              className="rounded-md border border-border px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground">
              ☰
            </button>
          )}
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobile && open && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {links.map(l => (
            <Link key={l.href} href={l.href}
              className={`rounded-md px-2 py-2 text-sm ${pathname === l.href ? 'bg-secondary text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
              {l.label}
            </Link>
          ))}
          <button onClick={logout}
            className="mt-1 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:text-destructive">
            ออกจากระบบ / Logout
          </button>
        </div>
      )}
    </nav>
  );
}
