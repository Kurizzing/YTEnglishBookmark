const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const events = new Map();
  const intervals = new Map();
  const sent = [];
  const saved = [];
  let runtimeListener;
  class Element {
    constructor() { this.children = {}; this.hidden = true; this.textContent = ""; }
    querySelector(selector) { return this.children[selector]; }
    addEventListener(type, callback) { this[type] = callback; }
    matches() { return !!this.editing; }
    append(child) { child.parentNode = this; }
    attachShadow() { return shadow; }
  }
  const notice = new Element();
  const status = new Element();
  status.children.span = new Element();
  status.children.button = new Element();
  const shadow = { getElementById(id) { return id === "notice" ? notice : status; } };
  const video = { currentTime: 12.345, readyState: 4, duration: 100, paused: false, ended: false, seeking: false, plays: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
  };
  const player = new Element();
  player.ad = false;
  player.live = false;
  player.matches = () => player.ad;
  player.classList = { contains: () => player.live };
  player.children["video.html5-main-video"] = video;
  const watch = { id: "abcdefghijk", getAttribute() { return this.id; }, hasAttribute() { return false; } };
  const location = { href: "https://www.youtube.com/watch?v=abcdefghijk" };
  const state = { playback: null, failure: false };
  const document = {
    title: "English lesson - YouTube",
    createElement() { return new Element(); },
    getElementById() { return player; },
    querySelector(selector) { return selector === "ytd-watch-flexy" ? watch : null; },
    addEventListener(type, callback) { events.set(type, callback); }
  };
  const chrome = { runtime: {
    id: "test",
    onMessage: { addListener(callback) { runtimeListener = callback; } },
    async sendMessage(message) {
      sent.push(message);
      if (message.type === "STATE") return { ok: true, playback: structuredClone(state.playback) };
      if (message.type === "SAVE") {
        if (state.failure) return { ok: false, error: "quota exceeded" };
        saved.push(message.bookmark);
      }
      if (message.type === "ACK" && state.playback?.id === message.requestId) state.playback.status = "applied";
      if (message.type === "STOP" && state.playback?.id === message.requestId) state.playback = null;
      return { ok: true };
    }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), {
    EngBookmark: core, chrome, document, location, Element, Date,
    setInterval(fn, ms) { intervals.set(ms, fn); }, setTimeout() { return 1; }, clearTimeout() {}
  });
  async function key(code, overrides = {}) {
    let prevented = false;
    await events.get("keydown")({ code, composedPath: () => [], preventDefault() { prevented = true; }, stopImmediatePropagation() {}, ...overrides });
    await flush();
    return prevented;
  }
  async function tick() { intervals.get(80)(); await flush(); }
  async function sync() { await intervals.get(1000)(); await flush(); }
  async function play(kind = "range", overrides = {}) {
    await flush();
    state.playback = { id: crypto.randomUUID(), status: "pending", createdAt: Date.now(), bookmark: { videoId: watch.id, kind, start: 20, end: 25, ...overrides } };
    await sync();
    await tick();
  }
  return { events, saved, sent, video, player, watch, location, state, notice, status, Element, key, tick, sync, play, reset: message => runtimeListener(message) };
}

test("Q saves fractional current time without seeking or pausing; physical Q works with Korean key", async () => {
  const h = harness();
  await flush();
  await h.key("KeyQ", { key: "ㅂ" });
  assert.equal(h.saved[0].start, 12.345);
  assert.equal(h.saved[0].kind, "point");
  assert.equal(h.saved[0].title, "English lesson");
  assert.equal(h.video.currentTime, 12.345);
  assert.equal(h.video.plays, 0);
  assert.match(h.notice.textContent, /저장했습니다/);
});

test("ignore editing, IME composition, modifiers and repeated keys", async () => {
  const h = harness();
  const input = new h.Element();
  input.editing = true;
  for (const overrides of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { composedPath: () => [input] }]) {
    assert.equal(await h.key("KeyQ", overrides), false);
  }
  assert.equal(h.saved.length, 0);
});

test("W saves a range without playback, invalid end is retryable, and Esc cancels draft", async () => {
  const h = harness();
  await h.key("KeyW");
  h.video.currentTime = 5;
  await h.key("KeyW");
  assert.equal(h.saved.length, 0);
  h.video.currentTime = 20.5;
  await h.key("KeyW");
  assert.equal(h.saved[0].start, 12.345);
  assert.equal(h.saved[0].end, 20.5);
  assert.equal(h.video.plays, 0);
  assert.equal(h.video.currentTime, 20.5);
  await h.key("KeyW");
  await h.key("Escape");
  h.video.currentTime = 30;
  await h.key("KeyW");
  assert.equal(h.saved.length, 1);
  assert.match(h.status.children.span.textContent, /00:30/);
});

