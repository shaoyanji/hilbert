// Render a tokenloom .himg to PNG: Hilbert-ordered pixels into this repo's PNG
// encoder, read back through this repo's own curve.
//
//   node tools/loom-himg.js <file.himg> [outDir]
//
// The payload is already in curve order, so nothing here re-orders bytes along
// the curve — it walks the curve to find out where each byte belongs. If the
// writer and this file disagreed about the curve, the picture would be scrambled;
// test/loom-parity.js is what says whether they do.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { d2xy } from '../lib/hilbert.js';
import { encodePNG } from '../lib/png.js';

const LANES = { gray8: 1, rgb8: 3, rgba8: 4 };

function fnv1a(buf) {
  let h = 0x811c9dc5;
  for (const b of buf) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function parseHimg(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new Error('himg has no header line');
  const header = buf.subarray(0, nl).toString('utf8');
  const [magic, version, ...fields] = header.split(/\s+/);
  if (magic !== 'LOOMHILB') throw new Error(`not a LOOMHILB stream: ${magic}`);
  const f = Object.fromEntries(
    fields.map((kv) => {
      const [k, v] = kv.split('=');
      return [k, v];
    }),
  );
  const order = Number(f.order);
  const side = 1 << order;
  const cells = side * side;
  const bpp = LANES[f.layout];
  if (!bpp) throw new Error(`unknown layout ${f.layout}`);
  const data = buf.subarray(nl + 1);
  if (data.length !== cells * bpp) {
    throw new Error(`payload is ${data.length} bytes, ${cells}×${bpp} expected`);
  }
  if (fnv1a(data) !== parseInt(f.fnv, 16)) {
    throw new Error('checksum disagrees with the header');
  }
  return { version, order, side, cells, bpp, layout: f.layout, data };
}

export function toRgba(img) {
  const { side, cells, bpp, data } = img;
  const out = Buffer.alloc(cells * 4);
  for (let d = 0; d < cells; d++) {
    const [x, y] = d2xy(side, d);
    const o = (y * side + x) * 4;
    if (bpp === 1) {
      out[o] = out[o + 1] = out[o + 2] = data[d];
      out[o + 3] = 255;
    } else {
      out[o] = data[d * bpp];
      out[o + 1] = data[d * bpp + 1];
      out[o + 2] = data[d * bpp + 2];
      out[o + 3] = bpp === 4 ? data[d * bpp + 3] : 255;
    }
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [file, outDir = '.'] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tools/loom-himg.js <file.himg> [outDir]');
    process.exit(2);
  }
  const img = parseHimg(readFileSync(file));
  const name = basename(file).replace(/\.himg$/, '');
  const png = encodePNG(toRgba(img), img.side, img.side);
  const at = join(outDir, `${name}.png`);
  writeFileSync(at, png);
  console.log(
    `${name}: ${img.side}×${img.side} ${img.layout} v${img.version} → ${at} (${png.length} bytes)`,
  );
}
