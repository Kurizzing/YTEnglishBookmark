"use strict";
const { groupBookmarks, formatTime, normalizeSettings, shortcutLabel, isShortcutCode, DEFAULT_SHORTCUTS } = EngBookmark;
const tree = document.getElementById("tree");
const selected = new Set();
const expanded = new Set();
const deleteSelected = document.getElementById("delete-selected");
const dialog = document.getElementById("confirm-dialog");
let initialized = false;
let deleteIds = [];
let loading = 0;
const autoCaptionRepeat = document.getElementById("auto-caption-repeat");
const resetShortcuts = document.getElementById("reset-shortcuts");
const shortcutNames = { point: "시점 저장", range: "구간 저장" };
let settings = normalizeSettings();
let recording = null;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했습니다.");
  return response;
}

async function loadSettings() {
  try {
    renderSettings((await request({ type: "GET_SETTINGS" })).settings);
  } catch (error) { showMessage(error.message, true); }
}

function renderSettings(value) {
  settings = normalizeSettings(value);
  autoCaptionRepeat.checked = settings.autoCaptionRepeat;
  for (const node of document.querySelectorAll("[data-shortcut]")) node.textContent = shortcutLabel(settings.shortcuts[node.dataset.shortcut]);
  resetShortcuts.hidden = settings.shortcuts.point === DEFAULT_SHORTCUTS.point && settings.shortcuts.range === DEFAULT_SHORTCUTS.range;
}

async function saveShortcuts(shortcuts) {
  try {
    renderSettings((await request({ type: "SET_SETTINGS", settings: { shortcuts } })).settings);
    showMessage(`단축키: ${shortcutLabel(settings.shortcuts.point)} 시점 저장 · ${shortcutLabel(settings.shortcuts.range)} 구간 저장`);
  } catch (error) { showMessage(error.message, true); }
}

function stopRecording() {
  if (!recording) return;
  recording.classList.remove("recording");
  recording.querySelector("kbd").textContent = shortcutLabel(settings.shortcuts[recording.dataset.shortcutEdit]);
  recording = null;
}

function renderStorage(bookmarks, usage) {
  const localOnly = bookmarks.filter(bookmark => bookmark.localOnly).length;
  const percent = usage ? Math.min(100, Math.round(usage.bytes / usage.quota * 100)) : 0;
  const status = document.getElementById("storage-status");
  status.textContent = localOnly ? `동기화 공간 부족 · ${localOnly}개는 이 PC에만 저장됨` : `크롬 계정에 동기화 · ${percent}% 사용`;
  status.title = "크롬 동기화 저장 공간은 약 100KB(북마크 약 500개)입니다. 넘치는 북마크는 이 PC에만 저장되고, 공간이 생기면 자동으로 동기화됩니다.";
  document.querySelector("footer .dot").classList.toggle("warning", localOnly > 0);
}

async function exportBookmarks() {
  try {
    const { bookmarks } = await request({ type: "LIST" });
    const data = { app: "engbookmark", version: 1, exportedAt: new Date().toISOString(), bookmarks: bookmarks.map(({ localOnly, ...bookmark }) => bookmark) };
    const link = element("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    link.download = `engbookmark-${EngBookmark.localDate(new Date())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showMessage(`북마크 ${bookmarks.length}개를 백업 파일로 저장했습니다.`);
  } catch (error) { showMessage(error.message, true); }
}

async function importBookmarks(file) {
  try {
    const data = JSON.parse(await file.text());
    const bookmarks = Array.isArray(data) ? data : data?.bookmarks;
    if (!Array.isArray(bookmarks)) throw new Error("EngBookmark 백업 파일이 아닙니다.");
    const { added, skipped, localOnly } = await request({ type: "IMPORT", bookmarks });
    showMessage(`${added}개를 복원했습니다.` + (skipped ? ` 이미 있거나 잘못된 ${skipped}개는 건너뛰었습니다.` : "") + (localOnly ? ` ${localOnly}개는 공간이 부족해 이 PC에만 저장했습니다.` : ""));
    await load();
  } catch (error) { showMessage(error instanceof SyntaxError ? "백업 파일을 읽을 수 없습니다." : error.message, true); }
}

function showMessage(text, error = false) {
  const message = document.getElementById("message");
  message.textContent = text;
  message.classList.toggle("error", error);
  message.hidden = !text;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function updateSelection() {
  deleteSelected.disabled = selected.size === 0;
  deleteSelected.textContent = selected.size ? `선택 삭제 (${selected.size})` : "선택 삭제";
}

function confirmDelete(ids) {
  deleteIds = [...ids];
  document.getElementById("confirm-description").textContent = `북마크 ${ids.length}개를 삭제합니다. 삭제한 북마크는 복구할 수 없습니다.`;
  dialog.showModal();
}

function bookmarkRow(bookmark) {
  const row = element("div", "bookmark");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.checked = selected.has(bookmark.id);
  checkbox.setAttribute("aria-label", `${bookmark.title} ${formatTime(bookmark.start)} 선택`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(bookmark.id);
    else selected.delete(bookmark.id);
    updateSelection();
  });
  const play = element("button", "play");
  play.type = "button";
  play.title = `${bookmark.title}\n${bookmark.url}`;
  play.append(element("span", "bookmark-title", bookmark.title));
  const meta = element("span", "bookmark-meta");
  meta.append(element("span", `badge ${bookmark.kind === "range" ? "range" : ""}`, bookmark.kind === "range" ? "↺ 구간" : "▶ 시점"));
  if (bookmark.localOnly) meta.append(element("span", "badge local-only", "이 PC만"));
  meta.append(element("span", "time", bookmark.kind === "range" ? `${formatTime(bookmark.start)}–${formatTime(bookmark.end)}` : formatTime(bookmark.start)));
  play.append(meta);
  play.addEventListener("click", async () => {
    showMessage("영상을 여는 중…");
    try {
      const { id: windowId } = await chrome.windows.getCurrent();
      await request({ type: "PLAY", id: bookmark.id, windowId });
      showMessage("영상으로 이동했습니다.");
    }
    catch (error) { showMessage(error.message, true); }
  });
  const remove = element("button", "text-button danger item-delete", "×");
  remove.type = "button";
  remove.title = "북마크 삭제";
  remove.setAttribute("aria-label", `${bookmark.title} 삭제`);
  remove.addEventListener("click", () => confirmDelete([bookmark.id]));
  row.append(checkbox, play, remove);
  return row;
}

function folder(node) {
  const details = element("details", node.bookmarks ? "day" : "folder");
  details.open = expanded.has(node.key);
  details.addEventListener("toggle", () => {
    if (details.open) expanded.add(node.key);
    else expanded.delete(node.key);
  });
  const summary = element("summary");
  summary.append(element("span", "folder-name", node.label), element("span", "folder-count", `${node.ids.length}`));
  const remove = element("button", "text-button danger folder-delete", "삭제");
  remove.type = "button";
  remove.setAttribute("aria-label", `${node.key} 폴더 ${node.ids.length}개 삭제`);
  remove.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    confirmDelete(node.ids);
  });
  summary.append(remove);
  const content = element("div", "folder-content");
  if (node.bookmarks) content.append(...node.bookmarks.map(bookmarkRow));
  else content.append(...[...node.children.values()].map(folder));
  details.append(summary, content);
  return details;
}

