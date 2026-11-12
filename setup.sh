#!/usr/bin/env bash
# One-time setup: checks Python 3.11-3.13, node, ffmpeg, then installs Python and UI dependencies and builds the UI.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname)" = "Darwin" ] || { echo "macOS only (OCR uses Apple Vision via ocrmac)"; exit 1; }
for c in node npm ffmpeg; do
  command -v "$c" >/dev/null || { echo "missing: $c (brew install ${c/npm/node})"; exit 1; }
done
# onnxruntime (via faster-whisper) has no wheels for the newest Python: take the first supported one
PY=""
for v in 3.13 3.12 3.11; do command -v "python$v" >/dev/null && { PY="python$v"; break; }; done
[ -n "$PY" ] || { echo "Python 3.11-3.13 not found (brew install python@3.13)"; exit 1; }
"$PY" -m venv .venv
.venv/bin/pip install -q -r requirements.txt
(cd ui && npm install --silent)
.venv/bin/python reels.py build
[ -f config.json ] || cp config.example.json config.json
[ -f urls.txt ] || touch urls.txt
echo "Done. Start:  .venv/bin/python server.py   ->  http://localhost:8765"
