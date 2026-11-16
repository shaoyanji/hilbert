// Baseline-style 8x8 DCT and the standard JPEG quantisation tables. The
// prototype keeps JPEG's transform and quantiser on purpose: the question under
// test is the ordering and transport, not a new transform.

const N = 8;
const C = new Float64Array(64);
for (let u = 0; u < N; u++) {
  const cu = u === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
  for (let x = 0; x < N; x++) C[u * N + x] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
}

export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export const Q_LUMA = new Float64Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

export const Q_CHROMA = new Float64Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

// JPEG quality -> quantiser scale (libjpeg's rule).
export function qualityScale(quality) {
  const q = Math.min(100, Math.max(1, quality));
  return q < 50 ? 5000 / q : 200 - 2 * q;
}

export function quantTable(base, quality) {
  const s = qualityScale(quality);
  const out = new Float64Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.max(1, Math.round((base[i] * s) / 100)));
  return out;
}

export function fdct(src, out) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    const row = y * 8;
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += src[row + x] * C[u * 8 + x];
      tmp[row + u] = s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * C[v * 8 + y];
      out[v * 8 + u] = s;
    }
  }
  return out;
}

export function idct(coef, out) {
  const tmp = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    const row = v * 8;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += coef[row + u] * C[u * 8 + x];
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * C[v * 8 + y];
      out[y * 8 + x] = s;
    }
  }
  return out;
}
