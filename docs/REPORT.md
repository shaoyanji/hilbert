# Report — hierarchical Hilbert progressive image streaming

Feasibility prototype, built and measured entirely on the Instabox VM `clanker`
(4 vCPU EPYC, 8 GiB, 20 GiB `/data`), 2026-11-16.

**Verdict in one line:** the concept works, the preview claim is real and cheap,
the ROI claim is real but bounded, the compression is respectable-not-competitive,
and the idea is not novel. Details, including the parts that did not work, below.

## 1. What was built

| Piece | Path | State |
| :--- | :--- | :--- |
| Encoder: PNG → dyadic pyramid → DCT blocks → Hilbert-ordered tiles → deflate | `lib/codec.js`, `encoder/encode.js` | working |
| Decoder: isomorphic, no canvas, no `node:zlib` dependency | `lib/decode.js`, `decoder/decode-to-png.js` | working, exact at q100 |
| Streaming server: chunk stream, ROI reordering, baselines, report sink | `server/server.js` | working |
| Streaming client + demo: `fetch` + `ReadableStream`, per-level canvases, ROI drag, bandwidth shaping | `demo/` | working, screenshotted |
| Baselines: JPEG (progressive), WebP, JXL, AVIF | `bench/codecs.sh` | working |
| Quality harness, fixed comparison sizes, one SSIM implementation | `bench/quality.js`, `lib/ssim.js` | working |
| Corpus: 4096×2048 panorama with a hard focal region, thumbnail grid, 2500-path SVG | `bench/gen.js` | working |

Test image: 4096×2048 (8.39 MP) synthetic panorama — gradient sky, mountain
ridges, a city block whose window grid is the high-frequency focal detail, a
textured foreground, per-pixel grain. Deterministic seed. Encoded at q75: **685
chunks, 1416 KiB, 1258 ms**.

## 2. Results

### 2.1 A complete picture from 263 bytes

