#!/usr/bin/env bash
# Downloads the pinned MediaPipe Tasks Vision runtime and the pose models into vendor/, so the app (and the
# offline PWA) never needs a CDN. MediaPipe is Apache-2.0; its licence is saved alongside.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=0.10.21
NPM="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}"
MODELS="https://storage.googleapis.com/mediapipe-models/pose_landmarker"
OUT=vendor/mediapipe

mkdir -p "$OUT/wasm"
get() { # url dest
  if [ -s "$2" ]; then echo "have $2"; return; fi
  echo "get  $2"
  curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}
get "$NPM/vision_bundle.mjs" "$OUT/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  get "$NPM/wasm/$f" "$OUT/wasm/$f"
done
# the npm package carries no licence file: MediaPipe (github.com/google-ai-edge/mediapipe) is Apache-2.0
[ -s "$OUT/LICENSE" ] && grep -q "Apache License" "$OUT/LICENSE" || rm -f "$OUT/LICENSE"
get "https://www.apache.org/licenses/LICENSE-2.0.txt" "$OUT/LICENSE"
get "$MODELS/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" "$OUT/pose_landmarker_lite.task"
get "$MODELS/pose_landmarker_full/float16/1/pose_landmarker_full.task" "$OUT/pose_landmarker_full.task"
echo "$VERSION" > "$OUT/VERSION"
du -sh "$OUT"
