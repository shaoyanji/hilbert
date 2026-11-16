// Encoder/decoder round trip with no browser in the loop: proves the wire format
// and the transform are correct before any timing claim is made. Prints the
// bytes-vs-quality curve per level, which is the number H1 is judged on.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodePNG } from '../lib/png.js';
import { encode } from '../lib/codec.js';
import { Decoder, upscale } from '../lib/decode.js';
import { levelCount, levelDims } from '../lib/geometry.js';
import { ssim, psnr } from '../lib/ssim.js';

const root = new URL('..', import.meta.url).pathname;
const name = process.argv[2] ?? 'panorama.png';
const quality = Number(process.argv[3] ?? 75);

const png = decodePNG(fs.readFileSync(`${root}out/${name}`));
const { width, height, data } = png;
console.log(`image ${name} ${width}x${height} quality ${quality}`);

const t0 = Date.now();
const enc = encode(data, width, height, { quality });
const encMs = Date.now() - t0;
const m = enc.manifest;
console.log(`encoded in ${encMs} ms: ${m.levels} levels, ${enc.chunks.length} chunks, ${(m.totalBytes / 1024).toFixed(1)} KiB, ${(m.totalBytes * 8 / 1e6).toFixed(2)} Mbit`);
for (const l of m.levelBytes) {
  console.log(`  level ${l.level}  ${String(l.w).padStart(5)}x${String(l.h).padEnd(5)} tiles=${String(l.tiles).padStart(4)}  ${(l.bytes / 1024).toFixed(1).padStart(9)} KiB`);
}

// reference pyramid for per-level comparison
const refs = [data];
{
  let cur = data, w = width, h = height;
  for (let k = 1; k < m.levels; k++) {
    const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) { const sy = y * 2 + dy; if (sy >= h) break;
        for (let dx = 0; dx < 2; dx++) { const sx = x * 2 + dx; if (sx >= w) break;
          const o = (sy * w + sx) * 4; r += cur[o]; g += cur[o + 1]; b += cur[o + 2]; n++; } }
      const o = (y * nw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
    refs.push(out); cur = out; w = nw; h = nh;
  }
}

const dec = new Decoder(m, { inflate: async (b) => zlib.inflateSync(b) });
let cum = 0;
const rows = [];
for (let L = 0; L < m.levels; L++) {
  const tiles = enc.chunks.filter((c) => c.L === L);
  for (const c of tiles) {
    const buf = enc.stream.subarray(c.o, c.o + c.l);
    await dec.applyChunk(buf);
    cum += buf.length;
  }
  const st = dec.level(L);
  const rgba = dec.levelRGBA(L);
  const ref = refs[m.levels - 1 - L];
  const q = ssim(rgba, ref, st.w, st.h);
  rows.push({ L, cum, pct: (100 * cum) / m.totalBytes, w: st.w, h: st.h, ssim: q });
  console.log(`after level ${L}: ${(cum / 1024).toFixed(1).padStart(9)} KiB (${((100 * cum) / m.totalBytes).toFixed(1)}%)  ${st.w}x${st.h}  SSIM ${q.toFixed(4)}`);
}

// full-resolution check, decoded from the finest level only
const fine = dec.level(m.levels - 1);
const fineRGBA = dec.levelRGBA(m.levels - 1);
console.log(`finest level ${fine.w}x${fine.h} SSIM ${ssim(fineRGBA, data, width, height).toFixed(4)}  PSNR ${psnr(fineRGBA, data, width, height).toFixed(2)} dB`);

// what the client shows before the finest level: upscaled mid level
const mid = Math.max(0, m.levels - 2);
const midSt = dec.level(mid);
const up = upscale(dec.levelRGBA(mid), midSt.w, midSt.h, width, height);
console.log(`upscaled level ${mid} -> full res SSIM ${ssim(up, data, width, height).toFixed(4)} (${((100 * rows[mid].cum) / m.totalBytes).toFixed(1)}% of bytes)`);

const firstAcceptable = rows.find((r) => r.ssim >= 0.9);
console.log(firstAcceptable
  ? `SSIM>=0.90 at ${firstAcceptable.pct.toFixed(1)}% of the stream (${(firstAcceptable.cum / 1024).toFixed(1)} KiB, ${firstAcceptable.w}x${firstAcceptable.h})`
  : 'SSIM never reached 0.90 at native level resolution');

fs.writeFileSync(`${root}out/selftest-${name.replace('.png', '')}.json`,
  JSON.stringify({ name, width, height, quality, encMs, totalBytes: m.totalBytes, levels: rows, manifest: { levels: m.levels, groupSize: m.groupSize } }, null, 2));
console.log('ok');
