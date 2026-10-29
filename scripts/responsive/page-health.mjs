// Errors a rendered page must not have: an uncaught exception, a console error, a failed request or
// an HTTP status >= 400. `ours(url)` names the URLs the harness serves. Every other request is one the
// harness aborts on purpose (CDN, backend), so its failure, and the console line Chromium logs for it,
// belong to the harness and not to the page.
export function watchPageHealth(page, ours) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`PAGEERROR ${String(e.message).split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const at = m.location()?.url ?? '';
    if (m.text().startsWith('Failed to load resource') && at && !ours(at)) return;
    problems.push(`CONSOLE   ${m.text().split('\n')[0].slice(0, 200)}${at ? ` (${at})` : ''}`);
  });
  page.on('requestfailed', (r) => {
    if (ours(r.url())) problems.push(`REQFAILED ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}  ${r.url()}`);
  });
  return problems;
}

// The theme the page resolved, read from the attribute the Portal's pre-paint snippet sets.
export function resolvedTheme(page) {
  return page.evaluate(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));
}
