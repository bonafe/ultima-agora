#!/usr/bin/env bash
# Runs tools/spike-laya/browser.html in headless Chrome and prints the measurement (the page title carries the JSON).
# Needs models/laya-en-int4 (tools/baixar_modelo_laya.py). Served WITH COOP/COEP (threads); ISOLATED=0 serves without (1 thread).
# Usage: tools/spike-laya/browser.sh [query, e.g. "threads=1&limit=20"]
set -u
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[ -n "$CHROME" ] || { echo "Chrome/Chromium not found (set CHROME=...)" >&2; exit 2; }
PORT="${PORT:-8793}"; DEBUG_PORT="${DEBUG_PORT:-9336}"; PROFILE=$(mktemp -d)
if [ "${ISOLATED:-1}" = 1 ]; then tools/spike-laya/serve_isolated.py "$PORT" & SERVER=$!; else python3 -m http.server "$PORT" >/dev/null 2>&1 & SERVER=$!; fi
"$CHROME" --headless=new --no-sandbox --disable-gpu --user-data-dir="$PROFILE" --remote-debugging-port="$DEBUG_PORT" \
    "http://localhost:$PORT/tools/spike-laya/browser.html?${1:-}" >/dev/null 2>&1 & BROWSER=$!
trap 'kill $SERVER $BROWSER 2>/dev/null; rm -rf "$PROFILE"' EXIT
for _ in $(seq 1 ${WAIT:-600}); do
    TITLE=$(curl -s "http://localhost:$DEBUG_PORT/json" 2>/dev/null | python3 -c '
import sys, json
try:
    for t in json.load(sys.stdin):
        if t["title"].split(" ")[0] in ("DONE", "FAIL"): print(t["title"]); break
except Exception: pass')
    [ -n "$TITLE" ] && { echo "$TITLE"; exit 0; }
    sleep 1
done
echo "timeout" >&2; exit 1
