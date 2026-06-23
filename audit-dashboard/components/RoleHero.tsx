// The role landing "hero": greeting band (PageIntro) + a strip of key numbers + the primary
// call-to-action. Used by /home (admin & auditor, role-aware) and composable elsewhere. Purely
// presentational — the page fetches the stats and passes them in.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageIntro } from './PageIntro';
import { StatStrip, type Stat } from './StatStrip';
import { Button } from './ui/button';

export type HeroAction = {
  label: string;
  href: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
};

export function RoleHero({
  eyebrow,
  greeting,
  subtitle,
  badge,
  stats,
  statsClassName,
  actions,
}: {
  eyebrow: string;
  greeting: string;
  subtitle?: string;
  badge?: ReactNode;
  stats: Stat[];
  statsClassName?: string;
  actions?: HeroAction[];
}) {
  return (
    <div>
      <PageIntro eyebrow={eyebrow} title={greeting} subtitle={subtitle} action={badge} />
      <div className="space-y-6">
        <StatStrip stats={stats} className={statsClassName} />
        {actions && actions.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {actions.map((a, i) => (
              <Link key={a.href} href={a.href}>
                <Button variant={a.variant ?? (i === 0 ? 'default' : 'outline')} size="lg">
                  {a.label} {i === 0 ? '→' : ''}
                </Button>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
