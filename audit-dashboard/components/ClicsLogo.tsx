// The CLICS brand lockup: the serif wordmark over a geometry-only ECG-pulse line (mirrors the
// physician-ui hero logo). Server-safe — no hooks, no client boundary. The ECG is a plain SVG so
// it survives the fonts-blocked render; `currentColor` inherits the coral so it re-themes for free.
// Animation is driven entirely by the `data-anim` attribute + keyframes in globals.css:
//   'once'    — draw on, then a subtle idle heartbeat (the default brand entrance)
//   'loading' — the line draws on a loop (a live "signing you in…" indicator)
//   'none'    — static, fully-drawn line (also the reduced-motion fallback for every mode)
export function ClicsLogo({
  size = 34,
  animated = 'once',
  className = '',
}: {
  size?: number;
  animated?: 'once' | 'loading' | 'none';
  className?: string;
}) {
  const ecgW = Math.round(size * 3.4);
  return (
    <div
      className={`clics-ecg inline-flex flex-col items-center gap-1.5 ${className}`}
      data-anim={animated}
      style={{ color: 'var(--coral-active)' }}
    >
      <span
        className="font-heading font-semibold text-primary tracking-tight leading-none"
        style={{ fontSize: size }}
      >
        CLICS
      </span>
      <svg
        viewBox="0 0 220 40"
        width={ecgW}
        height={Math.round((ecgW * 40) / 220)}
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="ecg-line"
          pathLength={100}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2 28 H58 C62 28 63 23.5 66 23.5 C69 23.5 70 28 74 28 H84 L89 34 L96 6 L102 33 L106 28 H118 C122 28 124 20.5 128 20.5 C132 20.5 134 28 138 28 H218"
        />
        <path
          className="ecg-beat"
          pathLength={100}
          stroke="var(--primary)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M84 28 L89 34 L96 6 L102 33 L106 28"
        />
      </svg>
    </div>
  );
}
