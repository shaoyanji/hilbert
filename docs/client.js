// Static-hosted streaming client. No server logic: the stream is a plain file of
// chunks, and a priority order is expressed as HTTP Range requests over it.
//
// Default order is the file as-is, so it is one request and one forward-only
// read. ROI order asks for the byte spans that hold the selected region first,
// then the rest, which on a Range-capable host (GitHub Pages, any CDN) costs a
// handful of requests and no server state. If the host ignores Range and answers
// 200 with the whole file, the client notices, consumes what it got, and says so.

import { Decoder } from './lib/decode.js';
import { HEADER_BYTES } from './lib/wire.js';
import { tilesAt, levelDims } from './lib/geometry.js';

const $ = (id) => document.getElementById(id);
const canvas = $('hsCanvas');
const ctx = canvas.getContext('2d');
const jpgImg = $('jpgImg');

const THROTTLES = [0, 48e3, 96e3, 192e3, 384e3, 768e3, 1.5e6, 3e6, 6e6];

const state = {
  manifest: null,
  decoder: null,
  canvases: [],
  highest: -1,
  bytes: 0,
  chunks: 0,
  firstPaint: null,
  roi: null,
  roiMode: false,
  roiDone: null,
  rangeFallback: false,
  abort: null,
  decodeMs: 0,
  started: 0,
};

const throttleLabel = (v) => (v ? `${(v / 1024).toFixed(0)} KiB/s` : 'unthrottled');

function reset() {
  Object.assign(state, {
    decoder: null, canvases: [], highest: -1, bytes: 0, chunks: 0,
    firstPaint: null, roiDone: null, rangeFallback: false, decodeMs: 0,
  });
  for (const id of ['stFirst', 'stFirstMs', 'stChunks', 'stLevel', 'stDecode', 'stRoi']) $(id).textContent = '–';
  $('hsByteLabel').textContent = '';
  $('waterfall').innerHTML = '';
}

// ---- ordering ---------------------------------------------------------------

// Same policy the prototype's server implements: per level, tiles overlapping
// the ROI first, Hilbert order preserved inside each group.
function orderChunks(m, roi) {
  if (!roi) return m.index.slice();
  const out = [];
  for (let L = 0; L < m.levels; L++) {
    const byTile = new Map(m.index.filter((c) => c.L === L).map((c) => [c.t, c]));
    const hit = [];
    const miss = [];
    for (const t of tilesAt(m.width, m.height, m.levels, L, m.groupSize)) {
      const overlaps = t.x < roi.x + roi.w && t.x + t.w > roi.x && t.y < roi.y + roi.h && t.y + t.h > roi.y;
      (overlaps ? hit : miss).push(t);
    }
    for (const t of hit.concat(miss)) out.push(byTile.get(t.index));
  }
  return out;
}

// Adjacent chunks become one Range request, so the default order is exactly one
// request for the whole file and an ROI costs a few spans.
function toRuns(chunks) {
  const runs = [];
  for (const c of chunks) {
    const last = runs[runs.length - 1];
    if (last && last.start + last.length === c.o) last.length += c.l;
    else runs.push({ start: c.o, length: c.l });
  }
  return runs;
}

// ---- decode + paint ---------------------------------------------------------

function canvasFor(level) {
  if (state.canvases[level]) return state.canvases[level];
  const d = levelDims(state.manifest.width, state.manifest.height, state.manifest.levels, level);
  const c = document.createElement('canvas');
  c.width = d.w;
  c.height = d.h;
  const c2 = c.getContext('2d', { willReadFrequently: true });
  const parent = level > 0 ? state.canvases[level - 1] : null;
  if (parent) {
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(parent, 0, 0, d.w, d.h);
  } else {
    c2.fillStyle = '#05070a';
    c2.fillRect(0, 0, d.w, d.h);
  }
  state.canvases[level] = c;
  return c;
}

function paint(level) {
  const c = canvasFor(level);
  state.highest = Math.max(state.highest, level);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.canvases[state.highest], 0, 0, canvas.width, canvas.height);
}

function applyDirty(d) {
  const c = canvasFor(d.level);
  const c2 = c.getContext('2d', { willReadFrequently: true });
  const rgba = state.decoder.levelToRGBA(d.level, d.x, d.y, d.w, d.h);
  c2.putImageData(new ImageData(rgba, d.w, d.h), d.x, d.y);
  paint(d.level);
}

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- the stream -------------------------------------------------------------

