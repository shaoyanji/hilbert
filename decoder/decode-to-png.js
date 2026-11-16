// Decoder CLI. Stream in, PNG out, optionally from a byte prefix — the same
// operation the browser's streaming client performs, without a browser.
//
//   node decoder/decode-to-png.js out/panorama.hs [prefixBytes]
//
// With a prefix it decodes only the chunks that fit, which is how the
// bytes-to-quality curve is reproduced outside the harness.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Decoder, upscale } from '../lib/decode.js';
import { decodePNG, encodePNG } from '../lib/png.js';
import { ssim, psnr } from '../lib/ssim.js';
import { HEADER_BYTES } from '../lib/wire.js';

const src = process.argv[2];
if (!src) {
  console.error('usage: node decoder/decode-to-png.js <input.hs> [prefixBytes]');
  process.exit(2);
}
const manifestPath = src.replace(/\.hs$/, '.manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const stream = fs.readFileSync(src);
const budget = Number(process.argv[3] ?? stream.length);

const dec = new Decoder(manifest, { inflate: async (b) => zlib.inflateSync(b) });
const t0 = Date.now();
let off = 0;
let applied = 0;
while (off + HEADER_BYTES <= stream.length && off < budget) {
  const payloadLen = stream.readUInt32LE(off + 22);
  const frame = HEADER_BYTES + payloadLen;
  if (off + frame > Math.min(budget, stream.length)) break;
  await dec.applyChunk(stream.subarray(off, off + frame));
  off += frame;
  applied++;
}
const decodeMs = Date.now() - t0;

let level = manifest.levels - 1;
while (level > 0 && dec.level(level).received === 0) level--;
const st = dec.level(level);
const rgba = dec.levelRGBA(level);
const outPath = src.replace(/\.hs$/, `-level${level}.png`);
fs.writeFileSync(outPath, encodePNG(rgba, st.w, st.h));

console.log(`decoded ${applied}/${manifest.index.length} chunks, ${(off / 1024).toFixed(1)} KiB of ${(stream.length / 1024).toFixed(1)} KiB in ${decodeMs} ms`);
console.log(`highest level with data: ${level} (${st.w}x${st.h}), wrote ${outPath}`);

const refPath = path.join(path.dirname(src), `${path.basename(src, '.hs')}.png`);
if (fs.existsSync(refPath)) {
  const ref = decodePNG(fs.readFileSync(refPath));
  const cmp = level === manifest.levels - 1 ? rgba : upscale(rgba, st.w, st.h, ref.width, ref.height);
  console.log(`vs ${path.basename(refPath)}: SSIM ${ssim(cmp, ref.data, ref.width, ref.height).toFixed(4)} PSNR ${psnr(cmp, ref.data, ref.width, ref.height).toFixed(2)} dB`);
}
