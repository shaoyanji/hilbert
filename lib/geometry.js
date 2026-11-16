// Level and tile geometry, derived identically on both ends. The manifest sends
// only (width, height, levels, groupSize); every tile rectangle is recomputed
// from this file, so an encoder/decoder disagreement is a single source to fix
// rather than a duplicated table to drift.

import { hilbertGrid } from './hilbert.js';

export const ceilDiv = (a, b) => Math.ceil(a / b);

export function levelCount(width, height, baseWidth = 48) {
  let n = 0;
  while (Math.max(ceilDiv(width, 2 ** n), ceilDiv(height, 2 ** n)) > baseWidth && n < 12) n++;
  return n + 1;
}

// Level 0 is the coarsest (the whole image as a thumbnail), level levels-1 is
// full resolution.
export function levelDims(width, height, levels, level) {
  const scale = 2 ** (levels - 1 - level);
  const w = ceilDiv(width, scale);
  const h = ceilDiv(height, scale);
  return { w, h, cw: ceilDiv(w, 2), ch: ceilDiv(h, 2), scale };
}

export function tilesAt(width, height, levels, level, group) {
  const { w, h } = levelDims(width, height, levels, level);
  const nx = ceilDiv(w, group);
  const ny = ceilDiv(h, group);
  const grid = hilbertGrid(nx, ny);
  return grid.map(([gx, gy], index) => {
    const x = gx * group;
    const y = gy * group;
    const tw = Math.min(group, w - x);
    const th = Math.min(group, h - y);
    const cx = Math.floor(x / 2);
    const cy = Math.floor(y / 2);
    return {
      index,
      gx,
      gy,
      x,
      y,
      w: tw,
      h: th,
      cx,
      cy,
      cw: ceilDiv(x + tw, 2) - cx,
      ch: ceilDiv(y + th, 2) - cy,
    };
  });
}

export function blocksIn(w, h) {
  return { nx: ceilDiv(w, 8), ny: ceilDiv(h, 8) };
}

// Raster order of a tile grid, i.e. what a flat scan would produce. Used only
// for the comparison the report makes between curve order and scan order.
export function rasterGrid(nx, ny) {
  const out = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) out.push([x, y]);
  return out;
}
