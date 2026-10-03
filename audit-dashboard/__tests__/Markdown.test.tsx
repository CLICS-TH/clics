// Markdown renders text an AI wrote. These run the REAL react-markdown (no mock) because the three rules
// are about what it actually emits: images are never rendered, headings never outrank h3, and tables
// and code scroll inside a labelled, focusable region. Link behaviour must not have changed.
import { render } from '@testing-library/react';
import { Markdown } from '@/components/Markdown';

const html = (md: string) => render(<Markdown>{md}</Markdown>).container;

describe('images', () => {
  it('a markdown image is never rendered or fetched — no <img>, no preload, no URL anywhere', () => {
    const c = html('before\n\n![x](https://evil.example/pixel.png)\n\nafter');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('before');
    expect(c.textContent).toContain('after');
    expect(c.innerHTML).not.toContain('evil.example');
    expect(document.head.innerHTML).not.toContain('evil.example');   // React 19 hoists <img> preloads here
  });

  it('keeps the image ALT text as plain text, so the words are not silently lost', () => {
    const c = html('ดู ![แผนภาพการไหลเวียน](https://evil.example/p.png) ประกอบ');
    const alt = c.querySelector('[data-md-img-alt]')!;
    expect(alt.tagName).toBe('SPAN');
    expect(alt.textContent).toBe('แผนภาพการไหลเวียน');
    expect(c.textContent).toContain('ดู แผนภาพการไหลเวียน ประกอบ');
    expect(c.querySelector('img')).toBeNull();
  });

  it('an image with no alt leaves nothing behind', () => {
    const c = html('![](https://evil.example/p.png)');
    expect(c.querySelector('[data-md-img-alt], img')).toBeNull();
    expect(c.innerHTML).not.toContain('evil.example');
  });

  it('raw HTML <img> is shown as inert text, not rendered', () => {
    const c = html('<img src="https://evil.example/y.png">');
    expect(c.querySelector('img')).toBeNull();
  });
});

describe('heading levels', () => {
  it('shifts so the highest level inside a reply is h3', () => {
    const c = html('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    expect(c.querySelector('h1, h2')).toBeNull();
    expect([...c.querySelectorAll('h3,h4,h5,h6')].map((h) => [h.tagName, h.textContent])).toEqual([
      ['H3', 'a'], ['H4', 'b'], ['H5', 'c'], ['H6', 'd'], ['H6', 'e'], ['H6', 'f'],
    ]);
  });

  it('headings keep the sans, semibold styling and carry no stray node attribute', () => {
    const h = html('# ชื่อเรื่อง').querySelector('h3')!;
    expect(h).toHaveClass('font-sans', 'font-semibold');
    expect(h).not.toHaveAttribute('node');
  });
});

describe('scroll groups', () => {
  it('a table sits in a focusable, labelled group (not a landmark region)', () => {
    const c = html('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(c.querySelector('[role="region"]')).toBeNull();
    const region = c.querySelector('[role="group"]') as HTMLElement;
    expect(region).not.toBeNull();
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe('ตาราง / Table');
    expect(region).toHaveClass('overflow-x-auto');
    expect(region.querySelector('table')).not.toBeNull();
    expect(region.querySelector('table')).not.toHaveAttribute('node');
    expect(c.querySelectorAll('th')).toHaveLength(2);
  });

  it('a code block is a focusable, labelled group', () => {
    const pre = html('```\nconst a = 1;\n```').querySelector('pre') as HTMLElement;
    expect(pre.getAttribute('role')).toBe('group');
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.getAttribute('aria-label')).toBe('โค้ด / Code');
    expect(pre).not.toHaveAttribute('node');
    expect(pre.textContent).toContain('const a = 1;');
  });

  it('inline code is not turned into a scroll group', () => {
    expect(html('use `x` here').querySelector('[role="group"]')).toBeNull();
  });
});

describe('links are unchanged', () => {
  it('still a plain anchor with its href, no added target or rel', () => {
    const a = html('[guideline](https://example.org/g)').querySelector('a')!;
    expect(a).toHaveAttribute('href', 'https://example.org/g');
    expect(a).not.toHaveAttribute('target');
    expect(a).not.toHaveAttribute('rel');
  });

  it('ordinary markdown still renders (bold, lists)', () => {
    const c = html('**b**\n\n- one\n- two');
    expect(c.querySelector('strong')?.textContent).toBe('b');
    expect(c.querySelectorAll('li')).toHaveLength(2);
  });
});
