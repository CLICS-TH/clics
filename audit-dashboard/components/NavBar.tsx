'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { canAudit, clearSession } from '@/lib/auth';
import { getToken, revokeSession } from '@/lib/api';
import { RoleBadge } from './RoleBadge';
import { ThemeToggle, ViewportToggle } from './Toggles';
import { useIsNavCompact } from './ViewportProvider';
import { useAuthUser } from '@/lib/client-store';
import { BiLabel } from './BiLabel';
import { POSITION_TH } from '@/lib/labels';
import { PORTAL } from '@/lib/portal';
import { Menu } from 'lucide-react';

// Role-keyed nav. Users is council-scoped for admins (read-only view); Overview + ICC stay
// superadmin-only (those endpoints 403 for admins). Requests was retired with the
// request-access flow (onboarding = Google self-service + invites).
// Labels are {th, en} for the hierarchy renderer (#12a) — Thai primary, English smaller + dimmed.
export type NavLink = { href: string; th: string; en?: string };
export type NavGroup = { th: string; en?: string; links: NavLink[] };

export const ADMIN_LINKS: NavLink[] = [
  { href: '/admin/ples', th: 'PLEs' },
  { href: '/admin/invites', th: 'คำเชิญ', en: 'Invites' },
  { href: '/admin/users', th: 'ผู้ใช้งาน', en: 'Users' },
  { href: '/admin/flagged', th: 'QA Queue' },
  { href: '/admin/privacy', th: 'ความเป็นส่วนตัว', en: 'Privacy' },
  { href: '/admin/integrity', th: 'ความสุจริต', en: 'Integrity' },
  { href: '/admin/identity', th: 'ยืนยันตัวตน', en: 'Identity' },
  { href: '/admin/compensation', th: 'ค่าตอบแทน', en: 'Payouts' },
  { href: '/admin/stats', th: 'สถิติ', en: 'Stats' },
];
// The superadmin menu is grouped: 16 links in one flat list were a wall to scan. The row this roster would need
// inline is wider than any real monitor (nav-width.test.ts), so in practice it is always the menu, and the menu
// shows these headings. The inline row, on the rare screen wide enough for it, lists the same links in this order.
export const SUPERADMIN_GROUPS: NavGroup[] = [
  { th: 'ภาพรวม', en: 'Overview', links: [
    { href: '/admin/overview', th: 'ภาพรวม', en: 'Overview' },
    { href: '/admin/stats', th: 'สถิติ', en: 'Stats' },
    { href: '/admin/icc', th: 'ICC' },
  ] },
  { th: 'งานตรวจ', en: 'Review', links: [
    { href: '/admin/ples', th: 'PLEs' },
    { href: '/admin/flagged', th: 'QA Queue' },
  ] },
  { th: 'บุคคล', en: 'People', links: [
    { href: '/admin/users', th: 'ผู้ใช้งาน', en: 'Users' },
    { href: '/admin/invites', th: 'คำเชิญ', en: 'Invites' },
    { href: '/admin/compensation', th: 'ค่าตอบแทน', en: 'Payouts' },
  ] },
  { th: 'ธรรมาภิบาล', en: 'Governance', links: [
    { href: '/admin/privacy', th: 'ความเป็นส่วนตัว', en: 'Privacy' },
    { href: '/admin/integrity', th: 'ความสุจริต', en: 'Integrity' },
    { href: '/admin/identity', th: 'ยืนยันตัวตน', en: 'Identity' },
    { href: '/admin/governance', th: 'ธรรมาภิบาล', en: 'Governance' },
  ] },
  { th: 'AI', links: [
    { href: '/admin/ai-readiness', th: 'ความพร้อม AI', en: 'AI readiness' },
    { href: '/admin/evaluator-lock', th: 'ล็อกโมเดล', en: 'Model Lock' },
  ] },
  { th: 'ระบบ', en: 'System', links: [
    { href: '/admin/settings', th: 'การตั้งค่า', en: 'Settings' },
    { href: '/admin/booth', th: 'โหมดบูธ', en: 'Booth Mode' },
  ] },
];
export const SUPERADMIN_LINKS: NavLink[] = SUPERADMIN_GROUPS.flatMap((g) => g.links);
export const AUDITOR_LINKS: NavLink[] = [
  { href: '/auditor/queue', th: 'คิวประเมิน', en: 'Queue' },
  // /manual, NOT /auditor/manual: isActive below treats any /auditor/* path as the queue, so a
  // manual under that prefix would keep Queue lit while the reader is in the manual.
  { href: '/manual', th: 'คู่มือ', en: 'Manual' },
];
// Tier-3 analyst (aggregates only) + Tier-4 ethics (aggregates + audit log). Read-only, no transcripts.
export const ANALYST_LINKS: NavLink[] = [{ href: '/analyst', th: 'ภาพรวม', en: 'Analytics' }];
export const ETHICS_LINKS: NavLink[] = [{ href: '/ethics', th: 'บันทึกตรวจสอบ', en: 'Audit log' }];

