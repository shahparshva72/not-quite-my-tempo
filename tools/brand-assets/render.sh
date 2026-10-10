#!/usr/bin/env bash
# Renders the link preview and icons in apps/api/public with headless
# Chrome. Run from anywhere after changing og.html or icon.html, then
# commit the PNGs. Needs Google Chrome and network access for the fonts.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../apps/api/public"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

shot() {
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --virtual-time-budget=5000 --window-size="$2" \
    --screenshot="$3" "file://$here/$1" 2>/dev/null
}

shot og.html 1200,630 "$out/og.png"
# Chrome won't make a window smaller than about 500px, so icons are
# rendered at 512 and scaled down with sips (macOS).
shot icon.html 512,512 "$out/icon-512.png"
shot "icon.html#square" 512,512 "$out/apple-touch-icon.png"
sips -z 180 180 "$out/apple-touch-icon.png" >/dev/null
sips -z 32 32 "$out/icon-512.png" --out "$out/favicon-32.png" >/dev/null

# favicon.ico: one 32×32 PNG in an ICO container.
python3 - "$out/favicon-32.png" "$out/favicon.ico" <<'PY'
import struct, sys
png = open(sys.argv[1], "rb").read()
header = struct.pack("<HHH", 0, 1, 1)
entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png), 22)
open(sys.argv[2], "wb").write(header + entry + png)
PY
rm "$out/favicon-32.png"
