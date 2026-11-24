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
      {/* The title keeps an 18rem basis: where the action cannot fit beside that, it wraps below the title
          instead of squeezing it. Side by side, a wide action (Booth Mode's export button) left a 320px phone's
          title about 60px. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_18rem]">
          {/* text-link, not text-primary: bright coral is 3.11:1 on the light canvas. */}
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-link">{eyebrow}</p>
          <h1 className="mt-2 font-heading text-3xl leading-tight text-foreground">{title}</h1>
          {subtitle && <p className="mt-2 max-w-prose text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  );
}
