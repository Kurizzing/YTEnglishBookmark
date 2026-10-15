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
  const sync = existing.sync || {};
  const events = [];
  const tabs = existing.tabs || [{ id: 1, windowId: 1, url: "https://www.youtube.com/watch?v=abcdefghijk" }];
  const area = (data, limits = {}) => ({
    ...limits,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      return structuredClone(Object.fromEntries([keys].flat().map(key => [key, data[key]])));
    },
    async set(value) {
      await Promise.resolve();
      const next = { ...data, ...structuredClone(value) };
      if (limits.QUOTA_BYTES && Object.entries(next).reduce((sum, [key, item]) => sum + core.syncEntrySize(key, item), 0) > limits.QUOTA_BYTES) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(data, structuredClone(value));
    },
    async remove(keys) { [keys].flat().forEach(key => delete data[key]); }
  });
  const chrome = {
    runtime: { id: "test", onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: area(local), session: area(session), sync: area(sync, existing.syncLimits || { QUOTA_BYTES: 102400, MAX_ITEMS: 512 }), onChanged: { addListener() {} } },
    sidePanel: { async setPanelBehavior(options) { events.push(["panelBehavior", options.openPanelOnActionClick]); } },
    windows: { async getLastFocused() { return { id: 1 }; }, async get(id) { return { id }; }, async update(id) { events.push(["focus", id]); } },
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
  const ready = new Promise(resolve => setImmediate(resolve)).then(() => send({ type: "LIST" }));
  const sendReady = async (...args) => { await ready; return structuredClone(await send(...args)); };
  return { local, session, sync, tabs, events, send: sendReady, chrome };
}
const input = { videoId: "abcdefghijk", title: "Lesson", kind: "point", start: 20.123 };

test("toolbar action opens the persistent global side panel instead of a popup", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, "popup.html");
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(harness().events.some(event => event[0] === "panelBehavior" && event[1] === true));
});

test("concurrent saves, delete and service-worker restart retain persistent data", async () => {
  const h = harness();
  const saved = await Promise.all(Array.from({ length: 20 }, () => h.send({ type: "SAVE", bookmark: input })));
  assert.ok(saved.every(item => item.ok));
  assert.equal(Object.keys(h.sync).filter(key => key.startsWith("b:")).length, 20);
  await h.send({ type: "DELETE", ids: saved.slice(0, 5).map(item => item.bookmark.id) });
  const restarted = harness({ local: h.local, sync: h.sync, session: {} });
  assert.equal((await restarted.send({ type: "LIST" })).bookmarks.length, 15);
});

test("reject saves from a different video and report storage failure without false success", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "SAVE", bookmark: input }, { id: 2, url: "https://www.youtube.com/watch?v=zyxwvutsrqp" })).ok, false);
  h.chrome.storage.sync.set = h.chrome.storage.local.set = async () => { throw new Error("quota exceeded"); };
  const result = await h.send({ type: "SAVE", bookmark: input });
  assert.equal(result.ok, false);
  assert.equal(result.error, "quota exceeded");
  assert.equal((await h.send({ type: "LIST" })).bookmarks.length, 0);
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
  const h = harness({ tabs: [], sync: { ["b:" + bookmark.id]: core.packBookmark(bookmark) } });
  assert.equal((await h.send({ type: "PLAY", id: bookmark.id })).ok, true);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, bookmark.url);
  const next = core.createBookmark({ ...input, videoId: "zyxwvutsrqp" });
  h.sync["b:" + next.id] = core.packBookmark(next);
  await h.send({ type: "PLAY", id: next.id });
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, next.url);
});

