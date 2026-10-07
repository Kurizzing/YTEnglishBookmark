(function (root) {
  "use strict";

  function videoId(url) {
    try {
      const parsed = new URL(url);
      const id = parsed.searchParams.get("v");
      return parsed.origin === "https://www.youtube.com" && parsed.pathname === "/watch" && /^[\w-]{11}$/.test(id || "") ? id : null;
    } catch {
      return null;
    }
  }

  function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value / 60) % 60;
    const rest = String(value % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${String(minutes).padStart(2, "0")}:${rest}`;
  }

  function createBookmark(input, now = new Date(), id = crypto.randomUUID()) {
    if (!input || !/^[\w-]{11}$/.test(input.videoId || "") || !["point", "range"].includes(input.kind) ||
        !Number.isFinite(input.start) || input.start < 0 ||
        (input.kind === "range" && (!Number.isFinite(input.end) || input.end <= input.start))) {
      throw new Error("유효한 영상과 재생 구간을 확인해 주세요.");
    }
    return {
      id,
      videoId: input.videoId,
      title: String(input.title || "제목 없는 영상"),
      url: `https://www.youtube.com/watch?v=${input.videoId}`,
      kind: input.kind,
      start: input.start,
      ...(input.kind === "range" ? { end: input.end } : {}),
      createdAt: now.toISOString(),
      date: localDate(now)
    };
  }

  function groupBookmarks(bookmarks) {
    const months = new Map();
    const sorted = [...bookmarks].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    for (const bookmark of sorted) {
      const [year, month, day] = bookmark.date.split("-");
      const monthKey = `${year}-${month}`;
      if (!months.has(monthKey)) months.set(monthKey, { key: monthKey, label: `${Number(month)}월`, children: new Map(), ids: [] });
      const monthNode = months.get(monthKey);
      if (!monthNode.children.has(day)) monthNode.children.set(day, { key: bookmark.date, label: `${Number(day)}일`, bookmarks: [], ids: [] });
      const dayNode = monthNode.children.get(day);
      monthNode.ids.push(bookmark.id);
      dayNode.ids.push(bookmark.id);
      dayNode.bookmarks.push(bookmark);
    }
    const monthCounts = new Map();
    for (const key of months.keys()) {
      const month = key.slice(5);
      monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
    }
    for (const node of months.values()) {
      const [year, month] = node.key.split("-");
      if (monthCounts.get(month) > 1) node.label = `${year}년 ${Number(month)}월`;
    }
    return [...months.values()];
  }

  function chooseTab(tabs, id, windowId) {
    const eligible = tabs.filter(tab => {
      try { return tab.windowId === windowId && new URL(tab.url).origin === "https://www.youtube.com"; } catch { return false; }
    });
    const rank = tab => videoId(tab.url) === id ? 0 : 1;
    return eligible.sort((a, b) => rank(a) - rank(b) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  }

  function serialQueue() {
    let tail = Promise.resolve();
    return operation => {
      const result = tail.then(operation);
      tail = result.catch(() => {});
      return result;
    };
  }

  class RangeDraft {
    constructor() { this.cancel(); }
    cancel() { this.value = null; }
    mark(id, time) {
      if (!this.value || this.value.videoId !== id) {
        this.value = { videoId: id, start: time };
        return { status: "started", start: time };
      }
      if (time <= this.value.start) return { status: "invalid", start: this.value.start };
      // Keep the draft until persistence succeeds, so a failed save can be retried.
      return { status: "complete", start: this.value.start, end: time };
    }
  }

  const api = { videoId, localDate, formatTime, createBookmark, groupBookmarks, chooseTab, serialQueue, RangeDraft };
  root.EngBookmark = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
