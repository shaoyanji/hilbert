#!/usr/bin/env bash
# Baseline corpus: encode the test image with each real codec at several
# qualities, then decode it back to PNG so the comparison measures the *decoded*
# pixels rather than trusting an encoder's own quality knob. Everything runs in
# one nix shell so the eval cost is paid once.
#
#   bash bench/codecs.sh                 # panorama, qualities 45 65 85
#   IMAGES="panorama grid" QUALITIES="65" bash bench/codecs.sh
#
# Exit: 0 ok · 1 a codec failed (the message says which).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGES="${IMAGES:-panorama}"
QUALITIES="${QUALITIES:-45 65 85}"

CMD="set -euo pipefail
for img in $IMAGES; do
  for q in $QUALITIES; do
    magick out/\$img.png -interlace Plane -quality \$q out/\$img-q\$q-jpeg.jpg
    magick out/\$img-q\$q-jpeg.jpg out/\$img-q\$q-jpeg-decoded.png

    cwebp -quiet -q \$q out/\$img.png -o out/\$img-q\$q-webp.webp
    dwebp -quiet out/\$img-q\$q-webp.webp -o out/\$img-q\$q-webp-decoded.png

    cjxl -q \$q -e 4 --quiet out/\$img.png out/\$img-q\$q-jxl.jxl
    djxl --quiet out/\$img-q\$q-jxl.jxl out/\$img-q\$q-jxl-decoded.png

    avifenc --speed 8 -q \$q out/\$img.png out/\$img-q\$q-avif.avif >/dev/null 2>&1
    avifdec out/\$img-q\$q-avif.avif out/\$img-q\$q-avif-decoded.png >/dev/null 2>&1

    printf '%s q%s done\n' \"\$img\" \"\$q\"
  done
done
# Raster control for the SVG comparison, so vector-vs-raster has a same-size
# raster to be measured against.
magick out/blob.svg out/blob-raster.png
ls -l out/*.jpg out/*.webp out/*.jxl out/*.avif | awk '{printf \"%10d  %s\n\", \$5, \$9}'"

nix shell nixpkgs#imagemagick nixpkgs#libwebp nixpkgs#libjxl nixpkgs#libavif -c bash -c "$CMD"
