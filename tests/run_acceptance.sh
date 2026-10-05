#!/usr/bin/env bash
# Runs the MVP acceptance suite: several people, each a full client, against the REAL agora-sync server.
# Needs: node (for the server), python3, Chrome/Chromium. Run `npm install` in server/agora-sync once.
set -u
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "node not found (needed to run the sync server)" >&2; exit 2; }
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[ -n "$CHROME" ] || { echo "Chrome/Chromium not found (set CHROME=...)" >&2; exit 2; }
[ -d server/agora-sync/node_modules ] || (cd server/agora-sync && npm install --no-audit --no-fund >/dev/null 2>&1) || { echo "npm install failed in server/agora-sync" >&2; exit 2; }

SYNC_PORT="${SYNC_PORT:-8788}"
WEB_PORT="${WEB_PORT:-8789}"
DEBUG_PORT="${DEBUG_PORT:-9336}"
DATA=$(mktemp -d)
PROFILE=$(mktemp -d)

AGORA_DEV_AUTH=1 DATA_DIR="$DATA" PORT="$SYNC_PORT" node server/agora-sync/src/index.js >/dev/null 2>&1 &
SYNC=$!
python3 -m http.server "$WEB_PORT" >/dev/null 2>&1 &
WEB=$!
"$CHROME" --headless=new --no-sandbox --disable-gpu --user-data-dir="$PROFILE" --remote-debugging-port="$DEBUG_PORT" \
    "http://localhost:$WEB_PORT/tests/acceptance/?sync=http://localhost:$SYNC_PORT" >/dev/null 2>&1 &
BROWSER=$!
trap 'kill $SYNC $WEB $BROWSER 2>/dev/null; rm -rf "$DATA" "$PROFILE"' EXIT

for _ in $(seq 1 100); do curl -s "http://localhost:$SYNC_PORT/health" >/dev/null && break; sleep 0.2; done

TITLE=""
for _ in $(seq 1 360); do
    TITLE=$(curl -s "http://localhost:$DEBUG_PORT/json" 2>/dev/null | python3 -c '
import sys, json
try:
    for t in json.load(sys.stdin):
        if "/tests/acceptance/" in t.get("url", "") and t["title"].split(" ")[0] in ("PASS", "FAIL"):
            print(t["title"]); break
except Exception:
    pass')
    [ -n "$TITLE" ] && break
    sleep 0.5
done

[ -n "$TITLE" ] || { echo "Timed out: the acceptance suite never finished" >&2; exit 1; }
echo "$TITLE" | sed 's/ ## /\n/;s/ ; /\n/g;s/ | /\n  failing: /;s/ || /\n  failing: /g'
[ "${TITLE%% *}" = "PASS" ]
