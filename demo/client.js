// Streaming client. Binary only: one fetch, one ReadableStream, chunks parsed as
// their bytes land. Nothing here knows about the codec's internals beyond the
// wire header, and no base64 or JSON array is involved in the pixel path.

import { Decoder } from '../lib/decode.js';
import { HEADER_BYTES } from '../lib/wire.js';
import { tilesAt, levelDims } from '../lib/geometry.js';

const $ = (id) => document.getElementById(id);
const hsCanvas = $('hsCanvas');
const hsCtx = hsCanvas.getContext('2d', { willReadFrequently: false });
const jpgImg = $('jpgImg');

const THROTTLES = [0, 48e3, 96e3, 192e3, 384e3, 768e3, 1.5e6, 3e6, 6e6];

const state = {
  img: 'panorama',
  manifest: null,
  decoder: null,
  levelCanvases: [],
  highestLevel: -1,
  bytes: 0,
  chunks: 0,
  firstPaint: null,
  decodeMs: 0,
  roi: null,
  roiMode: false,
  abort: null,
  jpgBytes: 0,
  started: 0,
  waterfall: [],
};

function throttleLabel(v) {
  if (!v) return 'unthrottled';
  return `${(v / 1024).toFixed(0)} KiB/s`;
}

function resetStats() {
  state.bytes = 0;
  state.chunks = 0;
  state.firstPaint = null;
  state.decodeMs = 0;
  state.highestLevel = -1;
  state.waterfall = [];
  state.levelCanvases = [];
  state.roiDone = null;
  state.decoder = null;
  $('stFirst').textContent = '–';
  $('stFirstMs').textContent = '–';
  $('stChunks').textContent = '–';
  $('stLevel').textContent = '–';
  $('stDecode').textContent = '–';
  $('hsByteLabel').textContent = '';
  $('waterfall').innerHTML = '';
}

// One canvas per level: a level is initialised by upscaling the level above it,
// so a chunk landing at level L refines a picture that already exists.
function canvasFor(level) {
  if (state.levelCanvases[level]) return state.levelCanvases[level];
  const d = levelDims(state.manifest.width, state.manifest.height, state.manifest.levels, level);
  const c = document.createElement('canvas');
  c.width = d.w;
  c.height = d.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const parent = level > 0 ? state.levelCanvases[level - 1] : null;
  if (parent) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(parent, 0, 0, d.w, d.h);
  } else {
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, d.w, d.h);
  }
  state.levelCanvases[level] = c;
  return c;
}

function paint(level) {
  const c = canvasFor(level);
  state.highestLevel = Math.max(state.highestLevel, level);
  const src = state.levelCanvases[state.highestLevel];
  hsCtx.imageSmoothingEnabled = true;
  hsCtx.imageSmoothingQuality = 'high';
  hsCtx.drawImage(src, 0, 0, hsCanvas.width, hsCanvas.height);
}

function applyDirty(dirty) {
  const c = canvasFor(dirty.level);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rgba = state.decoder.levelToRGBA(dirty.level, dirty.x, dirty.y, dirty.w, dirty.h);
  ctx.putImageData(new ImageData(rgba, dirty.w, dirty.h), dirty.x, dirty.y);
  paint(dirty.level);
}