test("failed range persistence shows failure and retains start for retry", async () => {
  const h = harness();
  await h.key("KeyW");
  h.video.currentTime = 22;
  h.state.failure = true;
  await h.key("KeyW");
  assert.equal(h.saved.length, 0);
  assert.match(h.notice.textContent, /저장 실패/);
  h.state.failure = false;
  await h.key("KeyW");
  assert.equal(h.saved[0].start, 12.345);
});

test("range loops, honors pause, resumes after natural end and stops via Esc", async () => {
  const h = harness();
  await h.play();
  assert.equal(h.video.currentTime, 20);
  assert.equal(h.video.plays, 1);
  h.video.currentTime = 25.05;
  await h.tick();
  assert.equal(h.video.currentTime, 20);
  h.video.currentTime = 25.1;
  h.video.paused = true;
  await h.tick();
  assert.equal(h.video.currentTime, 25.1);
  assert.equal(h.video.plays, 1);
  h.video.ended = true;
  await h.tick();
  assert.equal(h.video.currentTime, 20);
  assert.equal(h.video.plays, 2);
  h.video.ended = false;
  await h.key("Escape");
  h.video.currentTime = 30;
  await h.tick();
  assert.equal(h.video.currentTime, 30);
});

test("point selection cancels loop and seeks once; reset and button clear repeat", async () => {
  const h = harness();
  await h.play();
  await h.play("point", { start: 40 });
  assert.equal(h.video.currentTime, 40);
  h.video.currentTime = 45;
  await h.tick();
  assert.equal(h.video.currentTime, 45);
  await h.play();
  h.status.children.button.click();
  h.video.currentTime = 30;
  await h.tick();
  assert.equal(h.video.currentTime, 30);
  await h.play();
  h.reset({ type: "RESET", requestId: h.state.playback.id });
  h.video.currentTime = 30;
  await h.tick();
  assert.equal(h.video.currentTime, 30);
});

test("ads and old player metadata defer seeks; unsupported live content cannot be saved", async () => {
  const h = harness();
  h.player.ad = true;
  await h.key("KeyQ");
  await h.play();
  assert.equal(h.saved.length, 0);
  assert.equal(h.video.currentTime, 12.345);
  h.player.ad = false;
  h.watch.id = "zyxwvutsrqp";
  await h.tick();
  assert.equal(h.video.currentTime, 12.345);
  h.watch.id = "abcdefghijk";
  await h.tick();
  assert.equal(h.video.currentTime, 20);
  h.player.ad = true;
  h.video.currentTime = 27;
  await h.tick();
  assert.equal(h.video.currentTime, 27);
  h.player.ad = false;
  await h.tick();
  assert.equal(h.video.currentTime, 20);
  h.player.live = true;
  await h.key("KeyQ");
  assert.equal(h.saved.length, 0);
});

test("navigation clears draft and loop; newer pending request wins while an ad is showing", async () => {
  const h = harness();
  await h.key("KeyW");
  h.events.get("yt-navigate-start")();
  h.location.href = "https://www.youtube.com/watch?v=zyxwvutsrqp";
  h.watch.id = "zyxwvutsrqp";
  h.events.get("yt-navigate-finish")();
  h.events.get("loadedmetadata")({ target: h.video });
  await flush();
  await h.key("KeyW");
  assert.equal(h.saved.length, 0);
  h.player.ad = true;
  await h.play("point", { start: 30 });
  await h.play("range", { start: 50, end: 55 });
  h.player.ad = false;
  await h.tick();
  assert.equal(h.video.currentTime, 50);
  h.events.get("yt-navigate-start")();
  h.video.currentTime = 60;
  await h.tick();
  assert.equal(h.video.currentTime, 60);
});

test("buffering play promise does not prevent a newer bookmark from applying", async () => {
  const h = harness();
  h.video.play = () => new Promise(() => {});
  await h.play("point", { start: 30 });
  await h.play("point", { start: 50 });
  assert.equal(h.video.currentTime, 50);
});

test("navigation finish alone cannot seek the previous video's loaded media", async () => {
  const h = harness();
  await flush();
  h.events.get("yt-navigate-start")();
  h.location.href = "https://www.youtube.com/watch?v=zyxwvutsrqp";
  h.watch.id = "zyxwvutsrqp";
  h.events.get("yt-navigate-finish")();
  await h.play();
  assert.equal(h.video.currentTime, 12.345);
  h.events.get("loadedmetadata")({ target: h.video });
  await h.tick();
  assert.equal(h.video.currentTime, 20);
});
