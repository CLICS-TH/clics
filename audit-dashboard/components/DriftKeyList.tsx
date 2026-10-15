// Live-drift keys from the model manifest, by NAME — never their values (rimpl already hashes free-text
// values on the public block; which settings differ is the finding). One style for the Model Lock page
// and AI readiness, so an evaluator-scope key looks the same wherever it is listed.
export function DriftKeyList({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {keys.map((k) => (
        <li key={k} className="max-w-full rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">{k}</li>
      ))}
    </ul>
  );
}
