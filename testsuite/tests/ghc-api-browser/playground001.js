#!/usr/bin/env -S node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const testPlaygroundOPFS = require("./playground001-opfs.js");

const timeout = 15 * 60 * 1000;
const prompt = "__PLAYGROUND_PROMPT__ ";

async function serve(artifactDir) {
  const root = await fs.promises.realpath(artifactDir);
  const insideRoot = (file) => file === root || file.startsWith(root + path.sep);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const requested = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!insideRoot(requested)) {
        response.writeHead(403).end();
        return;
      }
      const file = await fs.promises.realpath(requested);
      if (!insideRoot(file)) {
        response.writeHead(403).end();
        return;
      }
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json",
          ".wasm": "application/wasm",
          ".zst": "application/zstd",
        }[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        fs.createReadStream(file).on("error", (error) => response.destroy(error)).pipe(response);
      }
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

class Playground {
  constructor(page) {
    this.page = page;
  }

  async ready() {
    await this.page.waitForFunction(() => Boolean(globalThis.playground?.ready) || document.querySelector("#status")?.dataset.error === "true");
    const error = await this.page.evaluate(() => !globalThis.playground?.ready && document.querySelector("#status")?.textContent);
    if (error) throw new Error(error);
    await this.page.evaluate(() => playground.ready);
    await this.page.waitForFunction(() => playground.output.endsWith("ghci> "));
    await this.command(':set prompt "__PLAYGROUND_PROMPT__ "');
  }

  async position() {
    return this.page.evaluate(() => playground.output.length);
  }

  async outputSince(position) {
    return this.page.evaluate((position) => playground.output.slice(position), position);
  }

  async waitForPrompt(position) {
    await this.page.waitForFunction(
      ({ position, prompt }) => playground.output.slice(position).endsWith(prompt) || document.querySelector("#reload").disabled,
      { timeout },
      { position, prompt }
    );
    const output = await this.outputSince(position);
    assert.equal(output.endsWith(prompt), true, `GHCi exited while waiting for its prompt:\n${output}`);
    return output;
  }

  async send(command) {
    const position = await this.position();
    await this.page.evaluate((command) => playground.sendCommand(command), command);
    return position;
  }

  async command(command) {
    return this.waitForPrompt(await this.send(command));
  }

  async waitForText(position, text) {
    await this.page.waitForFunction(
      ({ position, text }) => playground.output.slice(position).includes(text),
      { timeout },
      { position, text }
    );
    return this.outputSince(position);
  }

  async readFile(file) {
    return this.page.evaluate(async (file) =>
      new TextDecoder().decode(await playground.fs.readFile("/workspace/" + file)), file);
  }

  async files() {
    return this.page.evaluate(async () => {
      async function walk(directory) {
        const result = [];
        for (const [name, type] of await playground.fs.readdir(directory)) {
          const path = directory + "/" + name;
          if (type === 2) result.push(...await walk(path));
          else result.push(path.slice("/workspace/".length));
        }
        return result;
      }
      return (await walk("/workspace")).sort();
    });
  }

  async fileAction(action, value) {
    await this.page.click(action);
    if (value !== undefined) await this.page.locator("#file-name").fill(value);
    await this.page.click("#confirm-file");
    await this.page.waitForFunction(() =>
      !document.querySelector("#file-dialog").open || document.querySelector("#file-error").textContent);
    const error = await this.page.$eval("#file-error", (element) => element.textContent);
    assert.equal(error, "", `File action ${action} failed: ${error}`);
  }

  async edit(file, content, create = false) {
    if (create) await this.fileAction("#new-file", file);
    await this.page.evaluate(async ({ file, content }) => {
      await playground.openFile("/workspace/" + file);
      playground.editor.setValue(content);
    }, { file, content });
  }

  async save() {
    await this.page.evaluate(() => playground.saveAll());
  }

  async rename(file, target) {
    await this.page.evaluate((file) => playground.openFile("/workspace/" + file), file);
    await this.fileAction("#rename-file", target);
  }

  async delete(file) {
    await this.page.evaluate((file) => playground.openFile("/workspace/" + file), file);
    await this.fileAction("#delete-file");
  }

  async interrupt() {
    await this.page.evaluate(() => playground.terminal.focus());
    await this.page.keyboard.down("Control");
    try {
      await this.page.keyboard.press("c");
    } finally {
      await this.page.keyboard.up("Control");
    }
  }
}

