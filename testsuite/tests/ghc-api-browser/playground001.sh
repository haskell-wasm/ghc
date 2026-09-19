#!/usr/bin/env bash

set -euo pipefail

# also set this when building wasm32-wasi-ghc for production
# deployment of haskell playground, so all the .so files are
# optimized.
export WASM_SO_OPT="--debuginfo --low-memory-unused --strip-dwarf -Oz"

# we'll build a rootfs tarball that contains everything in tmp and
# extracts to /tmp, mapped from here
PLAYGROUND_TMP=$(mktemp -d)
trap 'rm -rf "$PLAYGROUND_TMP"' EXIT
mkdir "$PLAYGROUND_TMP/tmp"

$TEST_HC \
  -v0 \
  -package ghc \
  -shared -dynamic \
  -no-keep-hi-files -no-keep-o-files \
  -O2 \
  playground001.hs -o "$PLAYGROUND_TMP/tmp/libplayground001.so"
rm -f ./playground001_stub.h

# /tmp/clib contains libc/libc++ .so files
cp -r "$(dirname "$TEST_CC")/../share/wasi-sysroot/lib/wasm32-wasi" "$PLAYGROUND_TMP/tmp/clib"
# trim unneeded stuff in c libdir
find "$PLAYGROUND_TMP/tmp/clib" -type f ! -name "*.so" -delete
rm -f \
  "$PLAYGROUND_TMP/tmp/clib"/libsetjmp.so \
  "$PLAYGROUND_TMP/tmp/clib"/libwasi-emulated-*.so

# /tmp/hslib/lib is the ghc libdir
mkdir "$PLAYGROUND_TMP/tmp/hslib"
cp -r "$($TEST_HC --print-libdir)" "$PLAYGROUND_TMP/tmp/hslib/lib"
# unregister Cabal/Cabal-syntax, too big
$GHC_PKG --no-user-package-db --global-package-db="$PLAYGROUND_TMP/tmp/hslib/lib"/package.conf.d unregister Cabal Cabal-syntax
for PLAYGROUND_CXX_CONF in "$PLAYGROUND_TMP/tmp/hslib/lib"/package.conf.d/system-cxx-std-lib-*.conf; do
  [[ -f "$PLAYGROUND_CXX_CONF" ]] || continue
  awk '
    /^[^[:space:]]/ { skip = 0 }
    /^(library-dirs|dynamic-library-dirs|library-dirs-static):/ {
      print $1 " ${pkgroot}/../../clib"
      skip = 1
      next
    }
    !skip { print }
  ' "$PLAYGROUND_CXX_CONF" > "$PLAYGROUND_CXX_CONF.tmp"
  mv "$PLAYGROUND_CXX_CONF.tmp" "$PLAYGROUND_CXX_CONF"
done
for PLAYGROUND_CONF in "$PLAYGROUND_TMP/tmp/hslib/lib"/package.conf.d/*.conf; do
  awk '
    /^(library-dirs|dynamic-library-dirs|library-dirs-static):/ && !/\$\{pkgroot\}\/\.\.\/\.\.\/clib/ {
      print $0 " ${pkgroot}/../../clib"
      next
    }
    { print }
  ' "$PLAYGROUND_CONF" > "$PLAYGROUND_CONF.tmp"
  mv "$PLAYGROUND_CONF.tmp" "$PLAYGROUND_CONF"
done
$GHC_PKG --no-user-package-db --global-package-db="$PLAYGROUND_TMP/tmp/hslib/lib"/package.conf.d recache
# we only need non-profiling .dyn_hi/.so, trim as much as we can
find "$PLAYGROUND_TMP/tmp/hslib/lib" "(" \
  -name "*.hi" \
  -o -name "*.a" \
  -o -name "*.p_hi" \
  -o -name "libHS*_p.a" \
  -o -name "*.p_dyn_hi" \
  -o -name "libHS*_p*.so" \
  -o -name "libHSrts*_debug*.so" \
  ")" -delete
rm -rf \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/doc \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/html \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/latex \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/*.mjs \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/*.js \
  "$PLAYGROUND_TMP/tmp/hslib/lib"/*.txt
rm -rf "$PLAYGROUND_TMP"/tmp/hslib/lib/wasm32-wasi-ghc-*/*Cabal*

# also set ZSTD_NBTHREADS/ZSTD_CLEVEL when building for production
tar -C "$PLAYGROUND_TMP" -cf "$PWD/rootfs.tar.zst" --zstd tmp
rm -rf "$PLAYGROUND_TMP"
trap - EXIT

# pass puppeteer.launch() opts as json
if [[ $# -gt 0 ]]; then
  exec ./playground001.js "$1"
fi
