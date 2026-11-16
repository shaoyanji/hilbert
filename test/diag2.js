// Second diagnostic: does the decoder consume exactly what the encoder wrote, on
// each of the three passes? A pass that starves means an encoder/decoder
// disagreement about block counts; a pass that overruns means the framing is
// wrong. Prints both sides for the same tile.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { encode, planesFrom, encodePlaneBlocks } from '../lib/codec.js';
import { Decoder } from '../lib/decode.js';
import { quantTable, Q_LUMA, Q_CHROMA } from '../lib/dct.js';
import { tilesAt, levelDims } from '../lib/geometry.js';
import { encodePNG } from '../lib/png.js';
import { ssim, psnr } from '../lib/ssim.js';
import { HEADER_BYTES } from '../lib/wire.js';

const W = 128, H = 128;
const px = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (x < 64 && y < 64) { px[o] = 255; }
    else if (x >= 64 && y < 64) { px[o + 1] = 255; }
    else if (x < 64) { px[o + 2] = 255; }
    else { px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; }
    px[o + 3] = 255;
  }
}

const Q = 100;
const enc = encode(px, W, H, { quality: Q, baseWidth: 16, groupSize: 32 });
const m = enc.manifest;
const L = m.levels - 1;
const d = levelDims(W, H, m.levels, L);
const tiles = tilesAt(W, H, m.levels, L, m.groupSize);
const planes = planesFrom(px, d.w, d.h);
const qY = quantTable(Q_LUMA, Q);
const qC = quantTable(Q_CHROMA, Q);

console.log(`level ${L} ${d.w}x${d.h} cw=${d.cw} ch=${d.ch} tiles=${tiles.length} group=${m.groupSize}`);
console.log(`manifest levels=${m.levels} groupSize=${m.groupSize}\n`);

for (const t of tiles.slice(0, 3)) {
  const a = [], b = [], c = [];
  encodePlaneBlocks(a, planes.y, d.w, d.h, { x: t.x, y: t.y, w: t.w, h: t.h }, qY);
  encodePlaneBlocks(b, planes.cb, d.cw, d.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, qC);
  encodePlaneBlocks(c, planes.cr, d.cw, d.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, qC);
  const chunk = enc.chunks.find((ch) => ch.L === L && ch.t === t.index);
  const rawLen = enc.stream.readUInt32LE(chunk.o + 26);
  const payloadLen = enc.stream.readUInt32LE(chunk.o + 22);
  const buf = enc.stream.subarray(chunk.o, chunk.o + chunk.l);
  const raw = zlib.inflateSync(buf.subarray(HEADER_BYTES, HEADER_BYTES + payloadLen));
  const nbY = Math.ceil(t.w / 8) * Math.ceil(t.h / 8);
  const nbC = Math.ceil(t.cw / 8) * Math.ceil(t.ch / 8);
  console.log(`tile ${t.index} (${t.x},${t.y}) ${t.w}x${t.h} chroma ${t.cw}x${t.ch} blocks y=${nbY} c=${nbC}`);
  console.log(`  enc bytes  y=${a.length} cb=${b.length} cr=${c.length} sum=${a.length + b.length + c.length}  hdr rawLen=${rawLen} inflated=${raw.length}`);

  const dec = new Decoder(m, { inflate: async (x) => zlib.inflateSync(x) });
  const passes = [];
  dec.onPass = (name, pos) => passes.push(`${name}:${pos}`);
  await dec.applyChunk(buf);
  console.log(`  dec passes ${passes.join(' ')}  raw=${raw.length}`);
}

// full reconstruction, written out so the failure is visible
const dec = new Decoder(m, { inflate: async (x) => zlib.inflateSync(x) });
for (const c of enc.chunks) await dec.applyChunk(enc.stream.subarray(c.o, c.o + c.l));
const out = dec.levelRGBA(L);
console.log(`\nfull: ssim ${ssim(out, px, W, H).toFixed(4)} psnr ${psnr(out, px, W, H).toFixed(2)} dB`);
for (const [x, y] of [[10, 10], [100, 10], [10, 100], [100, 100]]) {
  const o = (y * W + x) * 4;
  console.log(`rgb(${x},${y}) src=${px[o]},${px[o + 1]},${px[o + 2]} got=${out[o]},${out[o + 1]},${out[o + 2]}`);
}

const outDir = process.argv[2] ?? path.resolve(new URL('..', import.meta.url).pathname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'diag2-src.png'), encodePNG(px, W, H));
fs.writeFileSync(path.join(outDir, 'diag2-recon.png'), encodePNG(out, W, H));
console.log(`wrote ${outDir}/diag2-recon.png`);
