const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");

function harness(existing = {}) {
  let listener;
  const local = existing.local || {};
  const session = existing.session || {};
  const events = [];
  const tabs = existing.tabs || [{ id: 1, windowId: 1, url: "https://www.youtube.com/watch?v=abcdefghijk" }];
  const area = data => ({
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(value) { await Promise.resolve(); Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; }
  });
  const chrome = {
    runtime: { id: "test", onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: area(local), session: area(session) },
    windows: { async getLastFocused() { return { id: 1 }; }, async update(id) { events.push(["focus", id]); } },
    tabs: {
      async query() { return tabs; },
      async create(options) { const tab = { id: tabs.length + 1, ...options }; tabs.push(tab); events.push(["create", tab.id]); return tab; },
      async update(id, options) { Object.assign(tabs.find(tab => tab.id === id), options); events.push(["update", id]); },
      async sendMessage(id, message) { events.push([message.type, id]); },
      onRemoved: { addListener() {} }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), { chrome, EngBookmark: core, importScripts() {}, crypto, Date, Set });
  const send = (message, tab = tabs[0]) => new Promise(resolve => listener(message, { id: "test", tab }, resolve));
  return { local, session, tabs, events, send, chrome };
}
const input = { videoId: "abcdefghijk", title: "Lesson", kind: "point", start: 20.123 };

test("concurrent saves, delete and service-worker restart retain persistent data", async () => {
  const h = harness();
  const saved = await Promise.all(Array.from({ length: 20 }, () => h.send({ type: "SAVE", bookmark: input })));
  assert.ok(saved.every(item => item.ok));
  assert.equal(h.local.bookmarks.length, 20);
  await h.send({ type: "DELETE", ids: saved.slice(0, 5).map(item => item.bookmark.id) });
  const restarted = harness({ local: h.local, session: {} });
  assert.equal((await restarted.send({ type: "LIST" })).bookmarks.length, 15);
});

test("reject saves from a different video and report storage failure without false success", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "SAVE", bookmark: input }, { id: 2, url: "https://www.youtube.com/watch?v=zyxwvutsrqp" })).ok, false);
  h.chrome.storage.local.set = async () => { throw new Error("quota exceeded"); };
  const result = await h.send({ type: "SAVE", bookmark: input });
  assert.equal(result.ok, false);
  assert.equal(result.error, "quota exceeded");
  assert.equal(h.local.bookmarks, undefined);
});

test("last playback wins, stale ACK/STOP cannot cancel it, deleting active bookmark stops it", async () => {
  const h = harness();
  const first = (await h.send({ type: "SAVE", bookmark: input })).bookmark;
  const second = (await h.send({ type: "SAVE", bookmark: { ...input, kind: "range", end: 30 } })).bookmark;
  await h.send({ type: "PLAY", id: first.id });
  const oldId = h.session.playback.id;
  await h.send({ type: "PLAY", id: second.id });
  await h.send({ type: "ACK", requestId: oldId });
  await h.send({ type: "STOP", requestId: oldId });
  assert.equal(h.session.playback.bookmark.id, second.id);
  assert.equal(h.session.playback.status, "pending");
  assert.equal((await h.send({ type: "STATE" }, { id: 99 })).playback, null);
  await h.send({ type: "ACK", requestId: h.session.playback.id });
  assert.equal(h.session.playback.status, "applied");
  assert.ok(h.events.some(event => event[0] === "RESET"));
  await h.send({ type: "DELETE", ids: [second.id] });
  assert.equal(h.session.playback, undefined);
});

test("create a tab when none exists; reuse current-window YouTube when switching videos", async () => {
  const bookmark = core.createBookmark(input);
  const h = harness({ tabs: [], local: { bookmarks: [bookmark] } });
  assert.equal((await h.send({ type: "PLAY", id: bookmark.id })).ok, true);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, bookmark.url);
  const next = core.createBookmark({ ...input, videoId: "zyxwvutsrqp" });
  h.local.bookmarks.push(next);
  await h.send({ type: "PLAY", id: next.id });
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, next.url);
});
