# The Haskell playground browser test

`playground001` builds a client-side Haskell playground and exercises it
with Puppeteer in a headless browser. Its editor uses
[`monaco-vscode-api`](https://github.com/CodinGame/monaco-vscode-api), and
its xterm terminal runs GHCi through the GHC API.

## Using the playground

The frontend is a self-contained [`index.html`](./index.html). It loads
pinned editor and terminal libraries from CDNs; there is no frontend npm
project or separate JavaScript build step. Deploy it alongside the generated
`rootfs.tar.zst` and the JavaScript modules from `utils/jsffi`. Building the
Wasm compiler and Haskell shared libraries is still required to generate
those artifacts.

Serve the artifacts over HTTPS, or HTTP on `localhost`, so the browser can
use the origin private file system (OPFS). For a local build, run
`python3 -m http.server 8000` in the artifact directory and open
`http://localhost:8000/`. Loading `index.html` through a `file:` URL does not
provide the required browser storage environment. CDN access is needed to
load the editor, terminal and Wasm archive extractor.

Create and switch between files in the editor. Edits are automatically saved
to the workspace, and GHCi starts in `/workspace`. For example, a `Main.hs`
file can import a module from another file in the same workspace. The
terminal runs the ordinary GHCi command loop, so commands and evaluation
share one session:

```text
:load Main.hs
main
:reload
:set -XOverloadedStrings
getLine >>= putStrLn
```

Enter a line after the last expression to supply the interpreted program's
input. The terminal also handles output without a trailing newline.
`:quit` ends the GHCi session; reloading the page starts another session
with the saved files.

The editor's filesystem provider and WASI access the same `/workspace`
`Directory` and `File` objects. The synchronous WASI shim uses an in-memory
mount, backed by OPFS: startup restores the directory tree, editor saves
persist it, and input barriers flush pending edits and files written by
Haskell before GHCi accepts further input. This also persists binary files,
empty directories, renames and deletions. Persistence errors are reported,
and write operations are serialized so an older save cannot overwrite a
newer save.

OPFS belongs to the site's origin. Reopening the same origin restores the
workspace; changing the hostname or port selects different storage. Clearing
site data removes saved files. An exclusive browser lock permits one active
playground tab per origin, preventing competing tabs from overwriting the
workspace. The compiler libraries and package databases under `/tmp` are
loaded from the archive for each session and remain temporary.

## Headless testing

`playground001` is enabled for the `wasm32` target. Set up the latest
[`ghc-wasm-meta`](https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta)
toolchain and source `~/.ghc-wasm/env`, so the expected Node installation
and Puppeteer dependencies are available. Install a current Firefox and set:

```sh
export FIREFOX_LAUNCH_OPTS='{"browser":"firefox","executablePath":"/usr/bin/firefox"}'
```

On macOS, use:

```sh
export FIREFOX_LAUNCH_OPTS='{"browser":"firefox","executablePath":"/Applications/Firefox.app/Contents/MacOS/firefox"}'
```

Without `FIREFOX_LAUNCH_OPTS`, the test is skipped. The
[`playground001.js`](./playground001.js) driver also accepts Chrome
[`puppeteer.launch`](https://pptr.dev/api/puppeteer.puppeteernode.launch)
options in this variable; its browser interaction is not Firefox-specific.

Build the test dependencies with:

```sh
hadrian/build --flavour=perf+assertions+debug_info+text_simdutf --docs=none -j16 test:all_deps --freeze1
```

Then run the browser test, retaining the deployable artifacts:

```sh
hadrian/build --flavour=perf+assertions+debug_info+text_simdutf --docs=none -j16 test --only=playground001 --keep-test-files --freeze1
```

Allow at least 180 minutes for each build or test invocation. Wait for the
command to exit without polling build or test progress. The browser test
covers multi-file loading, GHCi commands and terminal input, workspace
changes made by Haskell, and persistence across a page reload.

## Manual testing and packaging

After the retained test run, serve the temporary directory containing
`index.html`, `rootfs.tar.zst` and the JavaScript modules as described above.

To package the playground independently of the testsuite, use
[`playground001.sh`](./playground001.sh) as a starting point. Work in a
scratch artifact directory: the script rewrites `index.html` and removes
its copied Haskell source after compilation. Copy the files listed in
[`all.T`](./all.T), set `TEST_CC` to `wasm32-wasi-clang`, `TEST_HC` to
`wasm32-wasi-ghc`, and `GHC_PKG` to the corresponding package tool. The
script takes Puppeteer launch options as its first argument and runs the
browser test after creating the archive.

The archive contains:

- `/tmp/clib`: C and C++ shared libraries.
- `/tmp/hslib/lib`: the GHC library directory and package database.
- `/tmp/libplayground001.so`: the playground entry library exporting `myMain`.

The script trims unused compiler artifacts and compresses the filesystem
into `rootfs.tar.zst`. At startup,
[`bsdtar-wasm`](https://github.com/haskell-wasm/bsdtar-wasm) extracts the
archive into a
[`PreopenDirectory`](https://github.com/haskell-wasm/browser_wasi_shim/blob/master/src/fs_mem.ts)
from [`browser_wasi_shim`](https://github.com/haskell-wasm/browser_wasi_shim).
The persistent workspace is mounted into that same root before GHCi starts.

## Customizing the playground

[`playground001.hs`](./playground001.hs) uses the high-level `GHCi.UI`
modules exposed by the `ghc` library. Its exported entry point has type:

```haskell
myMain :: JSString -> JSString -> IO ()
```

The arguments are the GHC library directory and workspace path. Call it as
`dyld.exportFuncs.myMain("/tmp/hslib/lib", "/workspace")`. The returned
promise remains pending until GHCi exits; the function does not return a
per-program callback. Standard input and output use custom Haskell Handles
connected through JSFFI to `globalThis.playgroundTerminal`. The asynchronous
input bridge allows both GHCi and interpreted programs to wait for xterm
input.

The relevant `dyld.mjs` interfaces are:

- `DyLDBrowserHost`: pass the shared `rootfs` and `stdout`/`stderr` callbacks
  for loader and WASI output.
- `main`: load the entry shared library and return the `DyLD` object whose
  `exportFuncs` contains the exported Haskell functions.

To add third-party packages, include their shared libraries, interface
files and package databases in `rootfs.tar.zst`. One approach is to install
packages into the toolchain's global package database before packaging it.
Another is to package the Cabal store and `dist-newstyle` directories and
configure the matching package database flags in the GHC session.

Cabal-built packages are generally not relocatable: paths recorded in their
package databases must match their absolute paths inside the browser
filesystem. Also update the dynamic library search paths when adding
libraries outside the existing directories. The packaging script currently
removes Cabal and Cabal-syntax to reduce download size; adjust that trimming
if the intended programs need them.

The [Haskell Wasm Matrix room](https://matrix.to/#/#haskell.wasm:matrix.org)
is available for community support.
