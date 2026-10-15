// Bilingual label hierarchy (#12a): Thai primary, English smaller — replaces the
// equal-weight "Thai / English" slash that doubled on-screen text and flattened hierarchy.
// In dense tables, pass `tooltip` to keep Thai-only with the English on hover.
/*
 * NO OPACITY on the English half — size and weight already carry the hierarchy, and the fade only
 * ever cost contrast. It was `opacity-[0.85]`, which the 2026-08 readability sweep measured at
 * 4.14:1 on the coral button fill, 3.82:1 in the nav (43 occurrences) and 4.29:1 in dark — all under
 * the 4.5:1 floor. physician-ui/public/css/main.css:701-710 had already reached this conclusion for
 * `.bi-en`, with the same numbers, and recorded it; the dashboard's copy never got the fix. At full
 * opacity the English half inherits the parent colour exactly, so it is covered by whatever pair
 * __tests__/contrast.test.ts already pins for that surface rather than needing its own.
 */
export function BiLabel({
  th,
  en,
  tooltip = false,
  className,
}: {
  th: string;
  en?: string;
  tooltip?: boolean;
  className?: string;
}) {
  if (!en) return <span className={className}>{th}</span>;
  if (tooltip)
    return (
      <span className={className} title={en}>
        {th}
      </span>
    );
  // 0.8em of the label, floored at the 12px micro size: inside a text-xs parent (13px) or a small
  // button (0.8rem) a bare 0.8em rendered 10.2-10.4px. Wherever the parent is large enough, the
  // floor is inert and the English half is exactly 0.8em as before.
  return (
    <span className={className}>
      {th}
      <span className="ml-1 text-[length:max(0.8em,12px)] font-normal">{en}</span>
    </span>
  );
}