test("panel playback uses its own window even when another window has the requested video", async () => {
  const bookmark = core.createBookmark(input);
  const h = harness({ sync: { ["b:" + bookmark.id]: core.packBookmark(bookmark) }, tabs: [
    { id: 1, windowId: 1, url: bookmark.url },
    { id: 2, windowId: 2, url: "https://www.youtube.com/" }
  ] });
  assert.equal((await h.send({ type: "PLAY", id: bookmark.id, windowId: 2 })).ok, true);
  assert.equal(h.session.playback.tabId, 2);
  assert.equal(h.tabs[1].url, bookmark.url);
  assert.deepEqual(h.events.filter(event => event[0] === "focus"), [["focus", 2]]);

  const newWindow = harness({ local: { bookmarks: [bookmark] }, tabs: [{ id: 1, windowId: 1, url: bookmark.url }] });
  await newWindow.send({ type: "PLAY", id: bookmark.id, windowId: 2 });
  assert.equal(newWindow.tabs.length, 2);
  assert.equal(newWindow.tabs[1].windowId, 2);
});

test("settings merge partial updates and reject duplicate shortcuts", async () => {
  const h = harness();
  assert.deepEqual((await h.send({ type: "GET_SETTINGS" })).settings.shortcuts, { point: "KeyQ", range: "KeyW" });
  await h.send({ type: "SET_SETTINGS", settings: { shortcuts: { point: "KeyA", range: "KeyS" } } });
  await h.send({ type: "SET_SETTINGS", settings: { autoCaptionRepeat: true } });
  assert.deepEqual(h.sync.settings, { autoCaptionRepeat: true, shortcuts: { point: "KeyA", range: "KeyS" } });
  assert.equal((await h.send({ type: "SET_SETTINGS", settings: { shortcuts: { point: "KeyS" } } })).ok, false);
  assert.equal((await h.send({ type: "SET_SETTINGS", settings: { shortcuts: { point: "Escape" } } })).ok, false);
  assert.equal(h.sync.settings.shortcuts.point, "KeyA");
});

test("migrate legacy local bookmarks and settings into sync, keeping the original as backup", async () => {
  const old = core.createBookmark(input, new Date(2026, 0, 2), "11111111-2222-3333-4444-555555555555");
  const h = harness({ local: { bookmarks: [old], settings: { autoCaptionRepeat: true } } });
  const { bookmarks } = await h.send({ type: "LIST" });
  assert.deepEqual(bookmarks.map(item => [item.id, item.localOnly]), [[old.id, undefined]]);
  assert.equal(bookmarks[0].date, "2026-01-02");
  assert.equal(h.sync.settings.autoCaptionRepeat, true);
  assert.equal(h.local.bookmarks.length, 1);
  assert.deepEqual(h.local.localBookmarks, []);
  const again = harness({ local: h.local, sync: h.sync });
  assert.equal((await again.send({ type: "LIST" })).bookmarks.length, 1);
});

test("overflow stays on this device and moves to sync after deletions free space", async () => {
  const h = harness({ syncLimits: { QUOTA_BYTES: 2048 + 120, MAX_ITEMS: 512 } });
  const first = await h.send({ type: "SAVE", bookmark: input });
  const second = await h.send({ type: "SAVE", bookmark: input });
  assert.equal(first.bookmark.localOnly, undefined);
  assert.equal(second.bookmark.localOnly, true);
  assert.equal(h.local.localBookmarks.length, 1);
  await h.send({ type: "DELETE", ids: [first.bookmark.id] });
  assert.deepEqual(h.local.localBookmarks, []);
  assert.ok(h.sync["b:" + second.bookmark.id]);
});

test("import restores valid bookmarks once and skips duplicates or invalid rows", async () => {
  const h = harness();
  const backup = [core.createBookmark(input, new Date(2026, 1, 3), "backup-one"), { id: "bad", videoId: "x" }];
  assert.deepEqual(await h.send({ type: "IMPORT", bookmarks: backup }), { ok: true, added: 1, skipped: 1, localOnly: 0 });
  assert.equal((await h.send({ type: "IMPORT", bookmarks: backup })).added, 0);
  const [restored] = (await h.send({ type: "LIST" })).bookmarks;
  assert.equal(restored.id, "backup-one");
  assert.equal(restored.date, "2026-02-03");
});
