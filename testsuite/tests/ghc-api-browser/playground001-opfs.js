async function workspaceChecks(name) {
  const encode = (text) => new TextEncoder().encode(text);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const changes = [];
  const storage = await navigator.storage.getDirectory();
  const write = FileSystemSyncAccessHandle.prototype.write;
  const truncate = FileSystemSyncAccessHandle.prototype.truncate;
  const NativeUint8Array = Uint8Array;
  const slice = Uint8Array.prototype.slice;
  let ws;
  function snapshotRecord(bytes) {
    try {
      const record = JSON.parse(decode(bytes));
      return record.op === "snapshot" && Number.isSafeInteger(record.generation) ? record : null;
    } catch { return null; }
  }
  try {
    ws = await openWorkspace({name, onChanges: c => changes.push(...c)});
    assert(ws.fresh, 'new volume fresh');
    let duplicate = false;
    try { const second = await openWorkspace({name}); second.close(); } catch { duplicate = true; }
    assert(duplicate, 'exclusive sync handle');
    await ws.fs.mkdir('/workspace/src');
    await ws.fs.writeFile('/workspace/src/Main.hs', encode('main = print 1\n'));
    const first = await ws.fs.stat('/workspace/src/Main.hs');
    await ws.fs.writeFile('/workspace/src/Main.hs', encode('main = print 2\n'));
    const second = await ws.fs.stat('/workspace/src/Main.hs');
    assert(second.mtime > first.mtime, 'rapid edit mtime');
    const root = ws.mount(new PreopenDirectory('/', [['tmp', new Directory([])]]));
    assert(root.path_create_directory('workspace') === wasi.ERRNO_EXIST, 'workspace root already exists');
    const cwd = root.path_open(0, 'workspace', wasi.OFLAGS_DIRECTORY, 0n, 0n, 0).fd_obj;
    assert(cwd.path_create_directory('.') === wasi.ERRNO_EXIST, 'current directory already exists');
    assert(cwd.path_create_directory('src/..') === wasi.ERRNO_EXIST, 'normalized current directory already exists');
    const opened = root.path_open(0, 'workspace/src/../Wasi.hs', wasi.OFLAGS_CREAT, BigInt(wasi.RIGHTS_FD_WRITE), 0n, 0);
    assert(opened.ret === 0, 'WASI create');
    assert(opened.fd_obj.fd_write(encode('module Wasi where\nx = 42\n')).ret === 0, 'WASI write');
    assert(decode(await ws.fs.readFile('/workspace/Wasi.hs')).includes('42'), 'WASI write visible');
    assert(opened.fd_obj.fd_filestat_set_size(4n) === 0, 'WASI truncate');
    assert(decode(await ws.fs.readFile('/workspace/Wasi.hs')) === 'modu', 'truncate visible');
    const runtime = new WASI([], [], [root], { debug: false });
    const memory = new WebAssembly.Memory({ initial: 1 });
    runtime.initialize({ exports: { memory } });
    function rename(from, to, destFd = 0) {
      const a = encode(from), b = encode(to), bytes = new Uint8Array(memory.buffer);
      bytes.set(a, 0); bytes.set(b, 1024);
      return runtime.wasiImport.path_rename(0, 0, a.length, destFd, 1024, b.length);
    }
    assert(rename('workspace/Wasi.hs', 'workspace/Renamed.hs') === 0, 'WASI atomic rename');
    assert(decode(await ws.fs.readFile('/workspace/Renamed.hs')) === 'modu', 'WASI rename visible');
    assert(rename('workspace/Renamed.hs', 'workspace/missing/no.hs') === wasi.ERRNO_NOENT, 'rename validates parent');
    assert(decode(await ws.fs.readFile('/workspace/Renamed.hs')) === 'modu', 'failed rename preserves source');
    const temp = root.path_open(0, 'tmp', wasi.OFLAGS_DIRECTORY, 0n, 0n, 0).fd_obj;
    runtime.fds.push(temp);
    assert(rename('workspace/Renamed.hs', 'outside.hs', 1) === wasi.ERRNO_XDEV, 'cross-volume rename rejected');
    assert(decode(await ws.fs.readFile('/workspace/Renamed.hs')) === 'modu', 'cross-volume source retained');
    const duplicateRoot = root.path_open(0, '.', wasi.OFLAGS_DIRECTORY, 0n, 0n, 0).fd_obj;
    const duplicateFile = duplicateRoot.path_open(0, 'workspace/Clone.hs', wasi.OFLAGS_CREAT, 0n, 0n, 0);
    assert(duplicateFile.ret === 0 && duplicateFile.fd_obj.fd_write(encode('clone')).ret === 0, 'root fd cloning retains persistence');
    let invalid = false;
    try { await ws.fs.writeFile('/workspace/../escape', encode('bad')); } catch { invalid = true; }
    assert(invalid, 'editor traversal rejected');
    await ws.fs.mkdir('/workspace/nonempty');
    await ws.fs.writeFile('/workspace/nonempty/child', encode('kept'));
    let failedDelete = false;
    try { await ws.fs.delete('/workspace/nonempty'); } catch { failedDelete = true; }
    assert(failedDelete && decode(await ws.fs.readFile('/workspace/nonempty/child')) === 'kept', 'failed delete retains contents');
    let calls = 0;
    FileSystemSyncAccessHandle.prototype.write = function(data, options) {
      if (++calls === 2) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return write.call(this, data, options);
    };
    let quota = false;
    try { await ws.fs.writeFile('/workspace/Renamed.hs', encode('must not survive')); } catch { quota = true; }
    FileSystemSyncAccessHandle.prototype.write = write;
    assert(quota && decode(await ws.fs.readFile('/workspace/Renamed.hs')) === 'modu', 'quota failure preserves memory');
    const finalMtime = (await ws.fs.stat('/workspace/src/Main.hs')).mtime;
    ws.close();
    const handle = await (await storage.getFileHandle(name)).createSyncAccessHandle();
    try {
      handle.write(new Uint8Array([1,2,3,4,5]), { at: handle.getSize() });
      handle.flush();
    } finally { handle.close(); }
    ws = await openWorkspace({name});
    assert(!ws.fresh, 'reopened existing volume');
    assert(decode(await ws.fs.readFile('/workspace/Renamed.hs')) === 'modu', 'journal recovers committed data after quota/partial tail');
    assert(decode(await ws.fs.readFile('/workspace/Clone.hs')) === 'clone', 'cloned root write persisted');
    assert((await ws.fs.stat('/workspace/src/Main.hs')).mtime === finalMtime, 'mtime persisted');
    assert(changes.some(c => c.path === '/workspace/Renamed.hs' && c.type === 1), 'WASI rename events');
    for (const [name] of await ws.fs.readdir('/workspace')) await ws.fs.delete('/workspace/' + name, { recursive: true });
    ws.close(); ws = await openWorkspace({name});
    assert(!ws.fresh && !(await ws.fs.readdir('/workspace')).length, 'empty workspace remains empty');
    const payload = new Uint8Array(256 * 1024).fill(19);
    const generations = new Set();
    FileSystemSyncAccessHandle.prototype.write = function(data, options) {
      const snapshot = snapshotRecord(data);
      if (snapshot && snapshot.generation > 0) generations.add(snapshot.generation);
      return write.call(this, data, options);
    };
    for (let i = 0; i < 72; i++) { payload[0] = i; await ws.fs.writeFile('/workspace/Large.hs', payload); }
    FileSystemSyncAccessHandle.prototype.write = write;
    const compactedTime = (await ws.fs.stat('/workspace/Large.hs')).mtime;
    ws.close();
    const blobs = await Promise.all([name, name + '.alternate'].map(async file => (await storage.getFileHandle(file)).getFile()));
    assert(generations.size >= 3, 'multiple compactions alternate generations');
    assert(blobs.reduce((sum, blob) => sum + blob.size, 0) < 10 * 1024 * 1024, 'journal disk usage stays bounded');
    ws = await openWorkspace({name});
    assert((await ws.fs.readFile('/workspace/Large.hs'))[0] === 71, 'newest compacted generation restored');
    assert((await ws.fs.stat('/workspace/Large.hs')).mtime === compactedTime, 'compaction preserves timestamps');
    let interruptedHandle, interrupted = false;
    FileSystemSyncAccessHandle.prototype.write = function(data, options) {
      if (snapshotRecord(data)?.generation > 0) {
        interruptedHandle = this; interrupted = true;
        throw new DOMException('Interrupted before snapshot commit', 'QuotaExceededError');
      }
      return write.call(this, data, options);
    };
    FileSystemSyncAccessHandle.prototype.truncate = function(size) {
      if (this === interruptedHandle) throw new DOMException('Simulated worker interruption', 'AbortError');
      return truncate.call(this, size);
    };
    let previous = 71, rejected = false;
    for (let i = 72; i < 110; i++) {
      payload[0] = i;
      try { await ws.fs.writeFile('/workspace/Large.hs', payload); previous = i; }
      catch { rejected = true; break; }
    }
    FileSystemSyncAccessHandle.prototype.write = write;
    FileSystemSyncAccessHandle.prototype.truncate = truncate;
    assert(interrupted && rejected, 'incomplete snapshot interruption propagated');
    assert((await ws.fs.readFile('/workspace/Large.hs'))[0] === previous, 'interrupted compaction preserves live data');
    const beforeRecovery = (await ws.fs.stat('/workspace/Large.hs')).mtime;
    ws.close(); ws = await openWorkspace({name});
    assert((await ws.fs.readFile('/workspace/Large.hs'))[0] === previous, 'incomplete newer snapshot ignored on recovery');
    assert((await ws.fs.stat('/workspace/Large.hs')).mtime === beforeRecovery, 'incomplete snapshot recovery preserves mtime');
    let quotaDuringCompaction = false;
    FileSystemSyncAccessHandle.prototype.write = function(data, options) {
      if (!quotaDuringCompaction && snapshotRecord(data)?.generation > 0) {
        quotaDuringCompaction = true;
        throw new DOMException('Snapshot quota injection', 'QuotaExceededError');
      }
      return write.call(this, data, options);
    };
    payload[0] = 201;
    await ws.fs.writeFile('/workspace/Large.hs', payload);
    FileSystemSyncAccessHandle.prototype.write = write;
    assert(quotaDuringCompaction, 'quota failure exercised during snapshot commit');
    ws.close(); ws = await openWorkspace({name});
    assert((await ws.fs.readFile('/workspace/Large.hs'))[0] === 201, 'snapshot rollback leaves subsequent journal mutation durable');
    payload[0] = 202;
    await ws.fs.writeFile('/workspace/Large.hs', payload);
    ws.close(); ws = await openWorkspace({name});
    assert((await ws.fs.readFile('/workspace/Large.hs'))[0] === 202, 'compaction can retry after interruption');
    const allocationBaseline = await ws.fs.readFile('/workspace/Large.hs');
    const allocationMtime = (await ws.fs.stat('/workspace/Large.hs')).mtime;
    ws.close();
    const diskSizes = async () => Promise.all([name, name + '.alternate'].map(async file => (await (await storage.getFileHandle(file)).getFile()).size));
    const beforeFailureSizes = await diskSizes();
    ws = await openWorkspace({name});
    const failureRoot = ws.mount(new PreopenDirectory('/', []));
    const allocationFd = failureRoot.path_open(0, 'workspace/Large.hs', 0, 0n, 0n, 0).fd_obj;
    let allocationFailures = 0;
    const growthSize = allocationBaseline.length * 2;
    globalThis.Uint8Array = new Proxy(NativeUint8Array, {
      construct(target, args, constructor) {
        if (args[0] === growthSize || args[0] === growthSize + 1) {
          allocationFailures++;
          throw new RangeError('Injected allocation failure');
        }
        return Reflect.construct(target, args, constructor);
      },
    });
    const growthResult = allocationFd.fd_pwrite(encode('x'), BigInt(growthSize - 1));
    const truncateResult = allocationFd.fd_filestat_set_size(BigInt(growthSize + 1));
    globalThis.Uint8Array = NativeUint8Array;
    assert(allocationFailures === 2, 'write and truncate growth allocation failures exercised');
    assert(growthResult.ret === wasi.ERRNO_NOMEM && growthResult.nwritten === 0 && truncateResult === wasi.ERRNO_NOMEM, 'failed WASI allocation returns ENOMEM without bytes written');
    let putAllocationFailure = false;
    Uint8Array.prototype.slice = function(...args) {
      if (this === payload) throw new RangeError('Injected put copy failure');
      return slice.apply(this, args);
    };
    try { await ws.fs.writeFile('/workspace/Large.hs', payload); }
    catch (error) { putAllocationFailure = error instanceof RangeError; }
    Uint8Array.prototype.slice = slice;
    assert(putAllocationFailure, 'put allocation failure exercised before journal write');
    const afterAllocationFailure = await ws.fs.readFile('/workspace/Large.hs');
    assert(afterAllocationFailure.length === allocationBaseline.length && afterAllocationFailure.every((byte, index) => byte === allocationBaseline[index]), 'failed growth and put preserve all live file bytes');
    assert((await ws.fs.stat('/workspace/Large.hs')).mtime === allocationMtime, 'failed allocations preserve live mtime');
    ws.close();
    assert(JSON.stringify(await diskSizes()) === JSON.stringify(beforeFailureSizes), 'failed allocations append no journal records or snapshots');
    ws = await openWorkspace({name});
    const recoveredAllocationFailure = await ws.fs.readFile('/workspace/Large.hs');
    assert(recoveredAllocationFailure.length === allocationBaseline.length && recoveredAllocationFailure.every((byte, index) => byte === allocationBaseline[index]), 'failed allocations preserve durable file contents');
    assert((await ws.fs.stat('/workspace/Large.hs')).mtime === allocationMtime, 'failed allocations preserve durable mtime');
  } finally {
    globalThis.Uint8Array = NativeUint8Array;
    Uint8Array.prototype.slice = slice;
    FileSystemSyncAccessHandle.prototype.write = write;
    FileSystemSyncAccessHandle.prototype.truncate = truncate;
    try { ws?.close(); }
    finally {
      for (const file of [name, name + ".alternate"]) {
        try { await storage.removeEntry(file); }
        catch (error) { if (error.name !== "NotFoundError") throw error; }
      }
    }
  }
}

