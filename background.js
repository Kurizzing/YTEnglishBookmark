"use strict";
importScripts("core.js");

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

const queue = EngBookmark.serialQueue();
const { SYNC_PREFIX, packBookmark, unpackBookmark, syncEntrySize } = EngBookmark;
// Leave room for settings and per-item overhead below chrome.storage.sync's hard limits.
const SYNC_BUDGET = (chrome.storage.sync.QUOTA_BYTES ?? 102400) - 2048;
const SYNC_MAX_ITEMS = (chrome.storage.sync.MAX_ITEMS ?? 512) - 4;
const getSettings = async () => EngBookmark.normalizeSettings((await chrome.storage.sync.get("settings")).settings);
const getLocalOnly = async () => (await chrome.storage.local.get("localBookmarks")).localBookmarks || [];

async function readSync() {
  const entries = Object.entries(await chrome.storage.sync.get(null));
  const usage = { bytes: entries.reduce((sum, [key, value]) => sum + syncEntrySize(key, value), 0), items: entries.length };
  const bookmarks = entries.filter(([key]) => key.startsWith(SYNC_PREFIX)).map(([key, value]) => unpackBookmark(key.slice(SYNC_PREFIX.length), value)).filter(Boolean);
  return { bookmarks, usage };
}

async function getBookmarks() {
  const [{ bookmarks }, localOnly] = await Promise.all([readSync(), getLocalOnly()]);
  return [...bookmarks, ...localOnly.map(bookmark => ({ ...bookmark, localOnly: true }))];
}

// Writes as many bookmarks to sync as fit in one call and returns the rest for local storage.
async function writeSync(bookmarks) {
  const { usage } = await readSync();
  const entries = {};
  const rest = [];
  for (const bookmark of bookmarks) {
    const key = SYNC_PREFIX + bookmark.id;
    const value = packBookmark(bookmark);
    const size = syncEntrySize(key, value);
    if (usage.bytes + size <= SYNC_BUDGET && usage.items < SYNC_MAX_ITEMS) {
      entries[key] = value;
      usage.bytes += size;
      usage.items++;
    } else rest.push(bookmark);
  }
  if (!Object.keys(entries).length) return rest;
  try {
    await chrome.storage.sync.set(entries);
    return rest;
  } catch (error) {
    console.warn("Bookmark sync failed; keeping on this device.", error);
    return bookmarks;
  }
}

// Moves device-only bookmarks into sync once space is available (e.g. after deletions elsewhere).
async function promoteLocalOnly() {
  const localOnly = await getLocalOnly();
  if (!localOnly.length) return;
  const synced = new Set((await readSync()).bookmarks.map(bookmark => bookmark.id));
  const pending = localOnly.filter(bookmark => !synced.has(bookmark.id));
  const rest = await writeSync(pending);
  if (rest.length !== localOnly.length) await chrome.storage.local.set({ localBookmarks: rest });
}

// Older versions kept everything in storage.local; the original array is left in place as a backup.
async function migrate() {
  const { bookmarks: legacy, settings, syncMigrated } = await chrome.storage.local.get(["bookmarks", "settings", "syncMigrated"]);
  if (syncMigrated) return;
  if (settings && !(await chrome.storage.sync.get("settings")).settings) await chrome.storage.sync.set({ settings: EngBookmark.normalizeSettings(settings) });
  if (legacy?.length) {
    const known = new Set((await getBookmarks()).map(bookmark => bookmark.id));
    await chrome.storage.local.set({ localBookmarks: [...await getLocalOnly(), ...legacy.filter(bookmark => !known.has(bookmark.id))] });
  }
  await chrome.storage.local.set({ syncMigrated: true });
}

async function addBookmarks(bookmarks) {
  const rest = await writeSync(bookmarks);
  if (rest.length) await chrome.storage.local.set({ localBookmarks: [...await getLocalOnly(), ...rest] });
  return rest.length;
}

const getPlayback = async () => (await chrome.storage.session.get("playback")).playback || null;

async function stopPlayback(playback) {
  if (!playback) return;
  try { await chrome.tabs.sendMessage(playback.tabId, { type: "RESET", requestId: playback.id }); } catch { /* The tab may have navigated or closed. */ }
}

