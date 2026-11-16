// Decoder cost, measured in node on the same JS the browser runs. Browser
// timing under `--virtual-time-budget` is not wall clock, so this is the number
// the report quotes for decode work.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodePNG } from '../lib/png.js';
import { encode } from '../lib/codec.js';
import { Decoder } from '../lib/decode.js';

const name = process.argv[2] ?? 'panorama';
const png = decodePNG(fs.readFileSync(new URL(`../out/${name}.png`, import.meta.url)));
const enc = encode(png.data, png.width, png.height, { quality: 75 });
const dec = new Decoder(enc.manifest, { inflate: async (b) => zlib.inflateSync(b) });

// warm the JIT so the first run is not the measurement
for (const c of enc.chunks.slice(0, 50)) await dec.applyChunk(enc.stream.subarray(c.o, c.o + c.l));

const dec2 = new Decoder(enc.manifest, { inflate: async (b) => zlib.inflateSync(b) });
const t0 = process.hrtime.bigint();
for (const c of enc.chunks) await dec2.applyChunk(enc.stream.subarray(c.o, c.o + c.l));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const mp = (png.width * png.height) / 1e6;

console.log(`${name} ${png.width}x${png.height} (${mp.toFixed(2)} MP), ${enc.chunks.length} chunks, ${(enc.manifest.totalBytes / 1024).toFixed(0)} KiB`);
console.log(`full decode: ${ms.toFixed(0)} ms  (${(ms / mp).toFixed(1)} ms/MP, ${(enc.manifest.totalBytes / 1024 / ms * 1000).toFixed(1)} KiB/ms)`);
console.log(`node ${process.version}, ${process.arch}`);
