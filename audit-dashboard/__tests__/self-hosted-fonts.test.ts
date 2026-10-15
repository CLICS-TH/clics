/** @jest-environment node */
// The dashboard's webfonts are committed under app/fonts/ and loaded with next/font/local, so the
// build needs no network. app/fonts/README.md records where each file came from and its sha256.
// This keeps the three in step: a file swapped without updating its provenance, a layout.tsx
// pointing at a file that is not there, or a Google font loader coming back all fail here rather
// than in a Vercel build that can only fail on the day Google is unreachable.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const ROOT = path.join(__dirname, '..');
const FONTS = path.join(ROOT, 'app', 'fonts');
const layout = fs.readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8');
const readme = fs.readFileSync(path.join(FONTS, 'README.md'), 'utf8');

// | `file.woff2` | Family | `pkg@ver` | `files/...` | bytes | `sha256` |
const rows = [...readme.matchAll(/^\| `([^`]+\.woff2)` \| ([^|]+?) \| `(@fontsource[^`]+@\d+\.\d+\.\d+)` \| `[^`]+` \| (\d+) \| `([0-9a-f]{64})` \|$/gm)]
  .map(([, file, family, pkg, bytes, sha]) => ({ file, family, pkg, bytes: Number(bytes), sha }));
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(FONTS, file))).digest('hex');
const referenced = [...new Set([...layout.matchAll(/"\.\/fonts\/([^"]+)"/g)].map((m) => m[1]))];
const onDisk = fs.readdirSync(FONTS).filter((f) => f.endsWith('.woff2'));

describe('self-hosted fonts', () => {
  it('loads every font through next/font/local, none through next/font/google', () => {
    expect(layout).not.toMatch(/from ["']next\/font\/google["']/);
    expect(layout).toMatch(/from "next\/font\/local"/);
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('records a provenance row for every font file, and only for files that exist', () => {
    expect(rows.map((r) => r.file).sort()).toEqual([...onDisk].sort());
    for (const f of referenced) expect(onDisk).toContain(f);
  });

  it.each(rows.map((r) => [r.file, r] as const))('%s matches its recorded sha256 and size', (file, row) => {
    expect(sha256(file)).toBe(row.sha);
    expect(fs.statSync(path.join(FONTS, file)).size).toBe(row.bytes);
    // woff2 magic: a renamed .ttf or an HTML error page saved as .woff2 would still hash
    expect(fs.readFileSync(path.join(FONTS, file)).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  it('pins every package to an exact version', () => {
    for (const r of rows) expect(r.pkg).toMatch(/^@fontsource(-variable)?\/[a-z-]+@\d+\.\d+\.\d+$/);
  });

  it('ships the OFL text for every family', () => {
    for (const family of new Set(rows.map((r) => r.family))) {
      const licence = path.join(FONTS, `OFL-${family.replace(/\s+/g, '')}.txt`);
      expect(fs.existsSync(licence)).toBe(true);
      expect(fs.readFileSync(licence, 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
    }
  });

  // Repo-wide, not just layout.tsx: one `import { Inter } from "next/font/google"` in any other
  // layout or component brings the build-time Google fetch straight back. The loader check matches
  // the module name as a string literal, so a static import, `import()` and `require()` all trip it.
  it('has no Google font loader, stylesheet or link anywhere in the dashboard source or config', () => {
    const SCANNED = /\.(c|m)?[jt]sx?$|\.(css|html|json|mdx)$/;
    const GOOGLE_LOADER = /["'`](?:@next\/|next\/)font\/google["'`]/;
    const GOOGLE_HOST = /fonts\.(googleapis|gstatic)\.com/;
    const hits: string[] = [];
    const check = (p: string) => {
      const src = fs.readFileSync(p, 'utf8');
      if (GOOGLE_LOADER.test(src)) hits.push(`${path.relative(ROOT, p)}: next/font/google`);
      if (GOOGLE_HOST.test(src)) hits.push(`${path.relative(ROOT, p)}: fonts.googleapis/gstatic`);
    };
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (SCANNED.test(e.name)) check(p);
      }
    };
    for (const d of ['app', 'components', 'lib', 'public']) walk(path.join(ROOT, d));
    // Root config (next.config.ts, postcss/eslint/jest config, components.json, package.json …).
    // Not recursive, so node_modules and .next stay out; the lockfile is all registry URLs.
    const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && SCANNED.test(e.name) && e.name !== 'package-lock.json');
    expect(rootFiles.map((e) => e.name)).toContain('next.config.ts');
    for (const e of rootFiles) check(path.join(ROOT, e.name));
    expect(hits).toEqual([]);
  });
});
