// Minimal editorial "intro band" shared by every dashboard page:
// tracked coral eyebrow → serif title → muted subtitle → hairline divider,
// with a gentle fade/slide-up on load (disabled under prefers-reduced-motion).
export function PageIntro({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-8 border-b border-border pb-5 animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">{eyebrow}</p>
          <h1 className="mt-2 font-heading text-3xl leading-tight text-foreground">{title}</h1>
          {subtitle && <p className="mt-2 max-w-prose text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  );
}
