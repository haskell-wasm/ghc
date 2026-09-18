#!/usr/bin/env -S node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

// Use a real, stable localhost origin: OPFS is keyed by origin and must
// survive page reloads. Intercepting requests to a fictitious URL does not
// exercise the same secure-context and persistence behavior.
async function serve(artifactDir) {
  const root = path.resolve(artifactDir);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!filename.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await fs.promises.readFile(filename);
      response.writeHead(200, {
        "Content-Type": {
          ".html": "text/html; charset=utf-8",
          ".js": "application/javascript",
          ".mjs": "application/javascript",
          ".wasm": "application/wasm",
          ".css": "text/css",
        }[path.extname(filename)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

// The function is serialized and executed in the browser by Puppeteer.
function terminalText() {
  const buffer = window.playground.terminal.buffer.active;
  const lines = [];
  for (let line = 0; line < buffer.length; ++line) {
    lines.push(buffer.getLine(line).translateToString(true));
  }
  return lines.join("\n").trimEnd();
}

class Playground {
  #browser;
  #page;
  #server;

  static async create({ launchOpts, artifactDir }) {
    const playground = new Playground();
    const { server, url } = await serve(artifactDir);
    playground.#server = server;
    try {
      playground.#browser = await puppeteer.launch(launchOpts);
      playground.#page = await playground.#browser.newPage();
      playground.#page.setDefaultTimeout(300000);
      playground.#page.setDefaultNavigationTimeout(300000);
      await playground.#page.setViewport({ width: 1440, height: 1000 });
      playground.#page.on("pageerror", (error) => console.error(error));
      playground.#page.on("console", (message) => {
        if (message.type() === "error") console.error("Browser:", message.text());
      });
      await playground.#page.goto(url);
      await playground.ready();
      return playground;
    } catch (error) {
      await playground.dumpFailure();
      await playground.close();
      throw error;
    }
  }

  async ready() {
    await this.#page.waitForFunction(() => {
      const error = document.querySelector('#status[data-error="true"]');
      if (error) return true;
      if (!window.playground || !window.playgroundTerminal.readCount) return false;
      const buffer = window.playground.terminal.buffer.active;
      return buffer.getLine(buffer.baseY + buffer.cursorY)
        ?.translateToString(true).trimEnd().endsWith("ghci>");
    });
    await this.checkStatus();
  }

  async checkStatus() {
    const error = await this.evaluate(() =>
      document.querySelector('#status[data-error="true"]')?.textContent);
    if (error) throw new Error(error);
  }

  async close() {
    try {
      if (this.#browser) await this.#browser.close();
    } finally {
      if (this.#server) {
        await new Promise((resolve, reject) =>
          this.#server.close((error) => error ? reject(error) : resolve())
        );
      }
    }
  }

  async dumpFailure() {
    if (!this.#page) return;
    let timer;
    try {
      const state = await Promise.race([
        this.#page.evaluate(() => {
          const buffer = window.playground?.terminal.buffer.active;
          const lines = [];
          if (buffer) {
            for (let index = Math.max(0, buffer.length - 80); index < buffer.length; ++index) {
              lines.push(buffer.getLine(index).translateToString(true));
            }
          }
          return {
            status: document.getElementById("status")?.textContent,
            terminal: lines.join("\n").trimEnd(),
          };
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Browser diagnostics timed out")), 10000);
        }),
      ]);
      console.error("Playground status:", state.status);
      console.error("Terminal tail:\n" + state.terminal);
    } catch (error) {
      console.error("Could not capture playground state:", error);
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate(fn, ...args) {
    return this.#page.evaluate(fn, ...args);
  }

  async send(text) {
    await this.evaluate((text) => window.playground.terminal.paste(text), text);
  }

  async checkFileActions() {
    this.#page.once("dialog", (dialog) => dialog.accept("Scratch.hs"));
    await this.#page.click("#new-file");
    await this.#page.waitForFunction(() =>
      playground.editor.getModel()?.uri.path === "/workspace/Scratch.hs");
    await this.evaluate(async () => {
      playground.editor.setValue("module Scratch where\nvalue = 42\n");
      await playground.saveAll();
      [...document.querySelectorAll('#tabs [role="tab"]')]
        .find((tab) => tab.textContent === "Main.hs").click();
    });
    await this.#page.waitForFunction(() =>
      playground.editor.getModel()?.uri.path === "/workspace/Main.hs");
    await this.evaluate(() =>
      [...document.querySelectorAll('#tabs [role="tab"]')]
        .find((tab) => tab.textContent === "Scratch.hs").click());
    await this.#page.waitForFunction(() =>
      playground.editor.getModel()?.uri.path === "/workspace/Scratch.hs");
    this.#page.once("dialog", (dialog) => dialog.accept("Renamed.hs"));
    await this.#page.click("#rename-file");
    await this.#page.waitForFunction(() =>
      playground.editor.getModel()?.uri.path === "/workspace/Renamed.hs");
    assert.match(await this.evaluate(() =>
      playground.workspace.read("Renamed.hs")), /value = 42/);
    this.#page.once("dialog", (dialog) => dialog.accept());
    await this.#page.click("#delete-file");
    await this.#page.waitForFunction(async () =>
      !(await playground.workspace.list()).includes("Renamed.hs"));
    await this.evaluate(() => playground.openFile("Main.hs"));
  }

  async command(command) {
    const before = await this.evaluate(terminalText);
    const readCount = await this.evaluate(() => window.playgroundTerminal.readCount);
    await this.send(`${command}\n`);
    await this.#page.waitForFunction(({ before, readCount }) => {
      const error = document.querySelector('#status[data-error="true"]');
      if (error) return true;
      if (window.playgroundTerminal.readCount <= readCount) return false;
      const buffer = window.playground.terminal.buffer.active;
      const lines = [];
      for (let line = 0; line < buffer.length; ++line) {
        lines.push(buffer.getLine(line).translateToString(true));
      }
      const text = lines.join("\n").trimEnd();
      return text !== before && text.endsWith("ghci>");
    }, {}, { before, readCount });
    await this.checkStatus();
    return (await this.evaluate(terminalText)).slice(before.length);
  }

  async waitForLine(line) {
    await this.#page.waitForFunction((expected) => {
      const buffer = window.playground.terminal.buffer.active;
      for (let index = 0; index < buffer.length; ++index) {
        if (buffer.getLine(index).translateToString(true).trimEnd() === expected) return true;
      }
      return false;
    }, {}, line);
  }

  async reload() {
    await this.#page.reload();
    await this.ready();
  }
}