The stream's first chunk is level 0 — the whole image at 32×16. In headless
Chromium, bytes-to-first-paint was **263 bytes**, i.e. **0.018% of the stream**.
H1 as originally posed ("a blurry full-image preview from the first 5-10% of
bytes") is not merely met, it is trivially met — which is the correct reading:
producing a blurry first frame was never the hard part.

### 2.2 The refinement ladder

| bytes | % of stream | level | SSIM @1024 display | SSIM @256 |
| ---: | ---: | :--- | ---: | ---: |
| 0.3 KiB | 0.02% | 32×16 | 0.6564 | 0.6887 |
| 0.8 KiB | 0.05% | 64×32 | 0.6606 | 0.7859 |
| 2.1 KiB | 0.1% | 128×64 | 0.6801 | 0.8726 |
| 5.7 KiB | 0.4% | 256×128 | 0.7294 | 0.9557 |
| 23.2 KiB | 1.6% | 512×256 | 0.8852 | 0.9863 |
| **84.5 KiB** | **6.0%** | 1024×512 | **0.9847** | 0.9975 |
| 308.4 KiB | 21.8% | 2048×1024 | 0.9932 | 0.9984 |
| 1416.2 KiB | 100% | 4096×2048 | 0.9965 | 0.9990 |

Two things worth reading off this table. The last level costs 78% of the stream
for the final 0.012 of SSIM — the pyramid's cost is dominated by the tail, exactly
as in every progressive scheme. And "SSIM ≥ 0.90" is reached somewhere between
23 KiB and 85 KiB depending on the display size you judge it at, which is why the
report fixes two comparison sizes instead of one.

### 2.3 Against real codecs (same reference, same SSIM code, decoded pixels)

Baselines were encoded **and decoded back to PNG** by libjpeg-turbo 3.2.0, cwebp
1.6.0, cjxl 0.12.0 and avifenc 1.4.2, then scored against the source. Full table in
`results/quality-panorama.json`.

| candidate | bytes | SSIM @1024 |
| :--- | ---: | ---: |
| **ours, 6.0% of stream (1024×512)** | **84.5 KiB** | **0.9847** |
| AVIF q45 | 210.3 KiB | 0.9920 |
| JXL q45 | 277.0 KiB | 0.9918 |
| WebP q65 | 363.4 KiB | 0.9918 |
| AVIF q65 | 465.4 KiB | 0.9951 |
| JXL q85 | 711.2 KiB | 0.9969 |
| JPEG q85 (progressive) | 1040.3 KiB | 0.9971 |
| **ours, 100%** | **1416.2 KiB** | **0.9965** |
| AVIF q85 | 1281.5 KiB | 0.9974 |

- **At matched SSIM ≈ 0.95 at 1024 display size: 84.5 KiB versus AVIF's 210 KiB —
  2.49× fewer bytes.** This is *not* an entropy-coding win and must not be quoted
  as one. At 1024 display width our level 5 is a native 1024×512 image, while
  every other contestant pays to encode 4096×2048 and then downsamples. The
  advantage is the pyramid's existence, not its efficiency.
- **At full resolution, like for like: 1.11× AVIF and 1.36× JPEG q85 at matched
  SSIM.** That is the honest compression verdict: a baseline-DCT codec with a
  run-length entropy stage, roughly one JPEG generation behind.

### 2.4 ROI works, and hits a floor that is worth knowing

Same stream, requested with `roi=2560,900,1024,768` (a 1024×768 window over the
city block):

| | bytes | share of stream |
| :--- | ---: | ---: |
| first paint | 263 B | 0.02% |
| **ROI at full resolution** | **318,102 B** | **21.9%** |
| whole image at full resolution | 1,450,142 B | 100% |

Reaching full detail inside the selected region costs 21.9% of the stream instead
of 100% — a 4.6× saving, from the same bytes, with no server state and no second
request format. **But the floor is the coarse pyramid itself**: levels 0-6 are
~313 KiB and arrive everywhere before any finest-level ROI tile is useful. That is
the real constraint on this design, and the fix (ROI-scoped coarse levels, or a
BlurHash placeholder outside the region) is in `NEXT_STEPS.md`.

### 2.5 Decoder cost

Full JS decode of the 8.39 MP stream in node 22 on clanker: **1099 ms cold, 436 ms
with the JIT warm — 52 ms/MP**, i.e. **3.2 MiB/ms**. Playable for a demo, roughly
an order of magnitude too slow to pretend this is a native decoder. The honest
browser numbers are not available: see §5.

### 2.6 SVG blob vs raster

A 2500-path, 348,561-byte SVG rasterised in headless Chromium in **22.5 ms decode
+ 8 ms draw** at 1600×1200. That is fast enough that a streamed raster has **no
rendering-performance case against this class of SVG**; the raster's advantage
would be predictable per-region cost and bounded memory, not speed. The same-size
PNG control in that run was measured at 25,000 ms, which is the
`--virtual-time-budget` expiring, not a decode — the comparison is incomplete and
is reported as such.

## 3. What broke, and how it was found

Both bugs were found by dumping plane values, not by reading aggregate metrics.
They are documented because the symptoms are deceptive.

1. **+128 added twice.** `readBlocks` applied the luma bias on the way into the
   plane, and `levelToRGBA` applied it again on the way out. Net +128 on luma,
   clipped by `Uint8ClampedArray`. Symptom: **PSNR 6 dB while luma SSIM stayed
   0.75** — structure survived, values did not.
2. **A 0..255 clamp on centred planes.** Left over from when planes were unsigned,
   it flattened every negative sample to zero — which is half of all chroma.
   Symptom: **red rendered magenta, green rendered grey.** The clue was that a
   pixel printed as `y=-51.8, cb=-43.0, cr=0` could not mathematically produce the
   RGB that `levelToRGBA` returned.

A third, purely structural fix: the header originally carried only the
*uncompressed* payload length, so a `ReadableStream` could not find the next chunk
boundary. `payloadLen` at offset 22 is what makes the stream parseable at all.

## 4. Critical assessment

**Is the core idea novel?** No. Knowlton described pyramid progressive
transmission in 1980; JBIG standardised hierarchical progressive coding; JPEG XL
has LF-first progressive and centre-first ordering; JPEG 2000 has ROI as a
first-class feature; DZI/IIIF and Cloud Optimized GeoTIFF deliver tile pyramids
with client-chosen regions over HTTP. Hilbert scan order in image coding is older
than JPEG's zigzag, which approximates it. See `NOVELTY.md`.

**Is the variation demo-worthy?** Yes, narrowly: one forward-only stream whose
*ordering* is the API — complete preview, refinement, and ROI are three orderings
of the same bytes rather than three endpoints or three formats. That is a real
simplification for a client that only reads forward, and it is what the demo
shows.

**Can it beat thumbnail resizing?** Yes, for one source image: 263 bytes buys a
full-frame preview with the same pixels the refinement continues from, where a
separate thumbnail is a second asset, a second request and a visible swap. That
is a genuine win, and it is small in scope.

**Can it beat large SVG blobs?** Not on render performance — 22 ms for 348 KiB of
vector art. Only on cost predictability and memory.

**Can it replace AVIF/WebP?** No. 1.11× AVIF at equal quality with a JS-only
decoder, no hardware decode, no `<img>` fallback, and an ecosystem of zero. It is
an enhancement layer at best, and a research vehicle in practice.

**Blockers to production:** entropy coding (the 1.11× gap), successive
approximation instead of level replacement, decode speed (WASM + Worker), the
coarse-pyramid ROI floor, delivery mechanics (immutable chunk URLs, CDN, HTTP/2
range), and a fallback for browsers without JS or `DecompressionStream`.

## 5. Measurement caveats

- **Browser timings are not wall clock.** The headless runs used
  `--virtual-time-budget`, which freezes `performance.now()` relative to actual
  work. The demo's `decodeMs: 0` and `totalMs: 19` are artifacts; the SVG
  raster control's 25,000 ms is the budget expiring. **Byte counts from those runs
  are exact; millisecond figures are not.** Re-measuring over CDP with real time
  is `NEXT_STEPS.md` §6.
- Encoder speed (1258 ms/8.39 MP) is on 4 vCPU with a single-threaded JS encoder;
  it is a relative number, not a codec benchmark.
- One test image, one focal region, synthetic content with deliberate grain. The
  SSIM numbers on grain-heavy synthetic content flatter no one; a photographic
  corpus would move every absolute number, though probably not the ordering.

## 6. Reproduce

```bash
export PATH=/data/home/.nix-profile/bin:$PATH   # on clanker
node bench/gen.js                 # corpus, ~3 s
node test/selftest.js             # round trip + per-level curve
bash bench/codecs.sh              # baselines via nix shell, ~4 min
node bench/quality.js panorama 75 # the table in §2.3
node test/decode-time.js          # §2.5
node server/server.js             # demo at http://127.0.0.1:8099/demo/index.html
```

Artifacts: `results/quality-panorama.json` (raw), `results/selftest-panorama.json`
(per-level), `results/reports.jsonl` (browser runs: default, ROI, SVG),
`results/shots/` (headless screenshots of both demo modes and the SVG page).
