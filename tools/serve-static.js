// Local preview server for the static site, with Range support so ROI mode
// behaves the way it will on GitHub Pages. `python3 -m http.server` ignores
// Range, and the client notices and falls back — this is for testing the real
// path.
//
//   node tools/serve-static.js [port] [root]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8100);
const root = path.resolve(process.argv[3] ?? new URL('../docs', import.meta.url).pathname);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.hs': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!path.resolve(file).startsWith(root)) {
    res.writeHead(403).end('no');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), st.size - 1);
        if (start >= st.size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`static site: http://127.0.0.1:${port}/  (root ${root})`);
});
