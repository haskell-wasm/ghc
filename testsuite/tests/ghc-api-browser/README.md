# Haskell playground

`playground001` runs GHCi in the browser, alongside a multi-file Haskell editor
built with [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api)
and an [xterm.js](https://xtermjs.org/) terminal. All frontend code, including
the worker, is in `index.html`. JavaScript libraries load from CDNs; no npm
project, bundler, or frontend build is needed.

## Using the playground

Create files and folders in the Explorer, switch between open file tabs, and
edit Haskell with syntax highlighting, undo, search, and normal editor shortcuts.
Changes save automatically. **Save all** or Ctrl+S saves immediately, and commands
sent to GHCi wait for pending editor saves.

**Load in GHCi** loads the active file. The terminal runs the real GHCi command
loop: use `:type`, `:load`, `:reload`, `:main`, `:help`, and ordinary Haskell
expressions. Input also reaches interpreted programs using `getLine`. The
terminal supports line editing, command history, pasted lines, Ctrl+C, and Ctrl+D.
**Restart** recreates the worker and GHCi session while retaining editor buffers
and saved files; it also recovers a computation that stops yielding to the browser.

The editor and WASI share `/workspace`, backed by an OPFS filesystem volume. A
single worker owns that namespace, so Haskell `readFile`, `writeFile`, directory
operations, and editor operations see the same files. Writes commit to OPFS
before they are acknowledged. Checksummed journals recover incomplete writes
and compact into alternating generations without replacing the last committed
copy until its replacement is durable. Files belong to the page's origin and
survive reloads and GHCi restarts. One tab can own the workspace at a time.

The compiler distribution is unpacked into `/tmp` from `rootfs.tar.zst`.
Browser storage clearing removes the saved workspace. Serve the page over HTTPS
or localhost for OPFS; cross-origin-isolation headers are not required.

## Building and testing

Use a configured wasm GHC checkout and the
[ghc-wasm-meta](https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta) toolchain.
Build the dependencies with:

```sh
hadrian/build --flavour=perf+assertions+debug_info+text_simdutf --docs=none -j16 test:all_deps --freeze1
```

The browser test uses the toolchain's preinstalled `puppeteer-core`. For Firefox:

```sh
export FIREFOX_LAUNCH_OPTS='{"browser":"firefox","executablePath":"/usr/bin/firefox"}'
hadrian/build --flavour=perf+assertions+debug_info+text_simdutf --docs=none -j16 test --only=playground001 --keep-test-files --freeze1
```

Allow at least 180 minutes for build/test commands. Without
`FIREFOX_LAUNCH_OPTS`, the testsuite skips `playground001`. The test script also
accepts Chrome Puppeteer launch options. It serves the generated artifacts on a
real localhost origin and checks editing, multi-file reloads, shared filesystem
access, Unicode input, interruption, and persistence after a page reload.

To prepare a standalone directory, copy this directory's `index.html`,
`playground001.hs`, `playground001.sh`, `playground001.js`, and
`playground001-opfs.js`, together with
`utils/jsffi/{dyld,post-link,prelude}.mjs` and `.gitlab/hello.hs`, into an empty
artifact directory. Set `TEST_HC` to the wasm cross-compiler, `TEST_CC` to
`wasm32-wasi-clang`, and `GHC_PKG` to its `ghc-pkg`, then run
`./playground001.sh` there. With no argument the script only builds the artifacts;
passing Puppeteer launch-options JSON also runs the browser test. Serve the
resulting directory, for example with `python3 -m http.server`, and open
`index.html`.

## Runtime integration

The `GHCi.*` modules are exposed by `lib:ghc`. `playground001.hs` calls
`GHCi.UI.interactiveUI` and exports `myMain`, `terminalInput`, `terminalEOF`, and
`interrupt` through JSFFI. Its UTF-8 input handle feeds both GHCi and interpreted
Haskell. Raw WASI stdout/stderr descriptors feed xterm without line buffering,
so prompts and partial output appear immediately.

The embedded worker mounts the OPFS volume into `browser_wasi_shim`, loads
`libplayground001.so` with `DyLDBrowserHost`, and handles filesystem and terminal
requests. The main thread registers a VS Code filesystem provider over those
requests and uses file-backed Monaco model references. Filesystem events refresh
clean editor models when Haskell changes their files.

`rootfs.tar.zst` contains `/tmp/clib` with C/C++ shared libraries,
`/tmp/hslib/lib` with the GHC library directory, and `/tmp/libplayground001.so`.
The packaging script retains dynamic interfaces and shared libraries and removes
profiling/static artifacts and Cabal packages. It relocates C++ runtime library
paths and adds the bundled C library directory to the package search paths. The worker discovers the GHC
shared-library directory from the archive rather than embedding a GHC version.
Additional Haskell packages can be included in that distribution and exposed
with GHCi's `:set -package`; preserve the installation paths expected by their
package configurations.