async function load() {
  const version = ++loading;
  try {
    const { bookmarks, usage } = await request({ type: "LIST" });
    if (version !== loading) return;
    renderStorage(bookmarks, usage);
    const ids = new Set(bookmarks.map(bookmark => bookmark.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    const groups = groupBookmarks(bookmarks);
    if (!initialized && groups.length) {
      const month = groups[0];
      const day = [...month.children.values()][0];
      [month, day].forEach(node => expanded.add(node.key));
      initialized = true;
    }
    const scroll = tree.scrollTop;
    tree.replaceChildren(...groups.map(folder));
    tree.scrollTop = scroll;
    document.getElementById("total").textContent = `${bookmarks.length}개`;
    document.getElementById("empty").hidden = bookmarks.length !== 0;
    updateSelection();
  } catch (error) { showMessage(error.message, true); }
}

const importFile = document.getElementById("import-file");
document.getElementById("export").addEventListener("click", exportBookmarks);
document.getElementById("import").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const [file] = importFile.files;
  importFile.value = "";
  if (file) void importBookmarks(file);
});
deleteSelected.addEventListener("click", () => confirmDelete([...selected]));
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "delete") return;
  const ids = deleteIds;
  try {
    await request({ type: "DELETE", ids });
    ids.forEach(id => selected.delete(id));
    showMessage(`${ids.length}개를 삭제했습니다.`);
    await load();
  } catch (error) { showMessage(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && Object.keys(changes).some(key => key.startsWith(EngBookmark.SYNC_PREFIX))) || (area === "local" && changes.localBookmarks)) void load();
  if (area === "sync" && changes.settings) { stopRecording(); renderSettings(changes.settings.newValue); }
});
autoCaptionRepeat.addEventListener("change", async () => {
  autoCaptionRepeat.disabled = true;
  try { await request({ type: "SET_SETTINGS", settings: { autoCaptionRepeat: autoCaptionRepeat.checked } }); }
  catch (error) { autoCaptionRepeat.checked = !autoCaptionRepeat.checked; showMessage(error.message, true); }
  finally { autoCaptionRepeat.disabled = false; }
});
for (const button of document.querySelectorAll("[data-shortcut-edit]")) {
  button.addEventListener("click", () => {
    const same = recording === button;
    stopRecording();
    if (same) return;
    recording = button;
    button.classList.add("recording");
    button.querySelector("kbd").textContent = "…";
    showMessage(`${shortcutNames[button.dataset.shortcutEdit]}에 쓸 키를 누르세요 (영문자·숫자, Esc 취소)`);
  });
}
document.addEventListener("keydown", event => {
  if (!recording || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  const action = recording.dataset.shortcutEdit;
  const other = action === "point" ? "range" : "point";
  if (event.code === "Escape") { stopRecording(); showMessage(""); return; }
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isShortcutCode(event.code)) {
    showMessage("조합키 없이 영문자나 숫자 키 하나만 사용할 수 있습니다.", true);
    return;
  }
  if (event.code === settings.shortcuts[other]) {
    showMessage(`${shortcutLabel(event.code)} 키는 이미 ${shortcutNames[other]}에 쓰이고 있습니다.`, true);
    return;
  }
  stopRecording();
  void saveShortcuts({ ...settings.shortcuts, [action]: event.code });
}, true);
resetShortcuts.addEventListener("click", () => { stopRecording(); void saveShortcuts({ ...DEFAULT_SHORTCUTS }); });
void load();
void loadSettings();
