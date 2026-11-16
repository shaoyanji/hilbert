# Novelty

Short answer: **the idea is not novel, and the demonstration should not claim it
is.** What is defensible is a narrow combination, spelled out at the end.

## Prior art

| Prior art | What it already does | Overlap with this prototype |
| :--- | :--- | :--- |
| Knowlton (1980), *Progressive transmission of grey-scale and binary pictures by simple, efficient, and lossless encoding schemes* | Pyramid of successively refined images transmitted low-resolution first | **Same core mechanism.** Level 0 = whole image, later levels refine. This is the prototype's architecture, 45 years earlier. |
| Sloan & Tanimoto (1979), hierarchical image transmission | Coarse-to-fine with a resolution pyramid | Same |
| JBIG / JBIG2 (ITU-T T.82, T.88) | Hierarchical progressive coding with resolution reduction | Same idea, standardised, plus real entropy coding |
| Progressive JPEG (spectral selection + successive approximation) | Refinement in place, blurs to sharp | Same user-visible effect; strictly better bit allocation |
| JPEG XL (`cjxl`) | LF-first progressive, `--progressive`, centre-first ordering for ROI | Same effect, plus a far better entropy coder |
| AVIF layered / progressive | Progressive decode via layers | Same |
| JPEG 2000 (tiling, precincts, ROI maxshift) | Region-of-interest prioritisation as a *first-class* codec feature | **The ROI hypothesis is JPEG 2000's feature set.** A prototype with one ROI rectangle is a crude subset |
| Deep Zoom / DZI, IIIF Image API | Tile pyramid over HTTP: client requests the levels and tiles it wants | Same pyramid, same ROI, but per-tile requests instead of one ordered stream |
| Cloud Optimized GeoTIFF + HTTP range requests | Tiled raster + overviews, client fetches only the bytes for its window | The production form of ROI-on-demand |
| Space-filling curves in image coding (Peano/Hilbert scan order; Stevens, Lehar & Preston 1983) | Hilbert traversal to exploit 2D locality in a 1D stream | **Hilbert ordering is old.** JPEG's zigzag is itself an approximation of one |
| BlurHash / ThumbHash | Tiny perceptual placeholder, not refinable | Solves the same "show something instantly" problem at 20-30 bytes, much better than level 0 costs |

## What is actually left

Four things this prototype does that the list above does not do *together*:

1. **One forward-only binary stream, ordered by priority**, rather than one HTTP
   request per tile (DZI/IIIF/COG) or a container the client must parse with a
   native codec. A client that only ever reads forward still gets a complete
   image, then refinement, then a chosen region.
2. **Hilbert order inside a level** so that "the next bytes" refine pixels near
   the last ones — a locality guarantee that raster-order tiles do not give and
   that matters when bandwidth is the constraint rather than latency.
3. **ROI expressed as a reordering of the same stream**, with no separate
   endpoint, no re-encode, and no server-side session state. The client asks for
   the same resource with a rectangle.
4. **Decodable in JavaScript with no native codec and no WASM**, so the decoder
   can be instrumented and steered per chunk — which is what makes adaptive
   priority policies testable at all.

That is a **demo-worthy composition**, not an invention. A defensible one-line
claim:

> A single-request, forward-only raster stream whose chunk order is a
> hierarchical Hilbert traversal, so that a complete preview, progressive
> refinement, and a client-chosen region of interest are three orderings of the
> same bytes rather than three delivery mechanisms.

## What cannot be claimed

- Not "progressive Hilbert coding" — Knowlton, JBIG and JPEG XL own that ground.
- Not "ROI streaming" — JPEG 2000 and COG own that.
- Not a compression advance: at full quality it lands at 1.11x AVIF and 1.36x
  JPEG at matched SSIM (`REPORT.md`), because it keeps a baseline DCT and a
  crude run-length entropy stage.
- Not a standards candidate. There is no path from a JS decoder to browser
  support that does not run through a real codec's entropy coding and a
  conformance suite.
