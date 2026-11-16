// Isomorphic decoder. Holds the planes of every level it has touched; the
// browser layer asks for RGBA rectangles and paints them, node asks for the same
// rectangles and compares them against the reference. No canvas, no node:zlib —
// inflation is injected so node can use the sync call and the browser a
// DecompressionStream.

import { idct, quantTable, ZIGZAG, Q_LUMA, Q_CHROMA } from './dct.js';
import { tilesAt, levelDims } from './geometry.js';
import { MAGIC_H, MAGIC_B, HEADER_BYTES } from './wire.js';

// Every plane is stored *centred* (luma at Y-128, chroma at 0), because that is
// what the encoder transformed. The single +128 lives in levelToRGBA. Adding it
// here as well was the round trip's first real bug: a net +128 on luma, clipped
// by Uint8ClampedArray, which reads as PSNR 6 dB with structure intact.
function readBlocks(buf, state, plane, pw, ph, rect, q) {
  const bx = Math.ceil(rect.w / 8);
  const by = Math.ceil(rect.h / 8);
  const coef = new Float64Array(64);
  const block = new Float64Array(64);
  let p = state.pos;
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      const nz = buf[p++];
      coef.fill(0);
      let k = 0;
      for (let n = 0; n < nz; n++) {
        const run = buf[p++];
        const lo = buf[p++];
        const hi = buf[p++];
        let v = (hi << 8) | lo;
        if (v > 0x7fff) v -= 0x10000;
        k += run;
        if (k > 63) throw new Error('coefficient overrun');
        coef[ZIGZAG[k]] = v * q[ZIGZAG[k]];
        k++;
      }
      idct(coef, block);
      for (let yy = 0; yy < 8; yy++) {
        const sy = rect.y + j * 8 + yy;
        if (sy >= ph) break;
        for (let xx = 0; xx < 8; xx++) {
          const sx = rect.x + i * 8 + xx;
          if (sx >= pw) break;
          // Planes hold centred values (roughly -128..127), so there is no
          // clamp here: clamping to 0..255 silently destroyed every negative
          // chroma sample, which is half of them. Range limiting belongs in
          // levelToRGBA, on the way out to RGBA.
          plane[sy * pw + sx] = block[yy * 8 + xx];
        }
      }
    }
  }
  state.pos = p;
}

export class Decoder {
  constructor(manifest, { inflate }) {
    this.m = manifest;
    this.inflate = inflate;
    this.qY = quantTable(Q_LUMA, manifest.quality);
    this.qC = quantTable(Q_CHROMA, manifest.quality);
    this.levels = [];
    this.applied = 0;
    this.bytes = 0;
  }

  level(L) {
    if (this.levels[L]) return this.levels[L];
    const d = levelDims(this.m.width, this.m.height, this.m.levels, L);
    const st = {
      ...d,
      y: new Float32Array(d.w * d.h),
      cb: new Float32Array(d.cw * d.ch),
      cr: new Float32Array(d.cw * d.ch),
      received: 0,
      expected: tilesAt(this.m.width, this.m.height, this.m.levels, L, this.m.groupSize).length,
    };
    this.levels[L] = st;
    return st;
  }

  // One chunk: header + deflated payload. Returns the dirty rectangle and level
  // so a caller can repaint exactly that region.
  async applyChunk(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.length < HEADER_BYTES) throw new Error('short chunk');
    if (buf[0] !== MAGIC_H || buf[1] !== MAGIC_B) throw new Error('bad magic');
    const L = buf[8];
    const tw = buf[10] | (buf[11] << 8);
    const th = buf[12] | (buf[13] << 8);
    const tx = buf[14] | (buf[15] << 8);
    const ty = buf[16] | (buf[17] << 8);
    const tileIndex = buf[18] | (buf[19] << 8) | (buf[20] << 16) | (buf[21] << 24);
    const payloadLen = buf[22] | (buf[23] << 8) | (buf[24] << 16) | (buf[25] << 24);
    const rawLen = buf[26] | (buf[27] << 8) | (buf[28] << 16) | (buf[29] << 24);
    if (buf.length < HEADER_BYTES + payloadLen) throw new Error('truncated chunk');
    const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + payloadLen);
    const raw = payloadLen === 0 ? new Uint8Array(0) : await this.inflate(payload);
    if (rawLen !== 0 && raw.length !== rawLen) throw new Error(`payload length mismatch ${raw.length} != ${rawLen}`);

    const st = this.level(L);
    const tiles = tilesAt(this.m.width, this.m.height, this.m.levels, L, this.m.groupSize);
    const t = tiles[tileIndex];
    if (!t) throw new Error(`no tile ${tileIndex} at level ${L}`);
    const state = { pos: 0 };
    readBlocks(raw, state, st.y, st.w, st.h, { x: tx, y: ty, w: tw, h: th }, this.qY);
    if (this.onPass) this.onPass('y', state.pos, raw.length);
    readBlocks(raw, state, st.cb, st.cw, st.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, this.qC);
    if (this.onPass) this.onPass('cb', state.pos, raw.length);
    readBlocks(raw, state, st.cr, st.cw, st.ch, { x: t.cx, y: t.cy, w: t.cw, h: t.ch }, this.qC);
    if (this.onPass) this.onPass('cr', state.pos, raw.length);
    st.received++;
    this.applied++;
    this.bytes += buf.length;
    return { level: L, x: tx, y: ty, w: tw, h: th };
  }

  // RGBA of a rectangle at one level's own resolution.
  levelToRGBA(L, rx, ry, rw, rh) {
    const st = this.level(L);
    const out = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      const sy = ry + y;
      for (let x = 0; x < rw; x++) {
        const sx = rx + x;
        const Y = st.y[sy * st.w + sx];
        const Cb = st.cb[(sy >> 1) * st.cw + (sx >> 1)];
        const Cr = st.cr[(sy >> 1) * st.cw + (sx >> 1)];
        const o = (y * rw + x) * 4;
        out[o] = Y + 1.402 * Cr + 128;
        out[o + 1] = Y - 0.344136 * Cb - 0.714136 * Cr + 128;
        out[o + 2] = Y + 1.772 * Cb + 128;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // The whole level as RGBA, and a nearest-neighbour upscale to full resolution
  // (what a client shows when only that level has arrived).
  levelRGBA(L) {
    const st = this.level(L);
    return this.levelToRGBA(L, 0, 0, st.w, st.h);
  }
}

export function upscale(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const o = (y * nw + x) * 4;
      const i = (sy * w + sx) * 4;
      out[o] = rgba[i];
      out[o + 1] = rgba[i + 1];
      out[o + 2] = rgba[i + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}
