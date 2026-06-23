// Bilingual label hierarchy (#12a): Thai primary, English smaller + dimmed — replaces the
// equal-weight "Thai / English" slash that doubled on-screen text and flattened hierarchy.
// In dense tables, pass `tooltip` to keep Thai-only with the English on hover.
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
  return (
    <span className={className}>
      {th}
      <span className="ml-1 text-[0.8em] font-normal opacity-[0.85]">{en}</span>
    </span>
  );
}
