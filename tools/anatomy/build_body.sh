#!/usr/bin/env bash
# Reproducible build of frontend/public/models/body.glb (+ body_anchors.json) from Z-Anatomy.
#
# Requirements: git, Blender >= 4.0 with python3-numpy (apt-get install -y blender python3-numpy),
#               Node >= 18 (npm install in this folder for @gltf-transform/cli).
# Env:  WORK=<scratch dir for the ~230 MB FBX download>   (default: ./.work)
#       KEEP_RAW=1 to keep the downloaded FBX files afterwards
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/frontend/public/models"
WORK="${WORK:-$HERE/.work}"
ZA_REPO="https://github.com/LluisV/Z-Anatomy.git"
ZA_REF="${ZA_REF:-PC-Version}"      # default branch at time of writing
mkdir -p "$WORK" "$OUT"

# 1. Fetch only Resources/Models/FBX from Z-Anatomy (partial + sparse clone)
if [ ! -f "$WORK/za/Resources/Models/FBX/VisceralSystem100.fbx" ]; then
  rm -rf "$WORK/za"
  git clone --depth 1 --branch "$ZA_REF" --filter=blob:none --no-checkout "$ZA_REPO" "$WORK/za"
  git -C "$WORK/za" sparse-checkout init --no-cone
  git -C "$WORK/za" sparse-checkout set '/Resources/Models/*'
  git -C "$WORK/za" checkout "$ZA_REF"
fi
git -C "$WORK/za" rev-parse HEAD > "$WORK/za_commit.txt"
echo "Z-Anatomy commit: $(cat "$WORK/za_commit.txt")"

# 2. Blender: select / merge / decimate / normalise / compute anchors / export raw GLB
blender -b --python-exit-code 1 -P "$HERE/build_body.py" -- \
  "$WORK/za/Resources/Models/FBX" "$WORK/body_raw.glb" "$OUT/body_anchors.json"

# 3. gltf-transform: KHR_mesh_quantization (no decoder needed in three.js) -> body.glb
#    plus an optional EXT_meshopt_compression variant (needs MeshoptDecoder; drei's useGLTF has it)
[ -d "$HERE/node_modules/@gltf-transform/cli" ] || (cd "$HERE" && npm install --no-audit --no-fund)
GT="$HERE/node_modules/.bin/gltf-transform"
"$GT" quantize "$WORK/body_raw.glb" "$OUT/body.glb" --quantize-position 14 --quantize-normal 10
"$GT" meshopt "$WORK/body_raw.glb" "$OUT/body.meshopt.glb"

# 4. Verify
node "$HERE/verify_body.mjs" "$OUT/body.glb"
ls -la "$OUT"

[ "${KEEP_RAW:-0}" = "1" ] || rm -rf "$WORK/za" "$WORK/body_raw.glb"