function readU32(buf, o) {
  return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function run() {
  if (state.abort) state.abort.abort();
  const ctl = new AbortController();
  state.abort = ctl;
  resetStats();

  const img = $('img').value;
  state.img = img;
  const t0 = performance.now();
  state.started = t0;

  const manifest = await (await fetch(`/api/manifest?img=${img}`, { signal: ctl.signal })).json();
  state.manifest = manifest;
  state.decoder = new Decoder(manifest, { inflate });
  $('stTotal').textContent = `${(manifest.totalBytes / 1024).toFixed(0)} KiB`;

  const params = new URLSearchParams({ img });
  if (state.roiMode && state.roi) params.set('roi', `${state.roi.x},${state.roi.y},${state.roi.w},${state.roi.h}`);
  const res = await fetch(`/api/stream?${params}`, { signal: ctl.signal });
  const total = Number(res.headers.get('X-Total-Bytes') ?? manifest.totalBytes);
  const reader = res.body.getReader();
  const budget = THROTTLES[Number($('throttle').value)];
  let buf = new Uint8Array(0);
  const wf = $('waterfall');

  while (true) {
    const { done, value } = await reader.read();
    if (value) buf = buf.length ? new Uint8Array([...buf, ...value]) : value;
    // Parse every complete chunk already in the buffer.
    while (buf.length >= HEADER_BYTES) {
      const payloadLen = readU32(buf, 22);
      const frame = HEADER_BYTES + payloadLen;
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

      // ROI bookkeeping: the moment the selected region first receives a
      // full-resolution tile, record what the client had spent to get there.
      if (state.roiMode && state.roi && !state.roiDone && dirty.level === manifest.levels - 1) {
        const r = state.roi;
        if (dirty.x < r.x + r.w && dirty.x + dirty.w > r.x && dirty.y < r.y + r.h && dirty.y + dirty.h > r.y) {
          state.roiDone = { bytes: state.bytes, ms: Math.round(performance.now() - t0) };
          $('status').textContent = `ROI at full detail after ${(state.bytes / 1024).toFixed(0)} KiB`;
        }
      }

      if (state.firstPaint === null) {
        state.firstPaint = { bytes: state.bytes, ms: performance.now() - t0 };
        $('stFirst').textContent = `${(state.bytes / 1024).toFixed(1)} KiB`;
        $('stFirstMs').textContent = `${state.firstPaint.ms.toFixed(0)} ms`;
      }
      $('stChunks').textContent = String(state.chunks);
      const st = state.decoder.levels[dirty.level];
      $('stLevel').textContent = `${dirty.level}/${manifest.levels - 1} · ${st.received}/${st.expected}`;
      $('stDecode').textContent = `${state.decodeMs.toFixed(0)} ms`;
      $('hsByteLabel').textContent = `${(state.bytes / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KiB`;

      if (state.waterfall.length < 400) {
        const bar = document.createElement('i');
        bar.style.height = `${Math.max(3, Math.min(100, (frame / manifest.totalBytes) * 600))}%`;
        bar.style.background = state.roiMode && state.roi ? '#5ad1a0' : '#3d6fa8';
        wf.appendChild(bar);
      }

      if (budget) {
        // crude shaping: spend the chunk's bytes at the configured rate
        await new Promise((r) => setTimeout(r, (frame / budget) * 1000));
      }
    }
    if (done) break;
  }

  const report = {
    kind: 'hilbert-stream',
    img,
    roi: state.roiMode ? state.roi : null,
    bytesFirstPaint: state.firstPaint?.bytes ?? null,
    msFirstPaint: state.firstPaint ? Math.round(state.firstPaint.ms) : null,
    chunks: state.chunks,
    bytes: state.bytes,
    bytesToRoiFull: state.roiDone?.bytes ?? null,
    msToRoiFull: state.roiDone?.ms ?? null,
    totalBytes: manifest.totalBytes,
    levelBytes: manifest.levelBytes,
    decodeMs: Math.round(state.decodeMs),
    totalMs: Math.round(performance.now() - t0),
    userAgent: navigator.userAgent,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
  };
  $('status').textContent = `done: ${state.chunks} chunks, ${(state.bytes / 1024).toFixed(1)} KiB, ${report.totalMs} ms`;
  navigator.sendBeacon('/api/report', JSON.stringify(report));
}

// ROI: drag a rectangle on the left canvas, then the stream is re-requested with
// that region first. Coordinates map canvas -> source pixels.
function canvasPoint(ev) {
  const r = hsCanvas.getBoundingClientRect();
  const sx = state.manifest ? state.manifest.width / r.width : 1;
  const sy = state.manifest ? state.manifest.height / r.height : 1;
  return { x: Math.round((ev.clientX - r.left) * sx), y: Math.round((ev.clientY - r.top) * sy) };
}

let dragStart = null;
hsCanvas.addEventListener('pointerdown', (ev) => {
  if (!state.roiMode) return;
  dragStart = canvasPoint(ev);
  hsCanvas.setPointerCapture(ev.pointerId);
});
hsCanvas.addEventListener('pointerup', (ev) => {
  if (!state.roiMode || !dragStart) return;
  const end = canvasPoint(ev);
  const x = Math.min(dragStart.x, end.x);
  const y = Math.min(dragStart.y, end.y);
  const w = Math.max(32, Math.abs(end.x - dragStart.x));
  const h = Math.max(32, Math.abs(end.y - dragStart.y));
  // Snap to the finest level's tile grid so "the ROI" is a set of whole chunks.
  const g = state.manifest.groupSize;
  state.roi = { x: Math.floor(x / g) * g, y: Math.floor(y / g) * g, w: Math.ceil(w / g) * g, h: Math.ceil(h / g) * g };
  dragStart = null;
  $('status').textContent = `ROI ${state.roi.x},${state.roi.y} ${state.roi.w}×${state.roi.h} — restarting`;
  run();
});

$('img').addEventListener('change', run);
$('restart').addEventListener('click', run);
$('roiMode').addEventListener('change', (e) => {
  state.roiMode = e.target.checked;
  if (!state.roiMode) state.roi = null;
});
$('throttle').addEventListener('input', (e) => {
  $('throttleLabel').textContent = throttleLabel(THROTTLES[Number(e.target.value)]);
});
$('throttleLabel').textContent = throttleLabel(THROTTLES[0]);

// Baseline pane: progressive JPEG fetched with the same throttled connection.
async function loadBaseline() {
  const img = $('img').value;
  const name = `${img}-q85-jpeg.jpg`;
  const res = await fetch(`/api/baseline?f=${name}`);
  if (!res.ok) {
    $('jpgByteLabel').textContent = '(baseline not generated)';
    return;
  }
  const blob = await res.blob();
  $('jpgByteLabel').textContent = `${(blob.size / 1024).toFixed(0)} KiB`;
  jpgImg.src = URL.createObjectURL(blob);
}
$('img').addEventListener('change', loadBaseline);

// Headless hooks: ?roi=x,y,w,h starts straight in ROI mode, so a benchmark run
// needs no pointer drag.
const qp = new URLSearchParams(location.search);
if (qp.get('roi')) {
  const [x, y, w, h] = qp.get('roi').split(',').map(Number);
  state.roi = { x, y, w, h };
  state.roiMode = true;
  $('roiMode').checked = true;
}

run();
loadBaseline();
