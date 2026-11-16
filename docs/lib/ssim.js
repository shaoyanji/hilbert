// SSIM on luma with an 11x11 Gaussian window — the usual constants, computed
// identically in node and in the browser so a benchmark number means one thing.
// Inputs are RGBA Uint8ClampedArray of the same size.

const WIN = 11;
const SIGMA = 1.5;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function gaussKernel() {
  const k = new Float64Array(WIN);
  const c = (WIN - 1) / 2;
  let sum = 0;
  for (let i = 0; i < WIN; i++) {
    k[i] = Math.exp(-((i - c) ** 2) / (2 * SIGMA * SIGMA));
    sum += k[i];
  }
  for (let i = 0; i < WIN; i++) k[i] /= sum;
  return k;
}
const K = gaussKernel();

function luma(rgba, w, h) {
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

// Separable 11-tap pass over a scalar plane with edge clamping.
function blur(plane, w, h) {
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = 0; t < WIN; t++) {
        let sx = x + t - 5;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        s += plane[y * w + sx] * K[t];
      }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = 0; t < WIN; t++) {
        let sy = y + t - 5;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        s += tmp[sy * w + x] * K[t];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

export function ssim(a, b, w, h) {
  const la = luma(a, w, h);
  const lb = luma(b, w, h);
  const muA = blur(la, w, h);
  const muB = blur(lb, w, h);
  const aa = new Float64Array(w * h);
  const bb = new Float64Array(w * h);
  const ab = new Float64Array(w * h);
  for (let i = 0; i < aa.length; i++) {
    aa[i] = la[i] * la[i];
    bb[i] = lb[i] * lb[i];
    ab[i] = la[i] * lb[i];
  }
  const sAA = blur(aa, w, h);
  const sBB = blur(bb, w, h);
  const sAB = blur(ab, w, h);
  let sum = 0;
  for (let i = 0; i < muA.length; i++) {
    const mA = muA[i], mB = muB[i];
    const vA = sAA[i] - mA * mA;
    const vB = sBB[i] - mB * mB;
    const cov = sAB[i] - mA * mB;
    sum += ((2 * mA * mB + C1) * (2 * cov + C2)) / ((mA * mA + mB * mB + C1) * (vA + vB + C2));
  }
  return sum / muA.length;
}

export function psnr(a, b, w, h) {
  let se = 0;
  const n = w * h * 3;
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) {
      const d = a[p * 4 + c] - b[p * 4 + c];
      se += d * d;
    }
  }
  const mse = se / n;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}