async function dispatch(message, sender) {
  switch (message.type) {
    case "LIST": {
      const { usage } = await readSync();
      return { bookmarks: await getBookmarks(), usage: { bytes: usage.bytes, quota: SYNC_BUDGET } };
    }
    case "GET_SETTINGS":
      return { settings: await getSettings() };
    case "SET_SETTINGS": {
      const current = await getSettings();
      const patch = message.settings || {};
      const shortcuts = { ...current.shortcuts, ...patch.shortcuts };
      if (shortcuts.point === shortcuts.range) throw new Error("두 단축키는 서로 달라야 합니다.");
      if (![shortcuts.point, shortcuts.range].every(EngBookmark.isShortcutCode)) throw new Error("영문자나 숫자 키만 사용할 수 있습니다.");
      const settings = EngBookmark.normalizeSettings({ ...current, ...patch, shortcuts });
      await chrome.storage.sync.set({ settings });
      return { settings };
    }
    case "SAVE": {
      const bookmark = EngBookmark.createBookmark(message.bookmark);
      if (EngBookmark.videoId(sender.tab?.url) !== bookmark.videoId) throw new Error("영상이 변경되었습니다. 다시 저장해 주세요.");
      const localOnly = await addBookmarks([bookmark]) > 0;
      return { bookmark: { ...bookmark, ...(localOnly ? { localOnly } : {}) } };
    }
    case "IMPORT": {
      const known = new Set((await getBookmarks()).map(bookmark => bookmark.id));
      const restored = (Array.isArray(message.bookmarks) ? message.bookmarks : []).map(EngBookmark.restoreBookmark).filter(Boolean);
      const added = restored.filter(bookmark => !known.has(bookmark.id) && known.add(bookmark.id));
      const localOnly = added.length ? await addBookmarks(added) : 0;
      return { added: added.length, skipped: (message.bookmarks?.length || 0) - added.length, localOnly };
    }
    case "DELETE": {
      const ids = new Set(message.ids);
      await chrome.storage.sync.remove([...ids].map(id => SYNC_PREFIX + id));
      const localOnly = await getLocalOnly();
      if (localOnly.some(bookmark => ids.has(bookmark.id))) await chrome.storage.local.set({ localBookmarks: localOnly.filter(bookmark => !ids.has(bookmark.id)) });
      await promoteLocalOnly();
      const playback = await getPlayback();
      if (playback && ids.has(playback.bookmark.id)) {
        await chrome.storage.session.remove("playback");
        await stopPlayback(playback);
      }
      return {};
    }
    case "PLAY": {
      const bookmark = (await getBookmarks()).find(item => item.id === message.id);
      if (!bookmark) throw new Error("삭제된 북마크입니다. 목록을 다시 확인해 주세요.");
      const window = Number.isInteger(message.windowId) ? await chrome.windows.get(message.windowId) : await chrome.windows.getLastFocused();
      const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      let tab = EngBookmark.chooseTab(tabs, bookmark.videoId, window.id);
      const previous = await getPlayback();
      await chrome.storage.session.remove("playback");
      await stopPlayback(previous);
      if (!tab) tab = await chrome.tabs.create({ windowId: window.id, url: bookmark.url, active: true });
      const settings = await getSettings();
      const playback = { id: crypto.randomUUID(), tabId: tab.id, bookmark, settings, status: "pending", createdAt: Date.now() };
      await chrome.storage.session.set({ playback });
      try {
        if (EngBookmark.videoId(tab.url) !== bookmark.videoId) await chrome.tabs.update(tab.id, { url: bookmark.url, active: true });
        else await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        // Polling in the content script also handles navigation and sleeping workers.
        try { await chrome.tabs.sendMessage(tab.id, { type: "SYNC" }); } catch { /* Wait for the content script to load. */ }
      } catch (error) {
        await chrome.storage.session.remove("playback");
        throw error;
      }
      return {};
    }
    case "STATE": {
      const playback = await getPlayback();
      return { playback: playback?.tabId === sender.tab?.id ? playback : null };
    }
    case "ACK": {
      const playback = await getPlayback();
      if (playback?.tabId === sender.tab?.id && playback.id === message.requestId) {
        await chrome.storage.session.set({ playback: { ...playback, status: "applied" } });
      }
      return {};
    }
    case "STOP": {
      const playback = await getPlayback();
      if (playback?.tabId === sender.tab?.id && playback.id === message.requestId) await chrome.storage.session.remove("playback");
      return {};
    }
    default:
      throw new Error("알 수 없는 요청입니다.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  queue(() => dispatch(message, sender)).then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: error.message || "요청을 처리하지 못했습니다." })
  );
  return true;
});

queue(async () => {
  await migrate();
  await promoteLocalOnly();
}).catch(console.error);

chrome.storage.onChanged.addListener((changes, area) => {
  // Deletions on another device may free room for bookmarks kept only on this one.
  if (area === "sync" && Object.entries(changes).some(([key, change]) => key.startsWith(SYNC_PREFIX) && change.newValue === undefined)) {
    queue(promoteLocalOnly).catch(console.error);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  queue(async () => {
    const playback = await getPlayback();
    if (playback?.tabId === tabId) await chrome.storage.session.remove("playback");
  }).catch(() => {});
});
