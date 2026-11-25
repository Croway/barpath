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
  curl -fsSL --connect-timeout 15 --max-time 180 --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
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

# The squat-bottom pass downloads these assets on first use. Versioned paths keep
# the service worker from mixing a new runtime with previously cached WASM.
ORT=1.31.1
RTDIR="vendor/rtmpose-m-384-ort-$ORT"
mkdir -p "$RTDIR"
for f in ort.webgpu.min.mjs ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  get "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT/dist/$f" "$RTDIR/$f"
done
get "https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v$ORT/LICENSE" "$RTDIR/ONNXRuntime-LICENSE"
get "https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v$ORT/ThirdPartyNotices.txt" "$RTDIR/ThirdPartyNotices.txt"
get "https://raw.githubusercontent.com/open-mmlab/mmpose/v1.3.2/LICENSE" "$RTDIR/MMPose-LICENSE"
model=rtmpose-m_simcc-body7_pt-body7_420e-384x288-65e718c4_20230504
digest=a4c4f6fd983c0be353042a7a6b3845b0894ada22b8c02964373554afcdcd6e8e
valid_model() { echo "$digest  $1" | shasum -a 256 -c - >/dev/null 2>&1; }
if ! valid_model "$RTDIR/model.onnx"; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  get "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/$model.zip" "$tmp/model.zip"
  unzip -p "$tmp/model.zip" "*/$model/end2end.onnx" > "$tmp/model.onnx"
  valid_model "$tmp/model.onnx"
  mv "$tmp/model.onnx" "$RTDIR/model.onnx"
fi
