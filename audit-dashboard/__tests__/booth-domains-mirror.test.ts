import fs from 'fs';
import path from 'path';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';

const BOOTH_COPY = path.join(__dirname, '..', '..', 'physician-ui', 'public', 'js', 'booth-copy.js');

function boothDomains(src: string) {
  return [...src.matchAll(/\{ key: '(d\d)', th: '([^']+)', en: '([^']+)' \}/g)].map((m) => ({ key: m[1], th: m[2], en: m[3] }));
}

describe("the booth shows the rubric mirror's domain names", () => {
  const src = fs.readFileSync(BOOTH_COPY, 'utf8');

  it('reads all seven booth domains', () => {
    expect(boothDomains(src).map((d) => d.key)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  });

  it('every Thai and English name matches PIS7_RUBRIC, in order', () => {
    expect(boothDomains(src)).toEqual(PIS7_RUBRIC.map(({ key, th, en }) => ({ key, th, en })));
  });
});
