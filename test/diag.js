// Diagnostic. Three questions, in the order that removes the most doubt:
//   1. does the 8x8 transform round-trip on its own?
//   2. does a 2-colour 128x128 image survive the codec at q100?
//   3. if not, is it luma, chroma, or placement?
// Writes the source and the reconstruction next to each other so the failure is
// visible rather than inferred from a number.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fdct, idct } from '../lib/dct.js';
import { encode, planesFrom } from '../lib/codec.js';
import { Decoder } from '../lib/decode.js';
import { encodePNG } from '../lib/png.js';
import { ssim, psnr } from '../lib/ssim.js';

const outDir = process.argv[2] ?? path.resolve(new URL('..', import.meta.url).pathname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// ---- 1. transform round trip -------------------------------------------------
{
  const rand = (() => { let s = 1; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 254 - 127; })();
  const src = new Float64Array(64);
  for (let i = 0; i < 64; i++) src[i] = rand();
  const coef = new Float64Array(64);
  const back = new Float64Array(64);
  fdct(src, coef);
  idct(coef, back);
  let maxErr = 0;
  for (let i = 0; i < 64; i++) maxErr = Math.max(maxErr, Math.abs(src[i] - back[i]));
  console.log(`dct round trip max error: ${maxErr.toExponential(2)}`);
}

// ---- 2/3. codec round trip on a known image ---------------------------------
const W = 128, H = 128;
const px = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const left = x < W / 2;
    const top = y < H / 2;
    // four known colours, so a channel swap or a plane mix-up is obvious
    if (left && top) { px[o] = 255; px[o + 1] = 0; px[o + 2] = 0; }
    else if (!left && top) { px[o] = 0; px[o + 1] = 255; px[o + 2] = 0; }
    else if (left && !top) { px[o] = 0; px[o + 1] = 0; px[o + 2] = 255; }
    else { px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; }
    px[o + 3] = 255;
  }
}

const enc = encode(px, W, H, { quality: 100, baseWidth: 16, groupSize: 32 });
console.log(`levels=${enc.manifest.levels} chunks=${enc.chunks.length} bytes=${enc.manifest.totalBytes}`);
for (const l of enc.manifest.levelBytes) console.log(`  level ${l.level} ${l.w}x${l.h} tiles=${l.tiles} bytes=${l.bytes}`);

const dec = new Decoder(enc.manifest, { inflate: async (b) => zlib.inflateSync(b) });
for (const c of enc.chunks) await dec.applyChunk(enc.stream.subarray(c.o, c.o + c.l));
const L = enc.manifest.levels - 1;
const out = dec.levelRGBA(L);
const st = dec.level(L);

console.log(`\nssim ${ssim(out, px, W, H).toFixed(4)}  psnr ${psnr(out, px, W, H).toFixed(2)} dB`);
for (const [x, y] of [[10, 10], [100, 10], [10, 100], [100, 100], [0, 0]]) {
  const o = (y * W + x) * 4;
  console.log(`rgb(${x},${y}) src=${px[o]},${px[o + 1]},${px[o + 2]}  got=${out[o]},${out[o + 1]},${out[o + 2]}`);
}

const planes = planesFrom(px, W, H);
for (const [x, y] of [[10, 10], [100, 10], [10, 100], [100, 100]]) {
  const i = y * st.w + x;
  const ci = (y >> 1) * st.cw + (x >> 1);
  console.log(`plane(${x},${y}) enc y=${planes.y[i].toFixed(1)} cb=${planes.cb[ci].toFixed(1)} cr=${planes.cr[ci].toFixed(1)}` +
    `  |  dec y=${(st.y[i] - 128).toFixed(1)} cb=${st.cb[ci].toFixed(1)} cr=${st.cr[ci].toFixed(1)}`);
}

fs.writeFileSync(path.join(outDir, 'diag-src.png'), encodePNG(px, W, H));
fs.writeFileSync(path.join(outDir, 'diag-recon.png'), encodePNG(out, W, H));
console.log(`\nwrote ${outDir}/diag-src.png and diag-recon.png`);
