// Encoder CLI. PNG in, `.hs` stream + manifest out. The work is in lib/codec.js;
// this exists so the format can be produced without starting a server.
//
//   node encoder/encode.js out/panorama.png [quality] [groupSize]

import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../lib/png.js';
import { encode } from '../lib/codec.js';

const src = process.argv[2];
if (!src) {
  console.error('usage: node encoder/encode.js <input.png> [quality] [groupSize]');
  process.exit(2);
}
const quality = Number(process.argv[3] ?? 75);
const groupSize = Number(process.argv[4] ?? 128);

const png = decodePNG(fs.readFileSync(src));
const t0 = Date.now();
const { stream, manifest } = encode(png.data, png.width, png.height, { quality, groupSize });
const ms = Date.now() - t0;

const base = path.join(path.dirname(src), path.basename(src, '.png'));
fs.writeFileSync(`${base}.hs`, stream);
fs.writeFileSync(`${base}.manifest.json`, JSON.stringify(manifest));

console.log(`${src} ${png.width}x${png.height} q${quality} group ${groupSize}`);
console.log(`  ${manifest.levels} levels, ${manifest.index.length} chunks, ${(manifest.totalBytes / 1024).toFixed(1)} KiB in ${ms} ms`);
for (const l of manifest.levelBytes) {
  console.log(`  level ${l.level} ${String(l.w).padStart(5)}x${String(l.h).padEnd(5)} ${String(l.tiles).padStart(4)} tiles ${(l.bytes / 1024).toFixed(1).padStart(9)} KiB`);
}
console.log(`  wrote ${base}.hs and ${base}.manifest.json`);
