// Deterministic test corpus. Three scenarios the report actually benchmarks:
// a wide panorama with a hard focal region, a thumbnail grid, and a complex
// traced SVG blob for the "raster vs vector" comparison.

import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from '../lib/png.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function panorama(w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  const rand = mulberry32(7);
  const horizon = Math.floor(h * 0.68);
  // Focal region: a city block with window grids, the thing a viewer would
  // actually want first.
  const fx0 = Math.floor(w * 0.62), fx1 = Math.floor(w * 0.88);
  const fy0 = Math.floor(h * 0.30), fy1 = horizon;

  for (let y = 0; y < h; y++) {
    const ty = y / h;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b;
      if (y < horizon) {
        // sky: vertical gradient plus a soft sun
        const k = y / horizon;
        r = 40 + 150 * k;
        g = 90 + 110 * k;
        b = 150 + 60 * k;
        const dx = (x - w * 0.2) / (w * 0.12), dy = (y - h * 0.18) / (h * 0.12);
        const sun = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
        r += 90 * sun;
        g += 70 * sun;
        b += 30 * sun;
        // mountain silhouettes
        const ridge = h * 0.42 + 40 * Math.sin(x / 190) + 26 * Math.sin(x / 71 + 1.2);
        if (y > ridge) {
          const shade = 30 + 22 * Math.sin(x / 40);
          r = shade + 10;
          g = shade + 18;
          b = shade + 34;
        }
        if (x > fx0 && x < fx1 && y > fy0 && y < fy1) {
          const bx = Math.floor((x - fx0) / 46);
          const by = Math.floor((y - fy0) / 34);
          const inBlock = (x - fx0) % 46 > 6 && (y - fy0) % 34 > 5;
          if (inBlock) {
            const tone = 52 + ((bx * 37 + by * 19) % 60);
            r = tone;
            g = tone + 6;
            b = tone + 14;
            // window grid: the high-frequency detail that late bytes carry
            const wx = (x - fx0) % 6, wy = (y - fy0) % 5;
            if (wx < 3 && wy < 3) {
              const lit = (bx * 13 + by * 7 + wx * 3 + wy) % 5 === 0;
              r = lit ? 232 : 26;
              g = lit ? 208 : 30;
              b = lit ? 148 : 44;
            }
          }
        }
      } else {
        // foreground field with texture
        const k = (y - horizon) / (h - horizon);
        r = 46 + 40 * k;
        g = 62 + 54 * k;
        b = 38 + 26 * k;
        const n = (Math.sin(x / 3.1) + Math.sin(y / 2.7) + Math.sin((x + y) / 5.3)) * 9;
        r += n;
        g += n;
        b += n * 0.6;
      }
      const grain = (rand() - 0.5) * 8;
      px[o] = r + grain;
      px[o + 1] = g + grain;
      px[o + 2] = b + grain;
      px[o + 3] = 255;
    }
  }
  return px;
}

function thumbnailGrid(cell, cols, rows) {
  const w = cell * cols, h = cell * rows;
  const px = new Uint8ClampedArray(w * h * 4);
  const rand = mulberry32(21);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const kind = cy * cols + cx;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((cy * cell + y) * w + cx * cell + x) * 4;
          let r, g, b;
          switch (kind % 6) {
            case 0: {
              const d = Math.hypot(x - cell / 2, y - cell / 2) / (cell / 2);
              r = 240 * (1 - d); g = 120 * (1 - d * 0.5); b = 60 + 150 * d;
              break;
            }
            case 1: {
              const s = ((x >> 4) + (y >> 4)) & 1;
              r = s ? 235 : 30; g = s ? 225 : 40; b = s ? 210 : 55;
              break;
            }
            case 2: {
              const t = (x + y) / (2 * cell);
              r = 30 + 200 * t; g = 40 + 120 * t; b = 220 - 160 * t;
              break;
            }
            case 3: {
              const n = rand() * 255;
              r = n; g = n * 0.7; b = n * 0.35;
              break;
            }
            case 4: {
              const ang = Math.atan2(y - cell / 2, x - cell / 2);
              const v = 128 + 100 * Math.sin(ang * 9);
              r = v; g = v * 0.8; b = 255 - v;
              break;
            }
            default: {
              const d = Math.hypot(x - cell / 2, y - cell / 2);
              const ring = Math.sin(d / 6) > 0.3;
              r = ring ? 250 : 22; g = ring ? 90 : 60; b = ring ? 40 : 90;
            }
          }
          px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
        }
      }
    }
  }
  return { px, w, h };
}

// A genuinely complex vector file: many small filled paths, the shape of a
// "traced" illustration that makes SVG rasterisation expensive.
function svgBlob(w, h, shapes) {
  const rand = mulberry32(99);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<defs><linearGradient id="g"><stop offset="0" stop-color="#123"/><stop offset="1" stop-color="#8ab"/></linearGradient></defs>`);
  parts.push(`<rect width="${w}" height="${h}" fill="url(#g)"/>`);
  for (let i = 0; i < shapes; i++) {
    const cx = rand() * w, cy = rand() * h;
    const r = 3 + rand() * 26;
    const n = 5 + Math.floor(rand() * 4);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * (0.6 + rand() * 0.6);
      pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
    }
    const hue = Math.floor(rand() * 360);
    const op = (0.35 + rand() * 0.5).toFixed(2);
    parts.push(`<polygon points="${pts.join(' ')}" fill="hsl(${hue} 70% ${40 + Math.floor(rand() * 30)}%)" opacity="${op}"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'out');
fs.mkdirSync(out, { recursive: true });

function write(name, px, w, h) {
  const buf = encodePNG(px, w, h);
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`${name}\t${w}x${h}\t${(buf.length / 1024).toFixed(0)} KiB`);
}

const t0 = Date.now();
write('panorama.png', panorama(4096, 2048), 4096, 2048);
const grid = thumbnailGrid(512, 3, 2);
write('grid.png', grid.px, grid.w, grid.h);
const svg = svgBlob(1600, 1200, 2500);
fs.writeFileSync(path.join(out, 'blob.svg'), svg);
console.log(`blob.svg\t1600x1200\t${(Buffer.byteLength(svg) / 1024).toFixed(0)} KiB\t2500 paths`);
console.log(`generated in ${Date.now() - t0} ms`);
