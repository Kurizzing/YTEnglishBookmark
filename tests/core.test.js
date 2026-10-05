const test = require("node:test");
const assert = require("node:assert/strict");
const { createBookmark, videoId, localDate, formatTime, groupBookmarks, chooseTab, serialQueue, RangeDraft } = require("../core.js");
const input = { videoId: "abcdefghijk", title: "Listening", kind: "point", start: 12.345 };

test("normalize YouTube watch URLs, reject unsupported pages", () => {
  assert.equal(videoId("https://www.youtube.com/watch?v=abcdefghijk&list=extra&t=20s"), input.videoId);
  for (const url of ["invalid", "https://evil.test/watch?v=abcdefghijk", "https://www.youtube.com/shorts/abcdefghijk", "https://www.youtube.com/watch?v=x"]) assert.equal(videoId(url), null);
});

test("preserve fractional seconds, local save date and independent IDs", () => {
  const date = new Date(2026, 0, 1, 0, 0, 1);
  const bookmark = createBookmark(input, date, "first");
  assert.equal(bookmark.start, 12.345);
  assert.equal(bookmark.date, "2026-01-01");
  assert.equal(bookmark.createdAt, date.toISOString());
  assert.equal(bookmark.url, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal("end" in bookmark, false);
  assert.notEqual(createBookmark(input).id, createBookmark(input).id);
  assert.equal(localDate(new Date(2025, 11, 31, 23, 59, 59)), "2025-12-31");
});

test("reject malformed points and ranges", () => {
  for (const patch of [{ start: -1 }, { start: NaN }, { kind: "other" }, { videoId: "bad" }, { kind: "range", end: 12 }, { kind: "range", end: Infinity }]) {
    assert.throws(() => createBookmark({ ...input, ...patch }));
  }
  assert.equal(createBookmark({ ...input, kind: "range", end: 20.456 }).end, 20.456);
});

test("format minute and hour timestamps", () => {
  assert.equal(formatTime(135.99), "02:15");
  assert.equal(formatTime(3601), "1:00:01");
  assert.equal(formatTime(0), "00:00");
});

test("group newest-first across year, month and day boundaries; folder IDs include descendants", () => {
  const items = [
    createBookmark(input, new Date(2025, 11, 31), "old"),
    createBookmark(input, new Date(2026, 0, 2, 1), "early"),
    createBookmark(input, new Date(2026, 0, 2, 2), "late"),
    createBookmark(input, new Date(2026, 1, 1), "new")
  ];
  const groups = groupBookmarks(items);
  assert.deepEqual(groups.map(group => group.key), ["2026", "2025"]);
  assert.deepEqual(groups[0].ids, ["new", "late", "early"]);
  assert.deepEqual([...groups[0].children.keys()], ["02", "01"]);
  assert.deepEqual(groups[0].children.get("01").children.get("02").bookmarks.map(item => item.id), ["late", "early"]);
  assert.deepEqual(groupBookmarks([]), []);
});

test("prefer same-video current-window, other-window, current-window YouTube, then new tab", () => {
  const sameUrl = "https://www.youtube.com/watch?v=abcdefghijk";
  const tabs = [
    { id: 1, windowId: 1, url: sameUrl, lastAccessed: 10 },
    { id: 2, windowId: 2, url: sameUrl, lastAccessed: 30 },
    { id: 3, windowId: 1, url: "https://www.youtube.com/", lastAccessed: 40 },
    { id: 4, windowId: 1, url: sameUrl, lastAccessed: 20 }
  ];
  assert.equal(chooseTab(tabs, input.videoId, 1).id, 4);
  assert.equal(chooseTab(tabs.slice(1, 3), input.videoId, 1).id, 2);
  assert.equal(chooseTab(tabs.slice(2, 3), input.videoId, 1).id, 3);
  assert.equal(chooseTab([{ ...tabs[2], windowId: 2 }], input.videoId, 1), null);
});

test("range state: invalid end retains start, save failure permits retry, cancel/navigation resets", () => {
  const draft = new RangeDraft();
  assert.equal(draft.mark("a", 10).status, "started");
  assert.equal(draft.mark("a", 10).status, "invalid");
  assert.equal(draft.mark("a", 9).status, "invalid");
  assert.deepEqual(draft.mark("a", 20), { status: "complete", start: 10, end: 20 });
  assert.deepEqual(draft.mark("a", 21), { status: "complete", start: 10, end: 21 });
  assert.equal(draft.mark("b", 8).status, "started");
  draft.cancel();
  assert.equal(draft.value, null);
});

test("serialized mutations avoid lost writes and recover after an error", async () => {
  const enqueue = serialQueue();
  let value = 0;
  await Promise.all(Array.from({ length: 20 }, () => enqueue(async () => {
    const previous = value;
    await new Promise(resolve => setImmediate(resolve));
    value = previous + 1;
  })));
  assert.equal(value, 20);
  await assert.rejects(enqueue(() => { throw new Error("disk full"); }));
  await enqueue(() => { value++; });
  assert.equal(value, 21);
});
