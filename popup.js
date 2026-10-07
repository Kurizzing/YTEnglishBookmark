"use strict";
const { groupBookmarks, formatTime } = EngBookmark;
const tree = document.getElementById("tree");
const selected = new Set();
const expanded = new Set();
const deleteSelected = document.getElementById("delete-selected");
const dialog = document.getElementById("confirm-dialog");
let initialized = false;
let deleteIds = [];
let loading = 0;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했습니다.");
  return response;
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
    const { bookmarks } = await request({ type: "LIST" });
    if (version !== loading) return;
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
  if (area === "local" && changes.bookmarks) void load();
});
void load();
