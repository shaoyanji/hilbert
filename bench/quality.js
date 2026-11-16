// Quality harness. One metric, one reference, every contestant measured the same
// way: decode (or decode-from-prefix, for our own stream), resample to a fixed
// comparison size, SSIM against the source. Baselines are decoded back to PNG by
// bench/codecs.sh, so what is measured is pixels, not an encoder's claim.
//
//   node bench/quality.js [image] [ourQuality]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePNG } from '../lib/png.js';
import { encode } from '../lib/codec.js';
import { Decoder } from '../lib/decode.js';
import { ssim } from '../lib/ssim.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const IMG = process.argv[2] ?? 'panorama';
const OUR_Q = Number(process.argv[3] ?? 75);
const SIZES = [[256, 128], [1024, 512]];

// Box-average down, pixel-replicate up: one function for both directions, which
// is exactly what a browser does when it fits a level canvas to the viewport.
function resize(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  const bw = w / nw, bh = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * bh), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * bh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * bw), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * bw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        if (sy >= h) break;
        for (let sx = x0; sx < x1; sx++) {
          if (sx >= w) break;
          const o = (sy * w + sx) * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = n ? r / n : 0;
      out[o + 1] = n ? g / n : 0;
      out[o + 2] = n ? b / n : 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

const pngPath = path.join(ROOT, 'out', `${IMG}.png`);
if (!fs.existsSync(pngPath)) {
  console.error(`missing out/${IMG}.png — run: node bench/gen.js`);
  process.exit(1);
}
const png = decodePNG(fs.readFileSync(pngPath));
const refs = SIZES.map(([w, h]) => resize(png.data, png.width, png.height, w, h));

function score(rgba, w, h) {
  return SIZES.map(([cw, ch], i) => ssim(resize(rgba, w, h, cw, ch), refs[i], cw, ch));
}

const rows = [];

// ---- our stream, measured as a prefix: this is the whole point of the format --
const t0 = Date.now();
const enc = encode(png.data, png.width, png.height, { quality: OUR_Q });
const encMs = Date.now() - t0;
const dec = new Decoder(enc.manifest, { inflate: async (b) => zlib.inflateSync(b) });
const tDec0 = Date.now();
let cum = 0;
for (let L = 0; L < enc.manifest.levels; L++) {
  for (const c of enc.chunks.filter((ch) => ch.L === L)) {
    await dec.applyChunk(enc.stream.subarray(c.o, c.o + c.l));
    cum += c.l;
  }
  const st = dec.level(L);
  const [s256, s1024] = score(dec.levelRGBA(L), st.w, st.h);
  rows.push({ kind: 'hilbert', label: `our level ${L} (${st.w}x${st.h})`, bytes: cum, ssim256: s256, ssim1024: s1024 });
}

// Decode everything once, timed. This is the number browser timing cannot give
// honestly under `--virtual-time-budget`, and it is the same JS decoder code.
const decodeMs = Date.now() - tDec0;

// ---- baselines already decoded to PNG by bench/codecs.sh ---------------------
const SUFFIX = '-decoded.png';
const EXT = ['.jpg', '.webp', '.jxl', '.avif'];
for (const f of fs.readdirSync(path.join(ROOT, 'out'))) {
  if (!f.startsWith(`${IMG}-q`) || !f.endsWith(SUFFIX)) continue;
  const base = f.slice(0, -SUFFIX.length);
  const encoded = EXT.map((e) => `${base}${e}`).find((e) => fs.existsSync(path.join(ROOT, 'out', e)));
  if (!encoded) continue;
  const bytes = fs.statSync(path.join(ROOT, 'out', encoded)).size;
  const img = decodePNG(fs.readFileSync(path.join(ROOT, 'out', f)));
  const [s256, s1024] = score(img.data, img.width, img.height);
  rows.push({ kind: 'baseline', label: path.basename(encoded), bytes, ssim256: s256, ssim1024: s1024 });
}

rows.sort((a, b) => a.bytes - b.bytes);
const bpp = (bytes) => ((bytes * 8) / (png.width * png.height)).toFixed(3);

console.log(`\n# ${IMG} ${png.width}x${png.height} — ours q${OUR_Q}`);
console.log(`# encode ${encMs} ms · full JS decode ${decodeMs} ms (${(decodeMs / ((png.width * png.height) / 1e6)).toFixed(2)} ms/MP) · ${(enc.manifest.totalBytes / 1024).toFixed(0)} KiB · ${enc.chunks.length} chunks\n`);
console.log('| candidate | bytes | bpp | SSIM@256 | SSIM@1024 |');
console.log('| :--- | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  console.log(`| ${r.label} | ${(r.bytes / 1024).toFixed(1)} KiB | ${bpp(r.bytes)} | ${r.ssim256.toFixed(4)} | ${r.ssim1024.toFixed(4)} |`);
}

// At matched quality, how many bytes does each need?
const TARGETS = [0.95, 0.98];
console.log('\n## bytes to reach a quality target (SSIM@1024), best per format\n');
for (const t of TARGETS) {
  const best = new Map();
  for (const r of rows) {
    if (r.ssim1024 < t) continue;
    const fmt = r.kind === 'hilbert' ? 'hilbert' : r.label.split('-q')[0].split('.').pop() ?? r.label;
    const cur = best.get(fmt);
    if (!cur || r.bytes < cur.bytes) best.set(fmt, r);
  }
  if (best.size === 0) {
    console.log(`SSIM ${t}: nobody reached it`);
    continue;
  }
  const sorted = [...best.entries()].sort((a, b) => a[1].bytes - b[1].bytes);
  const smallest = sorted[0][1].bytes;
  console.log(`SSIM ${t}:`);
  for (const [fmt, r] of sorted) {
    console.log(`  ${fmt.padEnd(10)} ${(r.bytes / 1024).toFixed(1).padStart(9)} KiB  (${(r.bytes / smallest).toFixed(2)}x the best)  ${r.label}`);
  }
}

fs.writeFileSync(path.join(ROOT, 'out', `quality-${IMG}.json`), JSON.stringify({ img: IMG, width: png.width, height: png.height, ourQuality: OUR_Q, encMs, decodeMs, totalBytes: enc.manifest.totalBytes, chunks: enc.chunks.length, rows }, null, 2));

// Honest ratio against AVIF at the same SSIM, if AVIF is present.
const avif = rows.filter((r) => r.label.endsWith('.avif'));
const ours = rows.filter((r) => r.kind === 'hilbert');
if (avif.length && ours.length) {
  const a = avif[avif.length - 1];
  const o = ours[ours.length - 1];
  console.log(`\nfull quality: ours ${(o.bytes / 1024).toFixed(1)} KiB at SSIM ${o.ssim1024.toFixed(4)} vs AVIF ${(a.bytes / 1024).toFixed(1)} KiB at SSIM ${a.ssim1024.toFixed(4)}`);
  console.log(`ours / avif at similar SSIM = ${(o.bytes / a.bytes).toFixed(2)}x bytes`);
}
