// Hilbert curve <-> coordinate mapping. Standard iterative d2xy from
// "Programming the Hilbert curve" (Skilling 2004 form as used in graphics).
// The grid side must be a power of two; caller pads its tile grid up to one.

export function d2xy(side, d) {
  let t = d, x = 0, y = 0;
  for (let s = 1; s < side; s *= 2) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

export function xy2d(side, x, y) {
  let d = 0;
  for (let s = side / 2; s > 0; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
  }
  return d;
}

// Tile coordinates of an nx * ny grid, in Hilbert order, skipping padding
// cells introduced by the power-of-two padding.
export function hilbertGrid(nx, ny) {
  const side = 1 << Math.ceil(Math.log2(Math.max(nx, ny)));
  const out = [];
  for (let d = 0; d < side * side; d++) {
    const [x, y] = d2xy(side, d);
    if (x < nx && y < ny) out.push([x, y]);
  }
  return out;
}
