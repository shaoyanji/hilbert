// Local, decisive: for the same pixels, print what the encoder held, what the
// decoder holds, what levelToRGBA produced, and what an independent conversion
// from the decoder's own planes gives. Whichever column diverges is the bug.

import zlib from 'node:zlib';
import { encode, planesFrom } from '../lib/codec.js';
import { Decoder } from '../lib/decode.js';
import { tilesAt } from '../lib/geometry.js';

const W = 128, H = 128;
const px = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (x < 64 && y < 64) px[o] = 255;
    else if (x >= 64 && y < 64) px[o + 1] = 255;
    else if (x < 64) px[o + 2] = 255;
    else { px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; }
    px[o + 3] = 255;
  }
}

const enc = encode(px, W, H, { quality: 100, baseWidth: 16, groupSize: 32 });
const m = enc.manifest;
const L = m.levels - 1;
const dec = new Decoder(m, { inflate: async (b) => zlib.inflateSync(b) });
for (const c of enc.chunks) await dec.applyChunk(enc.stream.subarray(c.o, c.o + c.l));

const st = dec.level(L);
const planes = planesFrom(px, W, H);
const out = dec.levelRGBA(L);

console.log(`level ${L}: ${st.w}x${st.h} cw=${st.cw} ch=${st.ch}`);
console.log('pixel   enc(Y,Cb,Cr)            dec(Y,Cb,Cr)            src rgb        levelToRGBA    independent');
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
for (const [x, y] of [[10, 10], [100, 10], [10, 100], [100, 100]]) {
  const i = y * st.w + x;
  const ci = (y >> 1) * st.cw + (x >> 1);
  const e = `${planes.y[i].toFixed(1)},${planes.cb[ci].toFixed(1)},${planes.cr[ci].toFixed(1)}`;
  const d = `${st.y[i].toFixed(1)},${st.cb[ci].toFixed(1)},${st.cr[ci].toFixed(1)}`;
  const o = (y * W + x) * 4;
  const Y = st.y[i], Cb = st.cb[ci], Cr = st.cr[ci];
  const ind = `${clamp(Y + 1.402 * Cr + 128)},${clamp(Y - 0.344136 * Cb - 0.714136 * Cr + 128)},${clamp(Y + 1.772 * Cb + 128)}`;
  console.log(`(${x},${y})`.padEnd(10) + e.padEnd(24) + d.padEnd(24) +
    `${px[o]},${px[o + 1]},${px[o + 2]}`.padEnd(15) + `${out[o]},${out[o + 1]},${out[o + 2]}`.padEnd(15) + ind);
}

// Where does the chroma actually land? Find, for the red quadrant, the decoder
// chroma value nearest the encoder's and report its coordinates.
const target = { cb: planes.cb[0], cr: planes.cr[0] };
let best = { d: Infinity, x: 0, y: 0 };
for (let y = 0; y < st.ch; y++) {
  for (let x = 0; x < st.cw; x++) {
    const i = y * st.cw + x;
    const d = Math.abs(st.cb[i] - target.cb) + Math.abs(st.cr[i] - target.cr);
    if (d < best.d) best = { d, x, y };
  }
}
console.log(`\nchroma search: enc(0,0) cb=${target.cb.toFixed(1)} cr=${target.cr.toFixed(1)} nearest decoder chroma at (${best.x},${best.y}) d=${best.d.toFixed(2)} cb=${st.cb[best.y * st.cw + best.x].toFixed(1)} cr=${st.cr[best.y * st.cw + best.x].toFixed(1)}`);
console.log(`tiles at level ${L}: ${tilesAt(W, H, m.levels, L, m.groupSize).length}, group ${m.groupSize}, sample tile ${JSON.stringify(tilesAt(W, H, m.levels, L, m.groupSize)[1])}`);