(async () => {
  let server;
  let browser;
  let page;
  const diagnostics = [];
  const record = (message) => {
    diagnostics.push(message);
    if (diagnostics.length > 50) diagnostics.shift();
  };
  try {
    server = await serve(process.cwd());
    browser = await puppeteer.launch({
      timeout: 120000,
      protocolTimeout: timeout,
      ...JSON.parse(process.argv[2]),
    });
    page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    page.on("pageerror", (error) => record(error.stack || String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warn") record(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => record(`Request failed: ${request.url()}: ${request.failure()?.errorText}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "domcontentloaded" });
    await testPlaygroundOPFS(page);
    const playground = new Playground(page);
    await playground.ready();

    assert.match(await playground.command(":type (+ 1)"), /Num a => a -> a/);
    assert.match(await playground.command("21 * 2"), /\b42\b/);

    const greeting = (message) => `module Greeting (greeting) where\ngreeting :: String\ngreeting = ${JSON.stringify(message)}\n`;
    const main = "module Main where\nimport Greeting\nmain :: IO ()\nmain = putStrLn greeting\n";
    await playground.edit("Greeting.hs", greeting("hello from two files"), !(await playground.files()).includes("Greeting.hs"));
    await playground.edit("Main.hs", main, !(await playground.files()).includes("Main.hs"));
    await playground.command(":load Main.hs");
    assert.match(await playground.command(":main"), /hello from two files/);
    assert.equal(await playground.readFile("Main.hs"), main);
    assert.equal(await playground.readFile("Greeting.hs"), greeting("hello from two files"));
    assert.equal(await page.evaluate(() => playground.models.size >= 2), true);

    await playground.edit("Greeting.hs", greeting("reloaded λ 🌍"));
    await playground.command(":reload");
    assert.match(await playground.command(":main"), /reloaded λ 🌍/);
    assert.match(await playground.command('readFile "Greeting.hs" >>= putStr'), /reloaded λ 🌍/);

    const initialGenerated = "module Generated where\nanswer :: Int\nanswer = 42\n";
    await playground.command(`writeFile "Generated.hs" ${JSON.stringify(initialGenerated)}`);
    assert.equal(await playground.readFile("Generated.hs"), initialGenerated);
    await page.evaluate(() => playground.openFile("/workspace/Generated.hs"));
    assert.equal(await page.evaluate(() => playground.editor.getValue()), initialGenerated);
    const generated = "module Generated where\nanswer :: Int\nanswer = 43\n";
    await playground.command(`writeFile "Generated.hs" ${JSON.stringify(generated)}`);
    await page.waitForFunction((content) => playground.editor.getValue() === content, { timeout }, generated);
    assert.equal(await playground.readFile("Generated.hs"), generated);

    let position = await playground.send('putStrLn "INPUT_READY" >> (getLine >>= putStrLn . ("INPUT:" ++))');
    await playground.waitForText(position, "INPUT_READY");
    await page.evaluate(() => playground.sendCommand("Καλημέρα λ 🌍"));
    assert.match(await playground.waitForPrompt(position), /INPUT:Καλημέρα λ 🌍/);

    position = await playground.send('putStrLn "INTERRUPT_READY" >> getLine');
    await playground.waitForText(position, "INTERRUPT_READY");
    await playground.interrupt();
    await playground.waitForPrompt(position);
    assert.match(await playground.command("6 * 7"), /\b42\b/);

    position = await playground.position();
    await playground.interrupt();
    await playground.waitForPrompt(position);
    assert.match(await playground.command("40 + 2"), /\b42\b/);

    await playground.edit("scratch/Keep.hs", "module Keep where\n", true);
    await playground.edit("scratch/Delete.hs", "module Delete where\n", true);
    await playground.save();
    await playground.rename("scratch/Keep.hs", "scratch/Kept.hs");
    await playground.delete("scratch/Delete.hs");
    assert.equal(await playground.readFile("scratch/Kept.hs"), "module Keep where\n");
    assert.equal((await playground.files()).includes("scratch/Keep.hs"), false);
    assert.equal((await playground.files()).includes("scratch/Delete.hs"), false);

    position = await playground.send(":quit");
    await playground.waitForText(position, "Leaving GHCi.");
    await page.reload({ waitUntil: "domcontentloaded" });
    await playground.ready();
    assert.equal(await playground.readFile("Main.hs"), main);
    assert.equal(await playground.readFile("Greeting.hs"), greeting("reloaded λ 🌍"));
    assert.equal(await playground.readFile("Generated.hs"), generated);
    assert.equal(await playground.readFile("scratch/Kept.hs"), "module Keep where\n");
    assert.equal((await playground.files()).includes("scratch/Keep.hs"), false);
    assert.equal((await playground.files()).includes("scratch/Delete.hs"), false);
    await page.evaluate(() => playground.openFile("/workspace/Greeting.hs"));
    assert.equal(await page.evaluate(() => playground.editor.getValue()), greeting("reloaded λ 🌍"));
    await playground.command(":load Main.hs");
    assert.match(await playground.command(":main"), /reloaded λ 🌍/);

    await playground.edit("ApiExample.hs", await fs.promises.readFile("./hello.hs", "utf8"), true);
    const packageOutput = await playground.command(":set -package ghc");
    assert.doesNotMatch(packageOutput, /Wmissed-extra-shared-lib|loadDLLs failed/);
    await playground.command(":load ApiExample.hs");
    const apiOutput = await playground.command(":main");
    const expected = 'main = putStrLn "hello world"';
    assert.equal(apiOutput.replaceAll("\r", "").split("\n").includes(expected), true, apiOutput);

    position = await playground.position();
    await page.evaluate(() => playground.runtime.eof());
    await playground.waitForText(position, "Leaving GHCi.");
    process.stdout.write(expected + "\n");
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write((error.stack || String(error)) + "\n");
    for (const message of diagnostics) process.stderr.write(message + "\n");
    if (page && !page.isClosed()) {
      try {
        const details = await page.evaluate(() => ({
          status: document.querySelector("#status")?.textContent,
          terminal: globalThis.playground?.output?.slice(-16000),
        }));
        process.stderr.write(JSON.stringify(details, null, 2) + "\n");
      } catch (error) {
        process.stderr.write(`Could not read browser diagnostics: ${error.message}\n`);
      }
    }
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
})();
