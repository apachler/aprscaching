#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# build.sh — compiles src/glue.c and the vendored Direwolf sources to WebAssembly, twice: wasm/direwolf-simd.wasm
# with 128-bit SIMD and wasm/direwolf.wasm without it, plus the one ES-module loader both share (wasm/direwolf.mjs). The outputs are committed, so contributors and CI jobs
# without Emscripten use them as they are; CI rebuilds them with the pinned Emscripten and fails on a
# difference (.github/workflows/ci.yml, `Direwolf WebAssembly`).
#
#   modems/direwolf/build.sh            # both WebAssembly builds (needs emcc EMSDK_VERSION on PATH, or EMCC=…)
#   modems/direwolf/build.sh native     # a native ./build/glue for cross-checks (gcc), not committed
#
# The flags are Direwolf's own (-O3 -ffast-math). -ffile-prefix-map keeps the checkout's path out of the
# binary, so two checkouts build the same bytes.
set -euo pipefail

EMSDK_VERSION=6.0.12
HERE=$(cd "$(dirname "$0")" && pwd)
DW="$HERE/vendor/direwolf/src"
SRCS=(
  demod.c demod_afsk.c demod_psk.c demod_9600.c dsp.c multi_modem.c rrbb.c
  hdlc_rec.c hdlc_rec2.c hdlc_send.c gen_tone.c fcs_calc.c
  fx25_init.c fx25_encode.c fx25_extract.c fx25_rec.c fx25_send.c
  il2p_init.c il2p_codec.c il2p_scramble.c il2p_header.c il2p_payload.c il2p_rec.c il2p_send.c
  ax25_pad.c ax25_pad2.c dtime_now.c
)
FILES=("$HERE/src/glue.c")
for f in "${SRCS[@]}"; do FILES+=("$DW/$f"); done
DEFS=(-DMAJOR_VERSION=1 -DMINOR_VERSION=8 -D_GNU_SOURCE -DHAVE_STRLCPY -DHAVE_STRLCAT -DNDEBUG "-I$DW")

if [ "${1:-wasm}" = native ]; then
  mkdir -p "$HERE/build"
  gcc -O3 -ffast-math "${DEFS[@]}" -DDW_MAIN -o "$HERE/build/glue" "${FILES[@]}" -lm
  exit 0
fi

EMCC=${EMCC:-emcc}
have=$("$EMCC" --version | head -n 1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/')
if [ "$have" != "$EMSDK_VERSION" ]; then
  echo "build.sh: Emscripten $EMSDK_VERSION is pinned; $EMCC is $have" >&2
  exit 1
fi

EXPORTS=_dwrx_init,_dwrx_push,_dwrx_out_ptr,_dwrx_out_clear,_dwrx_dcd,_dwtx_init,_dwtx_modulate,_dwtx_out_ptr,_dw_in_ptr,_dw_in_cap,_malloc,_free
build() {
  local out=$1
  shift
  "$EMCC" -O3 -ffast-math "$@" "${DEFS[@]}" "-ffile-prefix-map=$HERE=." "${FILES[@]}" -o "$out" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4MB \
    -sFILESYSTEM=0 -sEXPORTED_FUNCTIONS=$EXPORTS -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,stringToNewUTF8
}
mkdir -p "$HERE/wasm"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
build "$HERE/wasm/direwolf.mjs"
build "$tmp/direwolf-simd.mjs" -msimd128
# One loader serves both builds (the package hands it the module): the SIMD build's loader may differ only in
# the file name it would look for.
if ! sed 's/direwolf-simd\.wasm/direwolf.wasm/g' "$tmp/direwolf-simd.mjs" | cmp -s - "$HERE/wasm/direwolf.mjs"; then
  echo "build.sh: the SIMD and plain loaders differ beyond the file name" >&2
  exit 1
fi
mv "$tmp/direwolf-simd.wasm" "$HERE/wasm/direwolf-simd.wasm"
