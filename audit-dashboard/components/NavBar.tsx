'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { canAudit } from '@/lib/auth';
import { RoleBadge } from './RoleBadge';
import { ThemeToggle, ViewportToggle } from './Toggles';
import { useIsMobile } from './ViewportProvider';
import { useAuthUser } from '@/lib/client-store';
import { BiLabel } from './BiLabel';
import { Menu } from 'lucide-react';

// Role-keyed nav. Users is council-scoped for admins (read-only view); Overview + ICC stay
// superadmin-only (those endpoints 403 for admins). Requests was retired with the
// request-access flow (onboarding = Google self-service + invites).
// Labels are {th, en} for the hierarchy renderer (#12a) — Thai primary, English smaller + dimmed.
const ADMIN_LINKS = [
  { href: '/admin/cles', th: 'CLEs' },
  { href: '/admin/invites', th: 'คำเชิญ', en: 'Invites' },
  { href: '/admin/users', th: 'ผู้ใช้งาน', en: 'Users' },
  { href: '/admin/flagged', th: 'QA Queue' },
  { href: '/admin/stats', th: 'สถิติ', en: 'Stats' },
];
const SUPERADMIN_LINKS = [
  { href: '/admin/overview', th: 'ภาพรวม', en: 'Overview' },
  { href: '/admin/cles', th: 'CLEs' },
  { href: '/admin/invites', th: 'คำเชิญ', en: 'Invites' },
  { href: '/admin/users', th: 'ผู้ใช้งาน', en: 'Users' },
  { href: '/admin/flagged', th: 'QA Queue' },
  { href: '/admin/icc', th: 'ICC' },
  { href: '/admin/stats', th: 'สถิติ', en: 'Stats' },
];
const AUDITOR_LINKS = [{ href: '/auditor/queue', th: 'คิวประเมิน', en: 'Queue' }];
// Tier-3 analyst (aggregates only) + Tier-4 ethics (aggregates + audit log). Read-only, no transcripts.
const ANALYST_LINKS = [{ href: '/analyst', th: 'ภาพรวม', en: 'Analytics' }];
const ETHICS_LINKS = [{ href: '/ethics', th: 'บันทึกตรวจสอบ', en: 'Audit log' }];

export function NavBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Auth + viewport are client-only; useSyncExternalStore (no mount effect) keeps SSR and the first
  // client render in agreement, then swaps to the live value — so we render null until the user is
  // known, and the menu closes on selection via each link's onClick (below) rather than an effect.
  const user = useAuthUser();
  const mobile = useIsMobile();
  if (!user) return null;

  const links =
    user.role === 'superadmin' ? SUPERADMIN_LINKS :
    user.role === 'admin' ? ADMIN_LINKS :
    user.role === 'analyst' ? ANALYST_LINKS :
    user.role === 'ethics' ? ETHICS_LINKS :
    // Auditors and dual-role physicians (can_audit) get the auditor workspace.
    canAudit(user) ? AUDITOR_LINKS : [];

  function logout() {
    // Clearing only our (dashboard-origin) token isn't enough — the PORTAL origin still holds a valid
    // token and autoForward there would re-log us straight back in. Bounce to the portal's logout,
    // which clears its own storage and shows the login form (so you can sign in as another account).
    // Preserve the dashboard-origin theme/view prefs (mirror the portal's ?logout=1 handler) so logging
    // out doesn't reset a dark-mode user to light.
    const theme = localStorage.getItem('clics_theme');
    const view = localStorage.getItem('clics_view');
    localStorage.clear();
    if (theme) localStorage.setItem('clics_theme', theme);
    if (view) localStorage.setItem('clics_view', view);
    const portal = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://physician-ui.vercel.app';
    window.location.href = `${portal}/?logout=1`;
  }

  // Active when the path matches OR is a child (detail page) of the link, so /admin/cles/[id] keeps
  // 'CLEs' lit and /auditor/cles/[id] keeps 'Queue' lit. /home (exact) never false-matches a section.
  const isActive = (href: string) =>
    pathname === href ||
    pathname.startsWith(href + '/') ||
    // The auditor's only tab is the queue; its scoring detail lives under /auditor/cles/...
    (href === '/auditor/queue' && pathname.startsWith('/auditor/'));

  const linkClass = (href: string) =>
    isActive(href)
      ? 'text-primary border-b-2 border-primary pb-0.5 text-sm font-medium'
      : 'text-muted-foreground hover:text-foreground text-sm';

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background px-6 py-4 md:px-8">
      <div className="flex items-center gap-4">
        <Link href="/home" className="font-heading font-semibold text-primary text-lg tracking-tight">CLICS</Link>

        {/* Desktop links */}
        {!mobile && (
          <div className="flex flex-1 items-center gap-5">
            {links.map(l => <Link key={l.href} href={l.href} className={linkClass(l.href)}><BiLabel th={l.th} en={l.en} /></Link>)}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <RoleBadge />
          <ViewportToggle />
          <ThemeToggle />
          {!mobile && (
            <button onClick={logout}
              className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive">
              <BiLabel th="ออกจากระบบ" en="Logout" />
            </button>
          )}
          {mobile && (
            <button onClick={() => setOpen(o => !o)} aria-label="เมนู / Menu" aria-expanded={open}
              className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground">
              <Menu className="size-5" />
            </button>
          )}
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobile && open && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {links.map(l => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
              className={`rounded-md px-2 py-2 text-sm ${isActive(l.href) ? 'bg-secondary text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
              <BiLabel th={l.th} en={l.en} />
            </Link>
          ))}
          <button onClick={logout}
            className="mt-1 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:text-destructive">
            <BiLabel th="ออกจากระบบ" en="Logout" />
          </button>
        </div>
      )}
    </nav>
  );
}
