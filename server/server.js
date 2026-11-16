// Streaming server. Encodes the corpus on first request, then serves chunk
// streams with a caller-chosen order: default (level by level, Hilbert within a
// level) or ROI-first. The stream is binary and chunk-framed, so a client parses
// it off a ReadableStream without waiting for the response to finish.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../lib/png.js';
import { encode } from '../lib/codec.js';
import { tilesAt } from '../lib/geometry.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.PORT ?? 8099);
const QUALITY = Number(process.env.QUALITY ?? 75);
const IMAGES = (process.env.IMAGES ?? 'panorama,grid').split(',');
const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const png = decodePNG(fs.readFileSync(path.join(ROOT, 'out', `${name}.png`)));
  const t = Date.now();
  const enc = encode(png.data, png.width, png.height, { quality: QUALITY, imageId: name.length * 7 });
  const obj = { ...enc, name, width: png.width, height: png.height, reference: png.data, encodeMs: Date.now() - t };
  cache.set(name, obj);
  console.log(`encoded ${name} ${png.width}x${png.height} -> ${(enc.manifest.totalBytes / 1024).toFixed(1)} KiB (${enc.chunks.length} chunks) in ${obj.encodeMs} ms`);
  return obj;
}

// Chunk order. With an ROI, every level puts the tiles that overlap it first and
// keeps Hilbert order inside each group, so the region sharpens while the rest
// stays at the previous level's detail.
function chunkOrder(m, roi, minLevel = 0) {
  const out = [];
  for (let L = 0; L < m.levels; L++) {
    const tiles = tilesAt(m.width, m.height, m.levels, L, m.groupSize);
    let list = tiles;
    if (roi && L >= minLevel) {
      const hit = [];
      const miss = [];
      for (const t of tiles) {
        const overlaps = t.x < roi.x + roi.w && t.x + t.w > roi.x && t.y < roi.y + roi.h && t.y + t.h > roi.y;
        (overlaps ? hit : miss).push(t);
      }
      list = hit.concat(miss);
    }
    const byTile = new Map(m.index.filter((c) => c.L === L).map((c) => [c.t, c]));
    for (const t of list) out.push(byTile.get(t.index));
  }
  return out;
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.jxl': 'image/jxl', '.svg': 'image/svg+xml' };

function staticFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(buf);
  });
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/') {
      res.writeHead(302, { Location: '/demo/index.html' }).end();
      return;
    }

    if (p === '/api/manifest') {
      const img = load(url.searchParams.get('img') ?? IMAGES[0]);
      const { stream, reference, ...rest } = img;
      json(res, rest.manifest);
      return;
    }

    if (p === '/api/reference') {
      staticFile(res, path.join(ROOT, 'out', `${url.searchParams.get('img') ?? IMAGES[0]}.png`));
      return;
    }

    if (p === '/api/list') {
      json(res, IMAGES);
      return;
    }

    if (p === '/api/stream') {
      const img = load(url.searchParams.get('img') ?? IMAGES[0]);
      let roi = null;
      const r = url.searchParams.get('roi');
      if (r) {
        const [x, y, w, h] = r.split(',').map(Number);
        roi = { x, y, w, h };
      }
      const minLevel = Number(url.searchParams.get('minLevel') ?? 0);
      const chunks = chunkOrder(img.manifest, roi, minLevel);
      const total = chunks.reduce((a, c) => a + c.l, 0);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Total-Bytes': String(total),
        'X-Chunks': String(chunks.length),
      });
      for (const c of chunks) res.write(img.stream.subarray(c.o, c.o + c.l));
      res.end();
      return;
    }

    if (p === '/api/baseline') {
      const name = url.searchParams.get('f') ?? '';
      if (!/^[\w.-]+$/.test(name)) {
        res.writeHead(400).end('bad name');
        return;
      }
      staticFile(res, path.join(ROOT, 'out', name));
      return;
    }

    if (p === '/api/report' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      fs.appendFileSync(path.join(ROOT, 'out', 'reports.jsonl'), `${body}\n`);
      res.writeHead(204).end();
      return;
    }

    if (p.startsWith('/demo/')) {
      staticFile(res, path.join(ROOT, 'demo', p.slice(6)));
      return;
    }
    if (p.startsWith('/bench/')) {
      staticFile(res, path.join(ROOT, 'bench', p.slice(7)));
      return;
    }
    if (p.startsWith('/lib/')) {
      staticFile(res, path.join(ROOT, 'lib', p.slice(5)));
      return;
    }
    if (p.startsWith('/out/')) {
      staticFile(res, path.join(ROOT, 'out', p.slice(5)));
      return;
    }

    res.writeHead(404).end('not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end(String(err && err.message));
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hilbert-stream listening on http://127.0.0.1:${PORT}`);
  for (const name of IMAGES) {
    try {
      load(name);
    } catch (err) {
      console.log(`skip ${name}: ${err.message}`);
    }
  }
});
