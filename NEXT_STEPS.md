# Next steps

Ordered by value per unit of work, measured against what the prototype actually
lost on in `REPORT.md`.

## 1. Fix the bit allocation (largest quality-per-byte win)

The prototype transmits every level at one quality, so 78% of its bytes go to the
finest level and the coarse levels are wastefully precise. Two changes:

- **Successive approximation** (bitplanes over quantised coefficients) instead of
  "each level replaces its parent". This is what progressive JPEG and JXL do, and
  it removes the pyramid's 4/3 pixel overhead.
- **DC prediction** across tiles in Hilbert order, and a **per-level quantiser**
  that spends on coarse levels only what the display needs. The pyramid should
  cost ~10 KiB before refinement, not 84 KiB before it looks good.

## 2. Replace the entropy stage

Zero-run + `deflate` per tile is a placeholder. A range coder over the
Hilbert-ordered coefficient stream, with context modelling on neighbour tiles,
is where the 1.11x-AVIF gap closes. This is also the piece that makes the format
non-trivial to reimplement, which is why it was left out of the prototype.

## 3. ROI that reaches below the top of the pyramid

Measured limit, and the most interesting negative result: ROI full detail landed
at **318 KiB of 1450 KiB (21.9%)**, because the coarse pyramid for the *whole*
image (~313 KiB) must arrive before any finest-level tile is useful. Options:

- Let the client declare the ROI before level 0 and send only the ROI's coarse
  tiles, with the rest of the image staying at a placeholder or BlurHash.
- Two-tier ROI: full resolution inside the rectangle, one level down outside it.
- Predict the ROI from viewport and pointer position so it is set before the
  first byte is requested — the only version that helps first paint.

## 4. Decode cost

Pure-JS IDCT over 393k blocks per 8.4 MP frame is the ceiling. A production
decoder wants a WASM IDCT, decode in a Worker (never on the main thread), and
`ImageBitmap` transfer instead of `putImageData`. Worth doing only after (1)
shrinks the chunk count.

## 5. Delivery mechanics

- Immutable chunk-addressed URLs with strong ETags, so a CDN can cache the
  coarse prefix separately from the tail.
- One HTTP response per priority policy is right for a demo; production wants
  HTTP/2 or /3 range requests against one resource, with `Priority` hints.
- A `<picture>`-style fallback to AVIF when JS or `DecompressionStream` is
  missing. Without it this can only ever be an enhancement, not an image format.

## 6. Measurement that is not virtual time

The browser numbers in `RESULTS` come from headless Chromium under
`--virtual-time-budget`, which freezes `performance.now()` relative to real work.
Before any claim about paint cost, re-measure over CDP with real time, throttled
network profiles, and `PerformanceObserver` long tasks. The byte counts in the
report are exact; the millisecond figures from the browser are not.

## 7. Things not worth doing

- A new image format, or a standards proposal. See `NOVELTY.md`.
- Beating AVIF on compression. It will not, and that is not the interesting axis.
- Rasterising huge SVGs as a use case: the SVG in the corpus rasterises in ~22 ms
  for 348 KiB, so a streamed raster is not obviously better there — it is a
  different trade (predictable per-region cost vs resolution independence).
