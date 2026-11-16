// Encoder. Builds a dyadic RGB pyramid, then for every wire level DCT-encodes
// 8x8 blocks of Y plus half-resolution Cb/Cr, grouped into square tiles that are
// emitted in Hilbert order. Level 0 is the whole image at thumbnail size, so the
// first few kilobytes already paint a complete (blurry) picture; each later
// level replaces its parent with a sharper one.

import zlib from 'node:zlib';
import { fdct, quantTable, Q_LUMA, Q_CHROMA, ZIGZAG } from './dct.js';
import { levelCount, levelDims, tilesAt } from './geometry.js';
import { MAGIC_H, MAGIC_B, VERSION, KIND_TILE, HEADER_BYTES } from './wire.js';

function halveRGB(src, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = y * 2 + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx;
          if (sx >= w) break;
          const o = (sy * w + sx) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return out;
}

export function planesFrom(rgba, w, h) {
  const y = new Float64Array(w * h);
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const cb = new Float64Array(cw * ch);
  const cr = new Float64Array(cw * ch);
  const cnt = new Float64Array(cw * ch);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const o = (yy * w + xx) * 4;
      const R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
      y[yy * w + xx] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
      const ci = (yy >> 1) * cw + (xx >> 1);
      cb[ci] += -0.168736 * R - 0.331264 * G + 0.5 * B;
      cr[ci] += 0.5 * R - 0.418688 * G - 0.081312 * B;
      cnt[ci]++;
    }
  }
  for (let i = 0; i < cb.length; i++) {
    if (cnt[i] > 0) {
      cb[i] /= cnt[i];
      cr[i] /= cnt[i];
    }
  }
  return { w, h, cw, ch, y, cb, cr };
}

export function encodePlaneBlocks(out, plane, pw, ph, rect, q) {
  const bx = Math.ceil(rect.w / 8);
  const by = Math.ceil(rect.h / 8);
  const qz = new Float64Array(64);
  for (let k = 0; k < 64; k++) qz[k] = q[ZIGZAG[k]];
  const block = new Float64Array(64);
  const coef = new Float64Array(64);
  const runs = new Uint8Array(64);
  const vals = new Int16Array(64);
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      for (let yy = 0; yy < 8; yy++) {
        let sy = rect.y + j * 8 + yy;
        if (sy >= ph) sy = ph - 1;
        for (let xx = 0; xx < 8; xx++) {
          let sx = rect.x + i * 8 + xx;
          if (sx >= pw) sx = pw - 1;
          block[yy * 8 + xx] = plane[sy * pw + sx];
        }
      }
      fdct(block, coef);
      let nz = 0, run = 0;
      for (let k = 0; k < 64; k++) {
        const v = Math.round(coef[ZIGZAG[k]] / qz[k]);
        if (v === 0) {
          run++;
          continue;
        }
        runs[nz] = run;
        vals[nz] = v;
        nz++;
        run = 0;
      }
      out.push(nz & 0xff);
      for (let k = 0; k < nz; k++) {
        out.push(runs[k] & 0xff, vals[k] & 0xff, (vals[k] >> 8) & 0xff);
      }
    }
  }
}

export function encode(rgba, width, height, opts = {}) {
  const quality = opts.quality ?? 75;
  const group = opts.groupSize ?? 128;
  const baseWidth = opts.baseWidth ?? 48;
  const imageId = opts.imageId ?? 1;
  const levels = levelCount(width, height, baseWidth);
  const qY = quantTable(Q_LUMA, quality);
  const qC = quantTable(Q_CHROMA, quality);

  const pyr = [rgba];
  const pdims = [{ w: width, h: height }];
  while (pyr.length < levels) {
    const cur = pyr[pyr.length - 1];
    const d = pdims[pdims.length - 1];
    const nd = { w: Math.ceil(d.w / 2), h: Math.ceil(d.h / 2) };
    pyr.push(halveRGB(cur, d.w, d.h, nd.w, nd.h));
    pdims.push(nd);
  }

  const parts = [];
  const index = [];
  const levelBytes = [];
  let offset = 0;
  for (let L = 0; L < levels; L++) {
    const d = levelDims(width, height, levels, L);
    const src = pyr[levels - 1 - L];
    const planes = planesFrom(src, d.w, d.h);
    const tiles = tilesAt(width, height, levels, L, group);
    let bytes = 0;
    for (const t of tiles) {
      const out = [];
      encodePlaneBlocks(out, planes.y, d.w, d.h, { x: t.x, y: t.y, w: t.w, h: t.h }, qY);
      encodePlaneBlocks(out, planes.cb, d.cw, d.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, qC);
      encodePlaneBlocks(out, planes.cr, d.cw, d.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, qC);
      const raw = Buffer.from(out);
      const payload = zlib.deflateSync(raw, { level: 9 });
      const head = Buffer.alloc(HEADER_BYTES);
      head[0] = MAGIC_H;
      head[1] = MAGIC_B;
      head[2] = VERSION;
      head[3] = KIND_TILE;
      head.writeUInt32LE(imageId, 4);
      head[8] = L;
      head[9] = 0;
      head.writeUInt16LE(t.w, 10);
      head.writeUInt16LE(t.h, 12);
      head.writeUInt16LE(t.x, 14);
      head.writeUInt16LE(t.y, 16);
      head.writeUInt32LE(t.index, 18);
      head.writeUInt32LE(payload.length, 22);
      head.writeUInt32LE(raw.length, 26);
      const len = HEADER_BYTES + payload.length;
      index.push({ o: offset, l: len, L, t: t.index, x: t.x, y: t.y, w: t.w, h: t.h });
      parts.push(head, payload);
      offset += len;
      bytes += len;
    }
    levelBytes.push({ level: L, w: d.w, h: d.h, tiles: tiles.length, bytes });
  }

  const totalBytes = offset;
  return {
    stream: Buffer.concat(parts),
    chunks: index,
    manifest: {
      version: VERSION,
      imageId,
      width,
      height,
      levels,
      groupSize: group,
      quality,
      baseWidth,
      totalBytes,
      levelBytes,
      index,
    },
  };
}
