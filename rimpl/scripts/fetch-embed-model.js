#!/usr/bin/env node
// Downloads the booth reply cache's embedding model (#387) at its pinned revision into the model folder
// (BOOTH_EMBED_MODEL_DIR, default rimpl/models), checks each file against its pinned sha256, then loads it offline
// once and embeds a sentence to prove it. The ONE place rimpl fetches a model: at run time remote models are off.
//
//   node scripts/fetch-embed-model.js
//
// Exits 1 when a file cannot be fetched or does not match its pin, or the offline load fails.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MODEL, REVISION, MODEL_ID, REVISION_FILE, modelDir, embed } = require('../src/services/embed');

// The two large files' pins are the LFS sha256 Hugging Face lists for this revision; the two small ones were read
// from it on 2026-11-10.
const FILES = {
  'config.json': '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7',
  'tokenizer.json': 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
  'tokenizer_config.json': '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
  'onnx/model_quantized.onnx': '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchFile(name, into) {
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${name}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (FILES[name] !== got) throw new Error(`${name}: sha256 ${got} is not the pinned ${FILES[name]}`);
  const file = path.join(into, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, buf);
  fs.renameSync(`${file}.part`, file);
  console.log(`  ${name}  ${buf.length} bytes  sha256 ${got}`);
}

async function main() {
  const into = path.join(modelDir(), MODEL);
  console.log(`fetching ${MODEL} @ ${REVISION} into ${into}`);
  for (const name of Object.keys(FILES)) await fetchFile(name, into);
  fs.writeFileSync(path.join(into, REVISION_FILE), `${REVISION}\n`);
  const v = await embed('ให้ doxycycline 100 mg วันละสองครั้ง');
  if (!v) throw new Error('the offline load failed');
  console.log(`loaded ${MODEL_ID} offline: ${v.length} dimensions`);
}

main().catch((err) => {
  console.error(`fetch-embed-model: ${err.message}`);
  process.exit(1);
});