async function run() {
  if (state.abort) state.abort.abort();
  const ctl = new AbortController();
  state.abort = ctl;
  reset();

  const img = $('img').value;
  const t0 = performance.now();
  const manifest = await (await fetch(`./streams/${img}.manifest.json`, { signal: ctl.signal })).json();
  state.manifest = manifest;
  state.decoder = new Decoder(manifest, { inflate });
  $('stTotal').textContent = `${(manifest.totalBytes / 1024).toFixed(0)} KiB`;

  const order = orderChunks(manifest, state.roiMode ? state.roi : null);
  const runs = toRuns(order);
  const budget = THROTTLES[Number($('throttle').value)];
  const wf = $('waterfall');
  $('serving').textContent = state.roiMode && runs.length > 1
    ? `${runs.length} range requests (ROI order)`
    : '1 request (file order)';

  for (let i = 0; i < runs.length; i++) {
    if (state.abort !== ctl) return;
    const run_ = runs[i];
    const headers = run_.start === 0 && run_.length === manifest.totalBytes
      ? {}
      : { Range: `bytes=${run_.start}-${run_.start + run_.length - 1}` };
    const res = await fetch(`./streams/${img}.hs`, { headers, signal: ctl.signal });
    if (res.status === 200 && headers.Range) {
      // Host ignored Range and shipped the whole file: consume it once and stop.
      state.rangeFallback = true;
      $('serving').textContent = 'host ignored Range — full file, no ROI ordering';
    }
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let done = false;
    while (!done) {
      const { done: d, value } = await reader.read();
      if (value) {
        if (buf.length === 0) buf = value;
        else {
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf);
          merged.set(value, buf.length);
          buf = merged;
        }
      }
      while (buf.length >= HEADER_BYTES) {
        const frame = HEADER_BYTES + u32(buf, 22);
        if (buf.length < frame) break;
        const chunk = buf.subarray(0, frame);
        const level = buf[8];
        const tDec = performance.now();
        const dirty = await state.decoder.applyChunk(chunk);
        state.decodeMs += performance.now() - tDec;
        state.chunks++;
        state.bytes += frame;
        buf = buf.subarray(frame);
        applyDirty(dirty);

        if (state.firstPaint === null) {
          state.firstPaint = { bytes: state.bytes, ms: performance.now() - t0 };
          $('stFirst').textContent = `${(state.bytes / 1024).toFixed(1)} KiB`;
          $('stFirstMs').textContent = `${state.firstPaint.ms.toFixed(0)} ms`;
        }
        if (state.roiMode && state.roi && !state.roiDone && dirty.level === manifest.levels - 1) {
          const r = state.roi;
          if (dirty.x < r.x + r.w && dirty.x + dirty.w > r.x && dirty.y < r.y + r.h && dirty.y + dirty.h > r.y) {
            state.roiDone = { bytes: state.bytes, ms: Math.round(performance.now() - t0) };
            // A persistent tile, not the status line: the status is overwritten
            // when the stream finishes, and this is the number the ROI claim
            // rests on.
            $('stRoi').textContent = `${(state.bytes / 1024).toFixed(0)} KiB · ${(100 * state.bytes / manifest.totalBytes).toFixed(1)}%`;
            $('status').textContent = `ROI at full detail after ${(state.bytes / 1024).toFixed(0)} KiB`;
          }
        }
        $('stChunks').textContent = String(state.chunks);
        const st = state.decoder.levels[dirty.level];
        $('stLevel').textContent = `${dirty.level}/${manifest.levels - 1} · ${st.received}/${st.expected}`;
        $('stDecode').textContent = `${state.decodeMs.toFixed(0)} ms`;
        $('hsByteLabel').textContent = `${(state.bytes / 1024).toFixed(0)} / ${(manifest.totalBytes / 1024).toFixed(0)} KiB`;
        if (wf.childElementCount < 400) {
          const bar = document.createElement('i');
          bar.style.height = `${Math.max(3, Math.min(100, (frame / manifest.totalBytes) * 600))}%`;
          bar.style.background = state.roiMode && state.roi ? '#5ad1a0' : '#3d6fa8';
          wf.appendChild(bar);
        }
        if (budget) await new Promise((r) => setTimeout(r, (frame / budget) * 1000));
      }
      if (d) done = true;
    }
    if (state.rangeFallback) break;
  }

  $('status').textContent = `done: ${state.chunks} chunks, ${(state.bytes / 1024).toFixed(1)} KiB, ${state.decodeMs.toFixed(0)} ms decode`;
}

// ---- ROI drag ---------------------------------------------------------------

const point = (ev) => {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round((ev.clientX - r.left) * (state.manifest.width / r.width)),
    y: Math.round((ev.clientY - r.top) * (state.manifest.height / r.height)),
  };
};

let drag = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (!state.roiMode) return;
  drag = point(ev);
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointerup', (ev) => {
  if (!state.roiMode || !drag) return;
  const end = point(ev);
  const g = state.manifest.groupSize;
  const x = Math.min(drag.x, end.x);
  const y = Math.min(drag.y, end.y);
  state.roi = {
    x: Math.floor(x / g) * g,
    y: Math.floor(y / g) * g,
    w: Math.ceil(Math.max(32, Math.abs(end.x - drag.x)) / g) * g,
    h: Math.ceil(Math.max(32, Math.abs(end.y - drag.y)) / g) * g,
  };
  drag = null;
  run();
});

$('img').addEventListener('change', () => { run(); loadBaseline(); });
$('restart').addEventListener('click', run);
$('roiMode').addEventListener('change', (e) => {
  state.roiMode = e.target.checked;
  if (!state.roiMode) state.roi = null;
});
$('throttle').addEventListener('input', (e) => {
  $('throttleLabel').textContent = throttleLabel(THROTTLES[Number(e.target.value)]);
});
$('throttleLabel').textContent = throttleLabel(THROTTLES[0]);

async function loadBaseline() {
  const img = $('img').value;
  const res = await fetch(`./baselines/${img}-q65-jpeg.jpg`);
  if (!res.ok) {
    $('jpgByteLabel').textContent = '(no baseline for this image)';
    jpgImg.removeAttribute('src');
    return;
  }
  const blob = await res.blob();
  $('jpgByteLabel').textContent = `${(blob.size / 1024).toFixed(0)} KiB · q65`;
  jpgImg.src = URL.createObjectURL(blob);
}

const qp = new URLSearchParams(location.search);
if (qp.get('roi')) {
  const [x, y, w, h] = qp.get('roi').split(',').map(Number);
  state.roi = { x, y, w, h };
  state.roiMode = true;
  $('roiMode').checked = true;
}

run();
loadBaseline();
