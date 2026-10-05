"use strict";
importScripts("core.js");

const queue = EngBookmark.serialQueue();
const getBookmarks = async () => (await chrome.storage.local.get("bookmarks")).bookmarks || [];
const getPlayback = async () => (await chrome.storage.session.get("playback")).playback || null;

async function stopPlayback(playback) {
  if (!playback) return;
  try { await chrome.tabs.sendMessage(playback.tabId, { type: "RESET", requestId: playback.id }); } catch { /* The tab may have navigated or closed. */ }
}

async function dispatch(message, sender) {
  switch (message.type) {
    case "LIST":
      return { bookmarks: await getBookmarks() };
    case "SAVE": {
      const bookmark = EngBookmark.createBookmark(message.bookmark);
      if (EngBookmark.videoId(sender.tab?.url) !== bookmark.videoId) throw new Error("영상이 변경되었습니다. 다시 저장해 주세요.");
      const bookmarks = await getBookmarks();
      await chrome.storage.local.set({ bookmarks: [...bookmarks, bookmark] });
      return { bookmark };
    }
    case "DELETE": {
      const ids = new Set(message.ids);
      const bookmarks = await getBookmarks();
      await chrome.storage.local.set({ bookmarks: bookmarks.filter(bookmark => !ids.has(bookmark.id)) });
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
      const window = await chrome.windows.getLastFocused();
      const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      let tab = EngBookmark.chooseTab(tabs, bookmark.videoId, window.id);
      const previous = await getPlayback();
      await chrome.storage.session.remove("playback");
      await stopPlayback(previous);
      if (!tab) tab = await chrome.tabs.create({ windowId: window.id, url: bookmark.url, active: true });
      const playback = { id: crypto.randomUUID(), tabId: tab.id, bookmark, status: "pending", createdAt: Date.now() };
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

chrome.tabs.onRemoved.addListener(tabId => {
  queue(async () => {
    const playback = await getPlayback();
    if (playback?.tabId === tabId) await chrome.storage.session.remove("playback");
  }).catch(() => {});
});