export function NavBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Auth + viewport are client-only; useSyncExternalStore (no mount effect) keeps SSR and the first
  // client render in agreement, then swaps to the live value — so we render null until the user is
  // known, and the menu closes on selection via each link's onClick (below) rather than an effect.
  const user = useAuthUser();
  // Resolved BEFORE the early return, because the width at which the row may render inline depends
  // on how many links this role has — and a hook cannot be called after a conditional return.
  const links = !user ? [] :
    user.role === 'superadmin' ? SUPERADMIN_LINKS :
    user.role === 'admin' ? ADMIN_LINKS :
    user.role === 'analyst' ? ANALYST_LINKS :
    user.role === 'ethics' ? ETHICS_LINKS :
    // Auditors and dual-role physicians (can_audit) get the auditor workspace.
    canAudit(user) ? AUDITOR_LINKS : [];
  // "Special" dual-role user (a physician who also audits). They reach the auditor workspace via the
  // portal token-handoff, so they can hop back to their physician workspace WITHOUT logging out — the
  // session still lives on the portal origin. Resolved here, before the hook, because their inline
  // row carries one more bilingual control (Return to Physician) and is sized as one more link.
  const isSpecial = !!user && user.role === 'physician' && !!user.can_audit;
  // Below the width this row needs (or in forced-mobile) we show the hamburger so the Thai+English
  // labels never wrap and the identity cluster is never pushed off-screen. The threshold scales with
  // links.length; a FIXED one is what let admin (9) and superadmin (14) overflow every real monitor.
  const compact = useIsNavCompact(links.length + (isSpecial ? 1 : 0));
  const menuId = useId();
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuOpen = open && compact;
  // Escape closes the mobile menu and puts focus back on the button that opened it (a keyboard user
  // who opened the menu otherwise lands nowhere). Registered only while the menu is actually showing.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuBtn.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  if (!user) return null;

  function logout() {
    // The session is the Portal's too (one origin), so this wipe signs both out; the Portal's logout mode
    // then shows its sign-in form rather than forwarding.
    const token = getToken();
    clearSession();
    revokeSession(token);
    window.location.href = PORTAL.logout;
  }

  // The Portal shares this origin's session, so the dual-role user stays signed in on the way back.
  function returnToPhysician() {
    window.location.replace(PORTAL.dashboard);
  }

  // Active when the path matches OR is a child (detail page) of the link, so /admin/ples/[id] keeps
  // 'PLEs' lit and /auditor/ples/[id] keeps 'Queue' lit. /home (exact) never false-matches a section.
  const isActive = (href: string) =>
    pathname === href ||
    pathname.startsWith(href + '/') ||
    // The auditor's only tab is the queue; its scoring detail lives under /auditor/ples/...
    (href === '/auditor/queue' && pathname.startsWith('/auditor/'));

  // Identity line under the name: specialty · position (the layer under council). Empty for global roles.
  const specialtyLine = [user.specialty_name_th, user.position ? POSITION_TH[user.position] : null]
    .filter(Boolean).join(' · ');

  const linkClass = (href: string) =>
    isActive(href)
      // text-LINK, not text-primary: bright --primary measures 3.11:1 on the canvas, which is the
      // exact failure the --link token exists for (globals.css:107). The border-b stays --primary —
      // a 2px rule is not text and only needs the 3:1 non-text floor.
      ? 'whitespace-nowrap text-link border-b-2 border-primary pb-0.5 text-sm font-medium'
      : 'whitespace-nowrap text-muted-foreground hover:text-foreground text-sm';

  const groups = user.role === 'superadmin' ? SUPERADMIN_GROUPS : null;
  const menuLink = (l: NavLink) => (
    <Link key={l.href} href={l.href} onClick={() => setOpen(false)} aria-current={isActive(l.href) ? 'page' : undefined}
      className={`rounded-md px-2 py-2 text-sm ${isActive(l.href) ? 'bg-secondary text-coral-on-tint font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
      <BiLabel th={l.th} en={l.en} />
    </Link>
  );

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background px-6 py-4 md:px-8">
      <div className="flex items-center gap-4">
        <Link href="/home" className="font-heading font-semibold text-link text-lg tracking-tight">CLICS</Link>

        {/* Desktop links */}
        {!compact && (
          <div className="flex flex-1 items-center gap-4">
            {links.map(l => <Link key={l.href} href={l.href} className={linkClass(l.href)} aria-current={isActive(l.href) ? 'page' : undefined}><BiLabel th={l.th} en={l.en} /></Link>)}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Identity: name + specialty · position (the layer under council). Hidden on phones to save width. */}
          {!compact && (
            <div className="mr-1 max-w-44 text-right leading-tight">
              <p className="truncate text-sm font-medium text-foreground" title={user.full_name_th || user.full_name_en || ''}>{user.full_name_th || user.full_name_en}</p>
              {specialtyLine && <p className="truncate text-xs text-muted-foreground" title={specialtyLine}>{specialtyLine}</p>}
            </div>
          )}
          {/* On phones the compact bar holds three 44px touch controls and the chip leaves for the menu's
              identity header below. With all four, the cluster ran to x=342 on a 320px viewport and
              scrolled the page sideways. The chip is identity rather than a control, and the name and
              specialty already sit in the menu on phones. */}
          <RoleBadge className={compact ? 'max-sm:hidden' : undefined} />
          <ViewportToggle />
          <ThemeToggle />
          {/* whitespace-nowrap on these and on the toggles: squeezed, they used to WRAP ("ออกจาก/ระบบ")
              instead of overflowing, so the nav-width audit's overflow check never saw a too-eager
              threshold. Now a squeeze shows up as overflow, which the audit and the model catch. */}
          {!compact && isSpecial && (
            <button onClick={returnToPhysician}
              className="whitespace-nowrap rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-link">
              <BiLabel th="กลับสู่หน้าแพทย์" en="Return to Physician" />
            </button>
          )}
          {!compact && (
            <button onClick={logout}
              className="whitespace-nowrap rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-danger">
              <BiLabel th="ออกจากระบบ" en="Logout" />
            </button>
          )}
          {compact && (
            <button ref={menuBtn} onClick={() => setOpen(o => !o)} aria-label="เมนู / Menu" aria-expanded={open} aria-controls={menuOpen ? menuId : undefined}
              className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground">
              <Menu className="size-5" />
            </button>
          )}
        </div>
      </div>

      {/* Mobile dropdown */}
      {compact && open && (
        <div id={menuId} className="mt-3 flex flex-col gap-2 border-t border-border pt-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Identity header (the desktop identity block is hidden on phones, so surface it here). */}
          <div className="px-2 pb-1">
            <p className="text-sm font-medium text-foreground">{user.full_name_th || user.full_name_en}</p>
            {specialtyLine && <p className="text-xs text-muted-foreground">{specialtyLine}</p>}
            <RoleBadge fullLabel className="mt-1.5 block w-fit max-w-full sm:hidden" />
          </div>
          {/* Grouped (superadmin): each heading names a group of links for a screen reader as well, and the groups
              sit side by side once the menu has the width, so 16 links do not run down the whole screen. */}
          {groups ? (
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 @min-[640px]:grid-cols-2 @min-[1024px]:grid-cols-3">
              {groups.map((g, i) => (
                <div key={g.th} role="group" aria-labelledby={`${menuId}-g${i}`} className="flex flex-col gap-1">
                  {/* text-foreground, not muted: in the one-column phone menu a muted heading read as one more link. */}
                  <p id={`${menuId}-g${i}`} className="px-2 text-xs font-semibold text-foreground">
                    <BiLabel th={g.th} en={g.en} />
                  </p>
                  {g.links.map(menuLink)}
                </div>
              ))}
            </div>
          ) : links.map(menuLink)}
          {isSpecial && (
            <button onClick={returnToPhysician}
              className="rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:text-link">
              <BiLabel th="กลับสู่หน้าแพทย์" en="Return to Physician" />
            </button>
          )}
          <button onClick={logout}
            className="mt-1 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:text-danger">
            <BiLabel th="ออกจากระบบ" en="Logout" />
          </button>
        </div>
      )}
    </nav>
  );
}
