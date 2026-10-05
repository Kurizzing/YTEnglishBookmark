(() => {
  "use strict";
  const { videoId, formatTime, RangeDraft } = EngBookmark;
  const draft = new RangeDraft();
  let currentId = videoId(location.href);
  let navigating = false;
  let awaitingMetadata = false;
  let navigationOriginId = currentId;
  let command = null;
  let loop = null;
  let applying = false;
  let syncing = false;
  let savingRange = false;
  let lastApplied = null;
  let waitStartedAt = 0;
  let noticeTimer;

  const host = document.createElement("div");
  host.id = "engbookmark-overlay";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    :host { all: initial; position: absolute; top: 18px; right: 18px; z-index: 2147483647; pointer-events: none; }
    .stack { display: flex; align-items: flex-end; flex-direction: column; gap: 8px; font: 13px/1.5 system-ui, sans-serif; }
    .pill { max-width: 320px; padding: 10px 14px; border: 1px solid #ffffff26; border-radius: 12px; color: #fff; background: #172b2bef; box-shadow: 0 4px 20px #0004; }
    [hidden] { display: none !important; }
    button { margin-left: 12px; padding: 5px 8px; border: 0; border-radius: 6px; background: #b9f5d8; color: #102e24; font: inherit; cursor: pointer; pointer-events: auto; }
    button:focus-visible { outline: 2px solid white; outline-offset: 3px; }
  </style><div class="stack"><div class="pill" id="notice" role="status" hidden></div><div class="pill" id="status" hidden><span></span><button type="button">취소</button></div></div>`;
  const notice = shadow.getElementById("notice");
  const status = shadow.getElementById("status");
  status.querySelector("button").addEventListener("click", () => cancel(true));

  function mount() {
    const player = document.getElementById("movie_player");
    if (player && host.parentNode !== player) player.append(host);
  }

  function toast(text, duration = 3200) {
    mount();
    notice.textContent = text;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, duration);
  }

  function renderStatus() {
    mount();
    const range = draft.value;
    status.hidden = !range && !loop;
    status.querySelector("span").textContent = range ? `${formatTime(range.start)}부터 구간 지정 중 · W로 끝점` :
      loop ? `${formatTime(loop.start)}–${formatTime(loop.end)} 반복 중` : "";
    status.querySelector("button").textContent = range ? "구간 취소 · Esc" : "반복 해제 · Esc";
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "확장 프로그램을 새로고침했다면 유튜브 페이지도 새로고침해 주세요.");
    return response;
  }

  function cancel(showNotice = false) {
    const id = command?.id || loop?.requestId;
    draft.cancel();
    command = null;
    loop = null;
    if (id) request({ type: "STOP", requestId: id }).catch(() => {});
    renderStatus();
    if (showNotice) toast("구간 지정과 반복을 해제했습니다.");
  }

  function context() {
    const id = videoId(location.href);
    const player = document.getElementById("movie_player");
    const video = player?.querySelector("video.html5-main-video");
    const watch = document.querySelector("ytd-watch-flexy");
    const ad = !!player?.matches(".ad-showing, .ad-interrupting");
    const live = !!player?.classList.contains("ytp-live") || !!watch?.hasAttribute("is-live");
    // The URL can change before YouTube has replaced the previous video's player.
    const matching = watch?.getAttribute("video-id") === id;
    return { id, player, video, ad, live, ready: !!(id && matching && !navigating && !awaitingMetadata && video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0 && !ad && !live) };
  }

  function checkNavigation() {
    const id = videoId(location.href);
    if (id !== currentId) {
      currentId = id;
      draft.cancel();
      if (loop || command?.status === "applied") cancel();
      renderStatus();
    }
  }

  function bookmarkInput(ctx, kind, start, end) {
    return {
      videoId: ctx.id,
      title: document.querySelector("ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, #title h1")?.textContent?.trim() || document.title.replace(/ - YouTube$/, ""),
      kind, start, ...(kind === "range" ? { end } : {})
    };
  }

  function isEditing(event) {
    return event.composedPath().some(node => node instanceof Element &&
      (node.matches("input, textarea, select, [role='textbox'], [role='combobox']") || node.isContentEditable));
  }

  document.addEventListener("keydown", async event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || isEditing(event)) return;
    if (event.code === "Escape") {
      if (draft.value || loop || command?.status === "pending") cancel(true);
      return;
    }
    if (!["KeyQ", "KeyW"].includes(event.code)) return;
    checkNavigation();
    if (!videoId(location.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const ctx = context();
    if (!ctx.ready) {
      toast(ctx.ad ? "광고가 끝난 뒤 저장해 주세요." : ctx.live ? "실시간 방송은 지원하지 않습니다." : "영상이 준비된 뒤 다시 눌러 주세요.");
      return;
    }
    try {
      if (event.code === "KeyQ") {
        const start = ctx.video.currentTime;
        await request({ type: "SAVE", bookmark: bookmarkInput(ctx, "point", start) });
        toast(`${formatTime(start)} 시점을 저장했습니다.`);
      } else {
        if (savingRange) return;
        const result = draft.mark(ctx.id, ctx.video.currentTime);
        renderStatus();
        if (result.status === "started") {
          toast("시작점을 지정했습니다. W를 다시 눌러 끝점을 저장하세요.");
        } else if (result.status === "invalid") {
          toast("끝점은 시작점보다 뒤여야 합니다. 이동 후 W를 다시 눌러 주세요.");
        } else {
          savingRange = true;
          const savedDraft = draft.value;
          try {
            await request({ type: "SAVE", bookmark: bookmarkInput(ctx, "range", result.start, result.end) });
            if (draft.value === savedDraft) draft.cancel();
            renderStatus();
            toast(`${formatTime(result.start)}–${formatTime(result.end)} 구간을 저장했습니다.`);
          } finally { savingRange = false; }
        }
      }
    } catch (error) { toast(`저장 실패: ${error.message}`, 6000); }
  }, true);

  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const { playback } = await request({ type: "STATE" });
      if (!playback) {
        command = null;
        if (loop) { loop = null; renderStatus(); }
      } else if (command?.id !== playback.id) {
        loop = null;
        draft.cancel();
        command = playback;
        waitStartedAt = Date.now();
        renderStatus();
      } else {
        command.status = playback.status;
      }
    } catch {
      if (!chrome.runtime?.id) {
        loop = null;
        command = null;
        renderStatus();
      }
    } finally { syncing = false; }
  }

  async function applyPending(ctx) {
    if (applying || !command || command.status !== "pending" || lastApplied === command.id || !ctx.ready || ctx.id !== command.bookmark.videoId) return;
    applying = true;
    const target = command;
    try {
      // Recheck the worker immediately before seeking: another popup click may have superseded this command.
      const { playback } = await request({ type: "STATE" });
      if (command !== target || playback?.id !== target.id || !context().ready || videoId(location.href) !== target.bookmark.videoId) return;
      const { start, end, kind } = target.bookmark;
      if (start >= ctx.video.duration || (kind === "range" && end > ctx.video.duration + 0.1)) {
        cancel();
        toast("저장 구간이 현재 영상 길이를 벗어납니다.", 6000);
        return;
      }
      ctx.video.currentTime = start;
      lastApplied = target.id;
      loop = kind === "range" ? { ...target.bookmark, requestId: target.id, video: ctx.video } : null;
      renderStatus();
      // play() may remain pending while buffering; do not block a newer bookmark.
      ctx.video.play().catch(() => {
        if (command === target) toast("재생 버튼을 눌러 주세요. 저장한 위치에서 시작합니다.", 6000);
      });
      await request({ type: "ACK", requestId: target.id });
      if (command === target) command.status = "applied";
    } catch (error) {
      if (command === target) { cancel(); toast(`재생 실패: ${error.message}`, 6000); }
    } finally { applying = false; }
  }

  function tick() {
    checkNavigation();
    const ctx = context();
    if (ctx.ad) waitStartedAt = Date.now();
    if (command?.status === "pending" && !ctx.ad && Date.now() - waitStartedAt > 120000) {
      cancel();
      toast("영상을 불러오지 못했습니다. 북마크를 다시 선택해 주세요.", 6000);
    }
    void applyPending(ctx);
    if (!loop || !ctx.ready || ctx.id !== loop.videoId || ctx.video !== loop.video) return;
    const video = ctx.video;
    if (video.seeking || (video.paused && !video.ended)) return;
    if (video.currentTime >= loop.end || video.currentTime < loop.start - 0.15) {
      const ended = video.ended;
      video.currentTime = loop.start;
      // Only an actual natural end needs play(); an ordinary loop seek keeps playback running.
      if (ended) video.play().catch(() => {});
    }
  }

  document.addEventListener("yt-navigate-start", () => {
    navigationOriginId = currentId;
    navigating = true;
    awaitingMetadata = true;
    draft.cancel();
    if (loop || command?.status === "applied") cancel();
    renderStatus();
  });
  document.addEventListener("loadedmetadata", event => {
    const ctx = context();
    if (event.target === ctx.video && !ctx.ad) awaitingMetadata = false;
  }, true);
  document.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    if (videoId(location.href) === navigationOriginId) awaitingMetadata = false;
    checkNavigation();
    mount();
    void sync();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "SYNC") void sync();
    if (message.type === "RESET" && (command?.id === message.requestId || loop?.requestId === message.requestId)) {
      command = null;
      loop = null;
      draft.cancel();
      renderStatus();
    }
  });
  mount();
  void sync();
  setInterval(sync, 1000);
  setInterval(tick, 80);
})();
