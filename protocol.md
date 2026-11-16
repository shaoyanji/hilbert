# Protocol

A Hilbert stream is one binary response. There is no per-chunk HTTP request, no
base64, and no JSON on the pixel path: the client opens one `fetch`, reads the
body as a `ReadableStream`, and parses fixed 32-byte headers as bytes arrive.

## Levels

The image is a dyadic pyramid. Level 0 is the whole picture at thumbnail size
(≤ `baseWidth` = 48 px on the long edge); level `levels-1` is full resolution.
Level `L` has dimensions `ceil(width / 2^(levels-1-L))`.

`levels` is derived from the source: `levelCount(w, h, 48)`.

Because level 0 carries the entire image, the first kilobyte already paints a
complete, blurry picture. Every later level replaces its parent with a sharper
version of the same content, not a patch of it.

## Tiles

Each level is cut into square tiles of `groupSize` px (128 by default), aligned
to the level origin. Tiles are emitted in **Hilbert order** over the tile grid,
with the grid padded up to the next power of two and padding cells skipped. Tile
rectangles are never transmitted: both ends recompute them from
`(width, height, levels, groupSize)` — see `lib/geometry.js`.

Inside a tile: 8x8 blocks, Y at level resolution and Cb/Cr at half resolution,
quantised with the baseline JPEG tables scaled by `quality`, and entropy-coded as
zero-run/coefficient pairs, then deflated as one payload.

## Chunk header (32 bytes, little endian)

| offset | size | field |
| ---: | ---: | :--- |
| 0 | 2 | magic `0x48 0x42` (`HB`) |
| 2 | 1 | version (`1`) |
| 3 | 1 | kind (`2` = tile) |
| 4 | 4 | image id |
| 8 | 1 | level |
| 9 | 1 | flags (reserved) |
| 10 | 2 | tile width, px at this level |
| 12 | 2 | tile height |
| 14 | 2 | tile x |
| 16 | 2 | tile y |
| 18 | 4 | tile index within the level (Hilbert order) |
| 22 | 4 | payload length, compressed — **this is what frames the stream** |
| 26 | 4 | payload length, uncompressed |
| 30 | 2 | reserved |

`payloadLen` must be present for framing: a `ReadableStream` has to know where the
next header starts before it can inflate anything. A header carrying only the
uncompressed length cannot be parsed off a live stream.

## Payload (before deflate)

For each plane in Y, Cb, Cr, for each 8x8 block in row-major order within the
tile:

```
u8  nz                     number of non-zero quantised coefficients
nz x { u8 run, i16 value }  run of zeros in zigzag order, then the value
```

Coefficient order is zigzag; `nz = 0` means the block is a pure DC-equal copy of
its predicted value and costs one byte.

## Requests

`GET /api/stream?img=<name>` — default order: level 0 to `levels-1`, Hilbert
order inside each level.

`GET /api/stream?img=<name>&roi=x,y,w,h&minLevel=0` — ROI order. At every level,
tiles overlapping the rectangle are emitted first (Hilbert order preserved within
each group), then the rest. So the selected region reaches full detail after
roughly `1/levels` of the bytes it would otherwise need, while the surrounding
image stays at the previous level.

`GET /api/manifest?img=<name>` — JSON: dimensions, `levels`, `groupSize`,
`quality`, `totalBytes`, per-level byte totals, and the chunk index
(`{o, l, L, t, x, y, w, h}`) used to compute byte budgets and to draw a waterfall.

## Client decode state

A decoder holds three planes per touched level. Applying a chunk rewrites one
tile rectangle and reports it, so the client repaints that rect instead of the
whole canvas. A level's canvas is initialised by upscaling the level above it,
which is what makes the picture look like it sharpens rather than tiles in.

## What this protocol does not do

No progressive *coefficient* bitplanes (progressive JPEG and JXL do, and are
better at it), no DC prediction across tiles, no perceptual quantisation, no
per-tile quality adaptation, no ROI that spans levels. Those are the obvious
next steps; see `NEXT_STEPS.md`.
