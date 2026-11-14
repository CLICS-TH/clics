// The dashboard is served under /audit (next.config.ts basePath). next/link and the router add the base path;
// a plain <a href="/x">, <img src="/x"> or window.location = '/x' does not, and on the shared origin lands on a
// Portal path instead (a 404, or the Portal's sign-in). Internal links go through next/link, images through
// withBasePath, and full-page navigations to the Portal through lib/portal.ts.
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { BASE_PATH, stripBasePath, withBasePath } from '@/lib/base-path';

const ROOT = path.join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(tsx?|jsx?)$/.test(n) ? [p] : [];
  });
}

const RULES: [string, RegExp][] = [
  ['an <a> with a root-relative href (use next/link)', /<a\b[^>]*?\bhref=(?:"\/(?!\/)|'\/(?!\/)|\{\s*[`'"]\/(?!\/))/],
  ['an <img> whose src skips withBasePath', /<img\b[^>]*?\bsrc=(?:"\/(?!\/)|\{(?!\s*withBasePath\())/],
  ['a full-page navigation to a root-relative path (use PORTAL or the router)',
    /(?:location\.(?:href\s*=|replace\(|assign\()|location\s*=)\s*[`'"]\/(?!\/)/],
];

it.each(['app', 'components', 'lib'])('%s/ has no navigation or asset path that bypasses the base path', (dir) => {
  const hits: string[] = [];
  for (const file of sources(path.join(ROOT, dir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [what, re] of RULES) if (re.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1} ${what}`);
    });
  }
  expect(hits).toEqual([]);
});

it('the guard catches each way of bypassing the base path', () => {
  const bad = [
    '<a href="/admin/ples">', '<a key={x} href={`/admin/ples/${id}`}>', "<img src=\"/img/a.png\" />",
    '<img src={b.src} />', "window.location.href = '/login';", "window.location.replace('/login')",
  ];
  for (const line of bad) expect(RULES.some(([, re]) => re.test(line))).toBe(true);
  const good = ['<Link href="/admin/ples">', '<a href={PORTAL.login}>', '<img src={withBasePath(b.src)} />',
    '<a href="https://console.anthropic.com">', '<a href={`#${s.id}`}>', 'window.location.replace(PORTAL.login)'];
  for (const line of good) expect(RULES.some(([, re]) => re.test(line))).toBe(false);
});

it('next.config.ts serves the dashboard under BASE_PATH, as a standalone server', () => {
  const cfg = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
  expect(BASE_PATH).toBe('/audit');
  expect(cfg).toMatch(/basePath: BASE_PATH,/);
  expect(cfg).toMatch(/output: 'standalone',/);
});

it('withBasePath and stripBasePath are inverse on root-relative paths only', () => {
  expect(withBasePath('/img/manual/a.png')).toBe('/audit/img/manual/a.png');
  expect(withBasePath('https://x.test/a.png')).toBe('https://x.test/a.png');
  expect(withBasePath('//cdn.test/a.png')).toBe('//cdn.test/a.png');
  expect(stripBasePath('/audit/admin/ples')).toBe('/admin/ples');
  expect(stripBasePath('/audit')).toBe('/');
  expect(stripBasePath('/auditor/queue')).toBe('/auditor/queue');
});
