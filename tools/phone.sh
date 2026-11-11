#!/usr/bin/env bash
# Serve the app to the phone as http://localhost:8765 over adb (a secure origin: camera, service worker and
# PWA install all work without HTTPS) and open it in Chrome.
#   tools/phone.sh [device]      e.g. tools/phone.sh 192.168.1.19:45065 (adb connect first for wireless debugging)
set -euo pipefail
cd "$(dirname "$0")/.."
DEV=${1:+-s $1}
[ -d vendor/mediapipe ] || ./tools/fetch-vendor.sh
if ! curl -fs -o /dev/null http://localhost:8765/; then
  echo "starting the dev server on :8765"
  (python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &)
  sleep 1
fi
adb $DEV reverse tcp:8765 tcp:8765
adb $DEV shell am start -a android.intent.action.VIEW -d "http://localhost:8765/" com.android.chrome >/dev/null
echo "open on the phone: http://localhost:8765  (Chrome menu → Install app, or the Install button)"
