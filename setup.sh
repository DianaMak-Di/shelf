#!/usr/bin/env bash
# One-time setup: checks python3, node, ffmpeg, then installs Python and UI dependencies and builds the UI.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname)" = "Darwin" ] || { echo "macOS only (OCR uses Apple Vision via ocrmac)"; exit 1; }
for c in python3 node npm ffmpeg; do
  command -v "$c" >/dev/null || { echo "missing: $c (brew install ${c/npm/node})"; exit 1; }
done
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
(cd ui && npm install --silent)
.venv/bin/python reels.py build
[ -f config.json ] || cp config.example.json config.json
[ -f urls.txt ] || touch urls.txt
echo "Done. Start:  .venv/bin/python server.py   ->  http://localhost:8765"