module.exports = async function testPlaygroundOPFS(page) {
  await page.evaluate(async (checks) => {
    const source = document.getElementById("runtime-worker")?.textContent;
    if (!source) throw new Error("The playground runtime worker is missing");
    const name = "playground001-opfs-" + crypto.randomUUID();
    const url = URL.createObjectURL(new Blob([
      source,
      "\n(" + checks + ")(" + JSON.stringify(name) + ").then(() => postMessage({done: true}), error => postMessage({error: error.stack || String(error)}));",
    ], { type: "text/javascript" }));
    let worker;
    let timer;
    try {
      worker = new Worker(url, { type: "module", name: "playground-opfs-regression" });
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Playground OPFS regression checks timed out")), 180000);
        worker.onmessage = ({ data }) => {
          if (data.error) reject(new Error(data.error));
          else if (data.done) resolve();
        };
        worker.onerror = (event) => reject(new Error(event.message || "Playground OPFS regression worker failed"));
        worker.onmessageerror = () => reject(new Error("Playground OPFS regression worker sent an invalid message"));
      });
    } finally {
      clearTimeout(timer);
      worker?.terminate();
      URL.revokeObjectURL(url);
      const storage = await navigator.storage.getDirectory();
      for (const file of [name, name + ".alternate"]) {
        for (let attempt = 0; ; attempt++) {
          try { await storage.removeEntry(file); break; }
          catch (error) {
            if (error.name === "NotFoundError") break;
            if (error.name !== "NoModificationAllowedError" || attempt === 19) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
    }
  }, workspaceChecks.toString());
};