(async () => {
  const playground = await Playground.create({
    launchOpts: JSON.parse(process.argv[2]),
    artifactDir: process.cwd(),
  });
  try {
    await playground.checkFileActions();
    // Keep the existing compiler-API smoke test and its golden output.
    await playground.evaluate(async (source) => {
      await window.playground.workspace.write("Main.hs", source);
      await window.playground.openFile("Main.hs");
    }, await fs.promises.readFile("./hello.hs", "utf8"));
    await playground.command(":set -package ghc");
    assert.match(await playground.command(":load Main.hs"), /Ok, /);
    const hello = await playground.command("main");
    const golden = 'main = putStrLn "hello world"';
    assert(hello.split("\n").includes(golden), hello);
    process.stdout.write(`${golden}\n`);

    // Imported modules live in the same workspace that WASI reads.
    await playground.evaluate(async () => {
      const { workspace, openFile } = window.playground;
      await workspace.write("Greeting.hs", 'module Greeting where\ngreeting = "Hello, λ!"\n');
      await workspace.write("Main.hs", 'module Main where\nimport Greeting\nmain = putStrLn greeting\n');
      await openFile("Main.hs");
    });
    assert.match(await playground.command(":load Main.hs"), /Ok, /);
    assert.match(await playground.command(":type greeting"), /greeting :: String/);
    assert.match(await playground.command("main"), /Hello, λ!/);

    // Editing a second model and :reload must use the newly saved source.
    await playground.evaluate(async () => {
      const { editor, openFile, saveAll } = window.playground;
      await openFile("Greeting.hs");
      editor.setValue('module Greeting where\ngreeting = "Edited, 世界!"\n');
      await saveAll();
    });
    assert.match(await playground.command(":reload"), /Ok, /);
    assert.match(await playground.command("main"), /Edited, 世界!/);
    assert.match(await playground.command(":type doesNotExist"), /not in scope/i);
    assert.match(await playground.command("21 * 2"), /\n42\n/);
    await playground.command(":{\nlet twice x =\n      x + x\n:}");
    assert.match(await playground.command("twice 21"), /\n42\n/);

    // Ctrl+C interrupts the running evaluation and preserves the session.
    await playground.send('putStrLn "interrupt ready" >> Control.Concurrent.threadDelay 60000000\n');
    await playground.waitForLine("interrupt ready");
    await playground.send("\u0003");
    await playground.ready();
    assert.match(await playground.command("twice 21"), /\n42\n/);

    // stdout without a newline and interpreted stdin use the same terminal.
    await playground.send('putStr "input: " >> getLine >>= putStrLn\n');
    await playground.waitForLine("input:");
    await playground.send("terminal λ 世界\n");
    await playground.ready();
    await playground.waitForLine("terminal λ 世界");

    // Files changed by interpreted code are persisted and visible to the
    // editor, not merely copied from editor models into an unrelated VFS.
    await playground.command('writeFile "generated.txt" "from GHCi λ"');
    assert.equal(await playground.evaluate(() =>
      window.playground.workspace.read("generated.txt")), "from GHCi λ");
    await playground.evaluate(() => window.playground.openFile("generated.txt"));
    await playground.command('writeFile "generated.txt" "updated by GHCi"');
    assert.equal(await playground.evaluate(() =>
      window.playground.editor.getValue()), "updated by GHCi");
    await playground.command('System.Directory.renameFile "generated.txt" "renamed.txt"');
    assert.equal(await playground.evaluate(() =>
      window.playground.workspace.read("renamed.txt")), "updated by GHCi");
    await playground.command('System.Directory.removeFile "renamed.txt"');
    assert.equal(await playground.evaluate(async () =>
      (await window.playground.workspace.list()).includes("renamed.txt")), false);
    await playground.command('System.Directory.createDirectoryIfMissing True "Generated"');
    await playground.command('writeFile "Generated/persistent.txt" "saved by GHCi λ"');
    assert.equal(await playground.evaluate(() =>
      window.playground.workspace.read("Generated/persistent.txt")), "saved by GHCi λ");

    // A new browser document restores the edited modules from OPFS.
    await playground.evaluate(() => window.playground.saveAll());
    await playground.reload();
    assert.match(await playground.evaluate(() =>
      window.playground.workspace.read("Greeting.hs")), /Edited, 世界!/);
    assert.equal(await playground.evaluate(async () =>
      (await window.playground.workspace.list()).includes("renamed.txt")), false);
    assert.equal(await playground.evaluate(() =>
      window.playground.workspace.read("Generated/persistent.txt")), "saved by GHCi λ");
    assert.match(await playground.command(":load Main.hs"), /Ok, /);
    assert.match(await playground.command("main"), /Edited, 世界!/);
  } catch (error) {
    await playground.dumpFailure();
    throw error;
  } finally {
    await playground.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
