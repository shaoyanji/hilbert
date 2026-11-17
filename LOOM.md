# The loom bridge

`tokenloom` writes pixels in this repo's curve order, and this repo renders them.
That is the whole contract. It exists because a tokenizer emits a one-dimensional
stream and so does a file of image bytes, and the only interesting question is
which order reads them — so the two projects agree on the curve and nothing else.

## What crosses the boundary

A `.himg` file: one ASCII header line, then the pixels in curve order, unaltered.

```
LOOMHILB 1 order=7 layout=rgb8 len=49152 fnv=3f2a91c7
<49152 bytes, pixel d2xy(128, d) at byte offset d × 3>
```

`order` is the curve order, so the image is `2^order` on a side. `layout` is
`gray8`, `rgb8` or `rgba8`. `len` must be `4^order × lanes`, and `fnv` is FNV-1a
over the payload, which is how a truncated stream stops looking like a canvas.
A text form carries the same bytes as hex under the same header, because a
tokenizer can emit text and cannot emit a binary channel.

There is no compression, no pyramid and no chunk headers here. This is the raw
pixel plane in Hilbert order — a bridge for reasoning about where a byte lands,
not a delivery format. For delivery, this repo's own `.hs` stream is the one with
a pyramid and an entropy stage.

## Why the order is the interesting part

- Consecutive bytes are neighbouring pixels, so the picture keeps the stream's
  locality: a repeated word becomes a patch rather than scattered dots.
- A span of bytes is a set of pixels whose bounding box is exact and cheap. The
  curve tiles any span into aligned squares (`4^k` indices starting at a multiple
  of `4^k` fill one square of side `2^k`), so the hull of those squares is the
  hull of the pixels, in `O(order)` — no scan, no approximation.
- Because the map is a bijection, "which pixels did these tokens move" has one
  answer, and a variation can be *checked* against the range it declared rather
  than trusted.

Ranges are what the writer reasons in: a tokenizer range is a byte range, a byte
range is a span, a span is a hull. `loom-cli hilbert --span 7 15360 1024` prints
the decomposition and both the fast bounds and the enumerated ones, which is how
the fast path is checked:

```
node test/loom-parity.js /path/to/loom-cli
```

## Curve parity

`test/loom-parity.js` runs the Rust writer's table for orders 1–7 and compares
every cell against `lib/hilbert.js`, forwards and backwards. Last run on a 4-core
box:

```
order 1: 4 cells agree      order 5: 1024 cells agree
order 2: 16 cells agree     order 6: 4096 cells agree
order 3: 64 cells agree     order 7: 16384 cells agree
order 4: 256 cells agree
21844 cells agree in both directions, 0 disagreements
```

## Rendering one

```
node tools/loom-himg.js path/to/source.himg out/
```

Reads the header, verifies the checksum, walks the curve with `lib/hilbert.js`
and encodes the result with `lib/png.js`. Because the walk is this repo's, a
disagreement about the curve shows up as a scrambled picture; the parity test is
what turns that into a number.

A 128×128 `rgb8` canvas renders in 17.6–21.5 kB of PNG across the six variations
tokenloom writes from the same text, from a 49,152-byte payload.

## What is *not* claimed

The image is the tokenizer's bytes at the positions the curve gives them. It is
not a rendering of meaning, nothing is trained, and PSNR between two canvases
says how far a variation moved the bytes — not how good either picture is. The
useful property is that every claim about a range is arithmetic you can re-run.
