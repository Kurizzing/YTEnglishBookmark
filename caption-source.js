// Executed in the YouTube page's MAIN world; must not reference extension globals.
async function readYouTubeCaptions(expectedVideoId) {
  const matchesVideo = () => location.pathname === "/watch" && new URL(location.href).searchParams.get("v") === expectedVideoId;
  if (!matchesVideo()) throw new Error("영상이 변경되었습니다.");
  const player = document.getElementById("movie_player");
  let response;
  try { response = player?.getPlayerResponse?.(); } catch { /* Try the initial page response below. */ }
  if (response?.videoDetails?.videoId !== expectedVideoId) response = window.ytInitialPlayerResponse;
  if (response?.videoDetails?.videoId !== expectedVideoId) throw new Error("현재 영상의 자막 정보를 찾지 못했습니다.");
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const english = track => /^en(?:-|$)/i.test(track.languageCode || "");
  const track = tracks.find(item => english(item) && item.kind !== "asr") || tracks.find(english);
  if (!track) throw new Error("이 영상에는 사용할 수 있는 영어 자막이 없습니다.");

  const allowed = value => {
    try {
      const url = new URL(value);
      return url.origin === "https://www.youtube.com" && url.pathname === "/api/timedtext" && url.searchParams.get("v") === expectedVideoId;
    } catch { return false; }
  };
  if (!allowed(track.baseUrl)) throw new Error("영어 자막 주소를 확인하지 못했습니다.");
  const base = new URL(track.baseUrl);
  base.searchParams.set("fmt", "json3");
  // A request already made by the player can contain the parameters it needs.
  const observed = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(value => {
    if (!allowed(value)) return false;
    const url = new URL(value);
    return url.searchParams.get("lang") === track.languageCode && !url.searchParams.has("tlang") &&
      (url.searchParams.get("kind") || "") === (track.kind || "");
  });
  const urls = [...new Set([observed, base.href].filter(Boolean))];
  for (const url of urls) {
    try {
      const result = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      if (!result.ok) continue;
      const body = await result.text();
      if (!matchesVideo()) throw new Error("영상이 변경되었습니다.");
      if (!body.trim()) continue;
      if (body.trim().startsWith("{")) {
        const data = JSON.parse(body);
        if (data.events?.some(event => event.segs?.some(seg => seg.utf8?.trim()))) return { videoId: expectedVideoId, format: "json3", data };
      } else {
        const xml = new DOMParser().parseFromString(body, "text/xml");
        if (xml.querySelector("parsererror")) continue;
        const rows = [...xml.querySelectorAll("text[start], p[t]")].map(node => {
          const srv3 = node.tagName === "p";
          const start = Number(node.getAttribute(srv3 ? "t" : "start")) / (srv3 ? 1000 : 1);
          const end = start + Number(node.getAttribute(srv3 ? "d" : "dur")) / (srv3 ? 1000 : 1);
          const words = srv3 ? [...node.querySelectorAll("s[t]")].map(word => ({ text: word.textContent, start: start + Number(word.getAttribute("t")) / 1000 })) : [];
          return { start, end, text: node.textContent, words };
        });
        if (rows.length) return { videoId: expectedVideoId, format: "cues", data: rows };
      }
    } catch { /* Try the track URL if the observed request is no longer usable. */ }
  }
  throw new Error("자막을 불러오지 못했습니다. 유튜브에서 영어 자막을 켠 뒤 다시 선택해 주세요.");
}

if (typeof module !== "undefined") module.exports = readYouTubeCaptions;

window.addEventListener("message", async event => {
  if (event.source !== window || event.data?.source !== "engbookmark-caption-request") return;
  const { requestId, videoId } = event.data;
  try {
    const result = await readYouTubeCaptions(videoId);
    window.postMessage({ source: "engbookmark-caption-source", requestId, ...result }, "*");
  } catch (error) {
    window.postMessage({ source: "engbookmark-caption-source", requestId, error: error.message || "자막을 불러오지 못했습니다." }, "*");
  }
});
