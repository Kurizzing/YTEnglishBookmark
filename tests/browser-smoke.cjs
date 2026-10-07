// Isolated Chrome UI smoke test. This does not access the user's browser profile.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { createBookmark } = require("../core.js");
const root = path.resolve(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  await fs.access(chromePath);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "engbookmark-test-"));
  let browser;
  let socket;
  try {
    const fixture = path.join(temporary, "fixture");
    const profile = path.join(temporary, "profile");
    await fs.mkdir(fixture);
    for (const name of ["core.js", "popup.js", "popup.css"]) await fs.copyFile(path.join(root, name), path.join(fixture, name));
    await fs.cp(path.join(root, "icons"), path.join(fixture, "icons"), { recursive: true });
    const html = (await fs.readFile(path.join(root, "popup.html"), "utf8")).replace('<script src="core.js"', '<script src="mock.js"></script><script src="core.js"');
    await fs.writeFile(path.join(fixture, "popup.html"), html);
    const input = { videoId: "abcdefghijk", title: "Fluent English speakers can be hard to understand — Listening practice", kind: "point", start: 135.55 };
    const bookmarks = [
      createBookmark(input, new Date(2026, 9, 5, 9, 30), "one"),
      createBookmark({ ...input, title: "매일 듣는 영어 · 자연스러운 표현 익히기", kind: "range", start: 154.2, end: 167.8 }, new Date(2026, 9, 5, 10, 0), "two"),
      createBookmark(input, new Date(2026, 9, 4), "three"),
      createBookmark(input, new Date(2025, 11, 31), "four")
    ];
    await fs.writeFile(path.join(fixture, "mock.js"), `
      window.testState = { bookmarks: ${JSON.stringify(bookmarks)}, calls: [], listeners: [] };
      window.chrome = {
        runtime: { async sendMessage(message) {
          testState.calls.push(message);
          if (message.type === 'LIST') return { ok: true, bookmarks: structuredClone(testState.bookmarks) };
          if (message.type === 'DELETE') {
            testState.bookmarks = testState.bookmarks.filter(item => !message.ids.includes(item.id));
            testState.listeners.forEach(listener => listener({ bookmarks: {} }, 'local'));
          }
          return { ok: true };
        } },
        storage: { onChanged: { addListener(listener) { testState.listeners.push(listener); } } }
      };
    `);
    browser = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
    browser.on("error", () => {});
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
      catch { await delay(100); }
    }
    if (!port) throw new Error("Isolated Chrome did not start within 10 seconds.");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(item => item.type === "page");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const pending = new Map();
    const errors = [];
    let sequence = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
      if (message.id) {
        const item = pending.get(message.id);
        if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
      }
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      for (let attempt = 0; attempt < 50; attempt++) { if (await evaluate(expression)) return; await delay(40); }
      throw new Error(`UI condition failed: ${expression}`);
    };
    await cdp("Runtime.enable");
    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 420, height: 600, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: pathToFileURL(path.join(fixture, "popup.html")).href });
    await until("document.querySelectorAll('.bookmark').length === 4");
    assert.equal(await evaluate("document.querySelectorAll('details[open]').length"), 3);
    assert.equal(await evaluate("document.documentElement.scrollWidth"), 420);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true);
    assert.equal(await evaluate("document.querySelector('footer').getBoundingClientRect().bottom <= 600"), true);
    const output = path.join(root, ".test-artifacts");
    await fs.mkdir(output, { recursive: true });
    const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, "popup.png"), Buffer.from(screenshot.data, "base64"));
    await evaluate("document.querySelector('.play').click()");
    await until("testState.calls.some(call => call.type === 'PLAY' && call.id === 'two')");
    await evaluate("document.querySelector('.item-delete').click()");
    assert.equal(await evaluate("document.querySelector('dialog').open"), true);
    await evaluate("document.querySelector('button[value=cancel]').click()");
    await until("!document.querySelector('dialog').open");
    assert.equal(await evaluate("testState.bookmarks.length"), 4);
    await evaluate("document.querySelector('.item-delete').click(); document.querySelector('button[value=delete]').click()");
    await until("testState.bookmarks.length === 3 && document.querySelectorAll('.bookmark').length === 3");
    await evaluate("document.querySelector('.bookmark input').click(); document.getElementById('delete-selected').click()");
    assert.equal(await evaluate("document.getElementById('confirm-description').textContent.includes('1개')"), true);
    await evaluate("document.querySelector('button[value=delete]').click()");
    await until("testState.bookmarks.length === 2 && document.querySelectorAll('.bookmark').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('.day').length"), 2);
    await evaluate("document.querySelector('.folder-delete').click(); document.querySelector('button[value=delete]').click()");
    await until("testState.bookmarks.length === 1 && document.querySelectorAll('.bookmark').length === 1");
    await evaluate("document.querySelector('.folder-delete').click(); document.querySelector('button[value=delete]').click()");
    await until("testState.bookmarks.length === 0 && !document.getElementById('empty').hidden");
    assert.equal(await evaluate("document.querySelectorAll('details').length"), 0);
    const empty = await cdp("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, "empty.png"), Buffer.from(empty.data, "base64"));
    assert.deepEqual(errors, []);
    console.log("PASS: Chrome popup layout, play request, cancel, individual/selected/folder deletion and empty state.");
    console.log(`Screenshots: ${output}`);
    await cdp("Browser.close");
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) browser.kill();
    // Only remove the task-owned temporary directory created above.
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("engbookmark-test-")) {
      await delay(400);
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
