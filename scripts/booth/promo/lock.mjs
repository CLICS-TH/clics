#!/usr/bin/env node
// Ties the shipped promo.mp4 to the sources it was rendered from (#216). render.sh writes promo.lock.json after
// a render; the booth harness (scenarios/promo.mjs) recomputes both digests and fails when either moved, so an
// edited scene, stub or case step without a re-render, or a hand-swapped MP4, cannot ship unnoticed.
// The booth page enters through capture-files.json, every file the capture served it; the case through the parts
// the video shows: the vignette, step 1 and the placeholder badge (SPEC.md).
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const CASE = fileURLToPath(new URL('../../../backend/src/booth-cases/NFCME-2026.json', import.meta.url));
export const PROMO = join(PUBLIC, 'booth-loop', 'promo.mp4');
export const LOCK = join(HERE, 'promo.lock.json');
export const SERVED = join(HERE, 'capture-files.json');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * One digest over every input of the render, each file named, so a renamed input also moves it.
 * `read` lets the harness prove a file is covered: change its bytes and the digest must move.
 */
export async function sourcesDigest({ read = readFile } = {}) {
  const scenes = (await readdir(join(HERE, 'compositions'))).filter((f) => f.endsWith('.html')).sort();
  const files = [
    ...['index.html', 'hyperframes.json', 'capture.mjs', 'stub.mjs', 'render.sh', 'capture-files.json'].map((f) => join(HERE, f)),
    ...JSON.parse(await read(SERVED, 'utf8').catch(() => '[]')).map((f) => join(REPO, f)),
    ...scenes.map((f) => join(HERE, 'compositions', f)),
    ...['ple-chat-desktop-light', 'pis7-radar-mobile-light', 'ple-result-mobile-light'].map((f) => join(PUBLIC, 'img', 'landing', `${f}.webp`)),
    join(PUBLIC, 'favicon.svg'),
    ...['inter-latin-wght-normal', 'noto-sans-thai-thai-wght-normal', 'cormorant-garamond-latin-wght-normal'].map((f) => join(PUBLIC, 'fonts', `${f}.woff2`)),
  ];
  const hash = createHash('sha256');
  for (const f of [...new Set(files)]) hash.update(`${relative(REPO, f)}\0${sha(await read(f))}\n`);
  const kase = JSON.parse(await read(CASE, 'utf8'));
  hash.update(`case\0${sha(JSON.stringify({ vignette: kase.vignette, step1: kase.steps[0], placeholder: kase.placeholder ?? false }))}\n`);
  return hash.digest('hex');
}

export const promoDigest = async () => sha(await readFile(PROMO));

if (process.argv[2] === '--write') {
  const lock = { sources: await sourcesDigest(), promo: await promoDigest() };
  await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`wrote ${LOCK}`);
}
