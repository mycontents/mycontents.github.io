// Contents app (GitHub Pages + Gist)
// Split from original single-file version: CSS -> styles.css, icons -> icons.svg

// ===== CONFIG =====
const ICONS = "icons.svg";
const VIEWED_KEY_PREFIX = "__viewed__:";     // внутренний префикс (не показываем текстом)
const OLD_VIEWED_PREFIX = "✓ ";             // миграция со старых данных

const SECTION_UNDO_MS = 10000;
const ITEM_UNDO_MS = 19000;

let GIST_ID = localStorage.getItem("gist_id") || "";
let TOKEN = localStorage.getItem("github_token") || "";

let currentSection = localStorage.getItem("current_section") || "__all__";
let sortState = parseSortState(localStorage.getItem("sort_state")) || { key: "manual", dir: "desc" };

let filterQuery = localStorage.getItem("filter_query") || "";

// default: hide viewed in "Все"
let showViewedInAll = (localStorage.getItem("show_viewed_all") ?? "0") === "1";

let data = { sections: {} };
let isEditing = false;

const defaultSections = ["Фильмы", "Сериалы", "Аниме"];

// selection highlight
let selectedKey = null; // `${sectionKey}|${index}`

// pointer/text selection helper
let pointer = { down: false, startX: 0, startY: 0, moved: false, startedAt: 0 };

// "armed delete" (double-click to confirm) states
let deleteArmSection = null;
let deleteArmSectionTimer = null;

let deleteArmItemKey = null;
let deleteArmItemTimer = null;

// undo (single slot)
let undoTimer = null;
let undoPayload = null; // {type, ...}

// edit context for filtered editing
let editCtx = null; // {mode, filterLower, showViewedInAll, masksBySection? / mask? / sectionKey?}

// ===== INIT =====
async function init() {
  applyUrlSetupSilently();
  updateSettingsIcon();
  updateShareButton();
  setupFilterUI();
  updateViewedToggleUI();

  if (!GIST_ID || !TOKEN) {
    document.getElementById("viewMode").innerHTML = `<div class="setup-prompt">Откройте настройки</div>`;
    document.getElementById("counter").textContent = "";
    return;
  }

  await loadData();
  ensureDefaultSections();
  migrateViewedPrefixesIfNeeded();
  renderSectionList();
  updateSectionButton();
  render();
}

// ===== URL SETUP (silent) =====
function applyUrlSetupSilently() {
  const params = new URLSearchParams(window.location.search);
  const setup = params.get("s");
  if (!setup) return;

  try {
    const decoded = atob(setup);
    const [gist, token] = decoded.split(":");
    if (gist && token) {
      localStorage.setItem("gist_id", gist);
      localStorage.setItem("github_token", token);
      GIST_ID = gist;
      TOKEN = token;
      window.history.replaceState({}, "", window.location.pathname);
    }
  } catch (_) {}
}

// ===== Viewed helpers =====
function isViewedSection(name) {
  return typeof name === "string" && (name.startsWith(VIEWED_KEY_PREFIX) || name.startsWith(OLD_VIEWED_PREFIX));
}

function baseSectionName(name) {
  if (typeof name !== "string") return "";
  if (name.startsWith(VIEWED_KEY_PREFIX)) return name.slice(VIEWED_KEY_PREFIX.length);
  if (name.startsWith(OLD_VIEWED_PREFIX)) return name.slice(OLD_VIEWED_PREFIX.length);
  return name;
}

function viewedSectionKeyFor(sourceSectionName) {
  return VIEWED_KEY_PREFIX + baseSectionName(sourceSectionName);
}

function editorLabelForSectionKey(sectionKey) {
  // В редакторе показываем: обычный [Раздел], просмотренный [~Раздел]
  return isViewedSection(sectionKey) ? `~${baseSectionName(sectionKey)}` : baseSectionName(sectionKey);
}

function sectionKeyFromEditorLabel(label) {
  // поддержка: ~Раздел => просмотренный, иначе обычный
  const t = String(label || "").trim();

  if (t.startsWith(VIEWED_KEY_PREFIX)) return t; // если кто-то вставил "как есть"
  if (t.startsWith("~")) return VIEWED_KEY_PREFIX + t.slice(1).trim();
  if (t.startsWith(OLD_VIEWED_PREFIX)) return VIEWED_KEY_PREFIX + t.slice(OLD_VIEWED_PREFIX.length).trim();
  return t;
}

function labelHTMLForSection(sectionKey) {
  const base = escapeHtml(baseSectionName(sectionKey));
  if (!isViewedSection(sectionKey)) {
    return `<span class="sec-label">${base}</span>`;
  }
  return `<span class="sec-label"><svg class="inline-icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>${base}</span>`;
}

function migrateViewedPrefixesIfNeeded() {
  // rename keys "✓ X" -> "__viewed__:X"
  const keys = Object.keys(data.sections || {});
  const toRename = keys.filter((k) => k.startsWith(OLD_VIEWED_PREFIX));
  if (!toRename.length) return;

  for (const oldKey of toRename) {
    const base = oldKey.slice(OLD_VIEWED_PREFIX.length);
    const newKey = VIEWED_KEY_PREFIX + base;

    if (!data.sections[newKey]) {
      data.sections[newKey] = data.sections[oldKey];
      delete data.sections[oldKey];
    } else {
      const a = data.sections[newKey]?.items || [];
      const b = data.sections[oldKey]?.items || [];
      data.sections[newKey].items = [...a, ...b];
      delete data.sections[oldKey];
    }

    if (currentSection === oldKey) {
      currentSection = newKey;
      localStorage.setItem("current_section", newKey);
    }
  }

  saveData();
}

// ===== Filter =====
function setupFilterUI() {
  const input = document.getElementById("filterInput");
  const clear = document.getElementById("filterClear");

  input.value = filterQuery;
  clear.classList.toggle("hidden", !filterQuery);

  input.oninput = () => {
    if (isEditing) return;
    filterQuery = input.value || "";
    localStorage.setItem("filter_query", filterQuery);
    clear.classList.toggle("hidden", !filterQuery);
    selectedKey = null;
    disarmItemDelete();
    render();
  };

  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      clearFilter();
      input.blur();
    }
  };
}

function setFilterLock(locked) {
  const input = document.getElementById("filterInput");
  const clear = document.getElementById("filterClear");
  input.disabled = locked;
  if (locked) clear.classList.add("hidden");
  else clear.classList.toggle("hidden", !filterQuery);
}

function clearFilter() {
  if (isEditing) return;
  filterQuery = "";
  localStorage.setItem("filter_query", "");
  const input = document.getElementById("filterInput");
  input.value = "";
  document.getElementById("filterClear").classList.add("hidden");
  selectedKey = null;
  disarmItemDelete();
  render();
  input.focus();
}

// ===== Viewed toggle in "All" =====
function updateViewedToggleUI() {
  const btn = document.getElementById("viewedToggleBtn");
  const use = document.getElementById("viewedToggleUse");

  btn.classList.toggle("hidden", currentSection !== "__all__");
  btn.classList.toggle("on", showViewedInAll);
  use.setAttribute("href", showViewedInAll ? `${ICONS}#i-eye` : `${ICONS}#i-eye-off`);
}

function toggleShowViewed() {
  if (isEditing) return;
  showViewedInAll = !showViewedInAll;
  localStorage.setItem("show_viewed_all", showViewedInAll ? "1" : "0");
  selectedKey = null;
  disarmItemDelete();
  updateViewedToggleUI();
  render();
}

// ===== Menu positioning =====
function openMenu(menuId, anchorEl, align = "left") {
  closeAllMenus(menuId);

  const menu = document.getElementById(menuId);
  const container = document.getElementById("container");

  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";

  const cRect = container.getBoundingClientRect();
  const aRect = anchorEl.getBoundingClientRect();
  const mRect = menu.getBoundingClientRect();

  const top = aRect.bottom - cRect.top + 8;
  let left =
    align === "right" ? aRect.right - cRect.left - mRect.width : aRect.left - cRect.left;

  left = Math.max(0, Math.min(left, cRect.width - mRect.width));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = "visible";
}

// ===== SETTINGS =====
function toggleSettings() {
  if (isEditing) return;

  const menu = document.getElementById("settingsMenu");
  const btn = document.getElementById("settingsBtn");

  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }

  document.getElementById("inputGistId").value = GIST_ID;
  document.getElementById("inputToken").value = TOKEN;
  updateShareButton();
  openMenu("settingsMenu", btn, "right");
}

function saveSettings() {
  const gistId = document.getElementById("inputGistId").value.trim();
  const token = document.getElementById("inputToken").value.trim();
  if (!gistId || !token) return;

  localStorage.setItem("gist_id", gistId);
  localStorage.setItem("github_token", token);
  GIST_ID = gistId;
  TOKEN = token;

  document.getElementById("settingsMenu").classList.add("hidden");
  updateSettingsIcon();
  updateShareButton();
  init();
}

function updateSettingsIcon() {
  document.getElementById("settingsBtn").classList.toggle("error", !GIST_ID || !TOKEN);
}

function updateShareButton() {
  document.getElementById("shareBtn").style.display = GIST_ID && TOKEN ? "grid" : "none";
}

function copyShareLink() {
  if (!GIST_ID || !TOKEN) return;
  const link = `${location.origin}${location.pathname}?s=${btoa(`${GIST_ID}:${TOKEN}`)}`;
  if (navigator.clipboard) navigator.clipboard.writeText(link);
  else {
    const ta = document.createElement("textarea");
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

// ===== SECTIONS =====
function toggleSectionMenu() {
  if (isEditing) return;

  const menu = document.getElementById("sectionMenu");
  const btn = document.getElementById("sectionBtn");

  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    document.getElementById("newSectionInput").classList.add("hidden");
    disarmSectionDelete();
    return;
  }

  renderSectionList();
  document.getElementById("newSectionInput").classList.add("hidden");
  openMenu("sectionMenu", btn, "left");
}

function ensureDefaultSections() {
  if (Object.keys(data.sections).length) return;
  defaultSections.forEach((s) => (data.sections[s] = { items: [], modified: new Date().toISOString() }));
}

function renderSectionList() {
  const list = document.getElementById("sectionList");
  const keys = Object.keys(data.sections);

  list.innerHTML = keys
    .map((sectionKey) => {
      const armed = deleteArmSection === sectionKey;

      return `
        <div class="menu-option ${currentSection === sectionKey ? "active" : ""} ${
          armed ? "armed" : ""
        }"
             onclick="selectSection('${escapeQuotes(sectionKey)}')">
          <span>${labelHTMLForSection(sectionKey)}</span>

          <span class="menu-actions" onclick="event.stopPropagation()">
            <button class="mini-btn danger" title="Удалить" onclick="handleSectionDelete('${escapeQuotes(
              sectionKey
            )}')">×</button>
          </span>
        </div>
      `;
    })
    .join("");
}

function selectSection(sectionKey) {
  currentSection = sectionKey;
  localStorage.setItem("current_section", sectionKey);
  selectedKey = null;
  disarmItemDelete();
  disarmSectionDelete();
  updateSectionButton();
  updateViewedToggleUI();
  document.getElementById("sectionMenu").classList.add("hidden");
  render();
}

function updateSectionButton() {
  const el = document.getElementById("currentSectionName");
  if (currentSection === "__all__") {
    el.textContent = "Все";
    return;
  }
  el.innerHTML = labelHTMLForSection(currentSection);
}

function showNewSectionInput() {
  const input = document.getElementById("newSectionInput");
  input.classList.remove("hidden");
  input.value = "";
  input.focus();
  disarmSectionDelete();
}

function handleNewSection(e) {
  if (e.key === "Enter") {
    const name = e.target.value.trim();
    if (name && !data.sections[name]) {
      data.sections[name] = { items: [], modified: new Date().toISOString() };
      saveData();
      renderSectionList();
      selectSection(name);
    }
    e.target.classList.add("hidden");
  } else if (e.key === "Escape") {
    e.target.classList.add("hidden");
  }
}

// ===== Section delete: 2nd click confirms =====
function handleSectionDelete(sectionKey) {
  if (Object.keys(data.sections).length <= 1) return;
  if (!data.sections[sectionKey]) return;

  if (deleteArmSection === sectionKey) {
    // delete now
    const payload = {
      type: "section",
      sectionKey,
      sectionData: JSON.parse(JSON.stringify(data.sections[sectionKey])),
      prevCurrentSection: currentSection,
    };

    delete data.sections[sectionKey];

    if (currentSection === sectionKey) {
      currentSection = "__all__";
      localStorage.setItem("current_section", "__all__");
      updateSectionButton();
      updateViewedToggleUI();
    }

    selectedKey = null;
    disarmItemDelete();
    disarmSectionDelete();

    saveData();
    renderSectionList();
    render();

    startUndo(payload, SECTION_UNDO_MS, `Раздел удалён: ${baseSectionName(sectionKey)}`);
    return;
  }

  // arm
  deleteArmSection = sectionKey;
  renderSectionList();

  if (deleteArmSectionTimer) clearTimeout(deleteArmSectionTimer);
  deleteArmSectionTimer = setTimeout(() => {
    disarmSectionDelete();
    renderSectionList();
  }, 6000);
}

function disarmSectionDelete() {
  deleteArmSection = null;
  if (deleteArmSectionTimer) clearTimeout(deleteArmSectionTimer);
  deleteArmSectionTimer = null;
}

// ===== SORT =====
function toggleSort() {
  if (isEditing) return;

  const menu = document.getElementById("sortMenu");
  const btn = document.getElementById("sortBtn");

  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }

  openMenu("sortMenu", btn, "right");
  updateSortMenuUI();
}

function setSortKey(key) {
  if (key === "manual") {
    sortState = { key: "manual", dir: "desc" };
  } else if (sortState.key === key) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState = { key, dir: defaultDirForKey(key) };
  }

  localStorage.setItem("sort_state", `${sortState.key}:${sortState.dir}`);
  selectedKey = null;
  disarmItemDelete();
  updateSortMenuUI();
  document.getElementById("sortMenu").classList.add("hidden");
  render();
}

function defaultDirForKey(key) {
  if (key === "alpha") return "asc";
  return "desc";
}

function parseSortState(str) {
  if (!str) return null;
  const [key, dir] = String(str).split(":");
  if (!key) return null;
  return { key, dir: dir === "asc" ? "asc" : "desc" };
}

function updateSortMenuUI() {
  document.querySelectorAll("#sortMenu .menu-option").forEach((el) => {
    const key = el.dataset.key;
    const dirSpan = el.querySelector(".sort-dir");
    const active = key === sortState.key;
    el.classList.toggle("active", active);

    if (!dirSpan) return;
    if (!active || key === "manual") dirSpan.textContent = "";
    else dirSpan.textContent = sortState.dir === "asc" ? "↑" : "↓";
  });
}

function getSortedItems(items) {
  if (!items || sortState.key === "manual") return items;

  const sorted = [...items];
  const getText = (x) => x.text ?? x;

  switch (sortState.key) {
    case "alpha":
      sorted.sort((a, b) => String(getText(a)).localeCompare(String(getText(b)), "ru"));
      if (sortState.dir === "desc") sorted.reverse();
      break;

    case "year":
      sorted.sort((a, b) => {
        const yA = (String(getText(a)).match(/\((\d{4})\)/) || [, 0])[1];
        const yB = (String(getText(b)).match(/\((\d{4})\)/) || [, 0])[1];
        return Number(yA) - Number(yB);
      });
      if (sortState.dir === "desc") sorted.reverse();
      break;

    case "date":
      if (sortState.dir === "desc") sorted.reverse();
      break;
  }

  return sorted;
}

// ===== API =====
async function loadData() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`,
      {
        headers: { Authorization: `token ${TOKEN}` },
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const gist = await res.json();
    if (gist.files?.["contents.json"]) {
      const loaded = JSON.parse(gist.files["contents.json"].content);
      if (loaded.users && !loaded.sections) data.sections = loaded.users; // migration old schema
      else data = loaded.sections ? loaded : { sections: {} };
    } else {
      data = { sections: {} };
      await saveData();
    }
  } catch (e) {
    console.error(e);
    data = { sections: {} };
  }
}

async function saveData() {
  if (!TOKEN || !GIST_ID) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: { "contents.json": { content: JSON.stringify(data, null, 2) } },
        }),
      }
    );
  } catch (e) {
    console.error(e);
  }
}

// ===== Undo (single slot) =====
function startUndo(payload, ms, label) {
  undoPayload = payload;

  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    hideUndo();
    undoPayload = null;
    undoTimer = null;
  }, ms);

  document.getElementById("undoText").textContent = label;
  document.getElementById("undoBar").classList.remove("hidden");
}

function hideUndo() {
  document.getElementById("undoBar").classList.add("hidden");
}

document.getElementById("undoBtn").addEventListener("click", () => {
  if (!undoPayload) return;

  if (undoPayload.type === "section") {
    let restoreKey = undoPayload.sectionKey;

    if (data.sections[restoreKey]) {
      let i = 2;
      while (data.sections[`${restoreKey} (${i})`]) i++;
      restoreKey = `${restoreKey} (${i})`;
    }

    data.sections[restoreKey] = undoPayload.sectionData;

    if (undoPayload.prevCurrentSection === undoPayload.sectionKey) {
      currentSection = restoreKey;
      localStorage.setItem("current_section", restoreKey);
      updateSectionButton();
      updateViewedToggleUI();
    }

    saveData();
    renderSectionList();
    render();
  }

  if (undoPayload.type === "item") {
    const { sectionKey, index, text } = undoPayload;

    if (!data.sections[sectionKey]) {
      data.sections[sectionKey] = { items: [], modified: new Date().toISOString() };
    }
    const arr = data.sections[sectionKey].items || (data.sections[sectionKey].items = []);
    const idx = Math.max(0, Math.min(Number(index), arr.length));
    arr.splice(idx, 0, text);
    data.sections[sectionKey].modified = new Date().toISOString();

    saveData();
    render();
  }

  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
  undoPayload = null;
  hideUndo();
});

// ===== ITEM actions: move / return / delete (double click) =====
function moveItemToViewed(sectionKey, index) {
  if (!data.sections[sectionKey]) return;
  if (isViewedSection(sectionKey)) return;

  const srcItems = data.sections[sectionKey].items || [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= srcItems.length) return;

  const itemText = srcItems[idx];
  srcItems.splice(idx, 1);
  data.sections[sectionKey].modified = new Date().toISOString();

  const destKey = viewedSectionKeyFor(sectionKey);
  if (!data.sections[destKey]) data.sections[destKey] = { items: [], modified: new Date().toISOString() };
  data.sections[destKey].items.push(itemText);
  data.sections[destKey].modified = new Date().toISOString();

  selectedKey = null;
  disarmItemDelete();
  saveData();
  renderSectionList();
  render();
}

function returnItemFromViewed(viewedSectionKey, index) {
  if (!data.sections[viewedSectionKey]) return;
  if (!isViewedSection(viewedSectionKey)) return;

  const srcItems = data.sections[viewedSectionKey].items || [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= srcItems.length) return;

  const itemText = srcItems[idx];
  srcItems.splice(idx, 1);
  data.sections[viewedSectionKey].modified = new Date().toISOString();

  const baseKey = baseSectionName(viewedSectionKey);
  if (!data.sections[baseKey]) data.sections[baseKey] = { items: [], modified: new Date().toISOString() };
  data.sections[baseKey].items.push(itemText);
  data.sections[baseKey].modified = new Date().toISOString();

  selectedKey = null;
  disarmItemDelete();
  saveData();
  renderSectionList();
  render();
}

function armItemDelete(key) {
  deleteArmItemKey = key;

  if (deleteArmItemTimer) clearTimeout(deleteArmItemTimer);
  deleteArmItemTimer = setTimeout(() => {
    disarmItemDelete();
  }, 6000);

  document.querySelectorAll("#viewMode .item-line").forEach((el) => {
    el.classList.toggle("del-armed", el.dataset.key === key);
  });
}

function disarmItemDelete() {
  deleteArmItemKey = null;
  if (deleteArmItemTimer) clearTimeout(deleteArmItemTimer);
  deleteArmItemTimer = null;
  document.querySelectorAll("#viewMode .item-line.del-armed").forEach((el) => el.classList.remove("del-armed"));
}

function deleteItemNow(sectionKey, index) {
  const arr = data.sections[sectionKey]?.items;
  if (!arr) return;

  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return;

  const text = arr[idx];

  arr.splice(idx, 1);
  data.sections[sectionKey].modified = new Date().toISOString();

  disarmItemDelete();
  selectedKey = null;

  saveData();
  render();

  startUndo({ type: "item", sectionKey, index: idx, text }, ITEM_UNDO_MS, `Запись удалена`);
}

// ===== EDIT (filtered editing supported) =====
function toggleEdit() {
  if (!TOKEN || !GIST_ID) {
    toggleSettings();
    return;
  }
  isEditing ? cancelEdit() : startEdit();
}

function startEdit() {
  isEditing = true;
  selectedKey = null;
  disarmItemDelete();

  setFilterLock(true);

  const editor = document.getElementById("editor");
  const hint = document.getElementById("editHint");
  document.getElementById("editUse").setAttribute("href", `${ICONS}#i-x`);

  const filterLower = (filterQuery || "").trim().toLowerCase();

  if (currentSection === "__all__") {
    const masksBySection = {};
    const lines = [];

    for (const sectionKey of Object.keys(data.sections)) {
      if (!showViewedInAll && isViewedSection(sectionKey)) continue;

      const items = data.sections[sectionKey]?.items || [];
      const mask = items.map((it) => !filterLower || String(it).toLowerCase().includes(filterLower));

      if (mask.some(Boolean)) masksBySection[sectionKey] = mask;

      for (let i = 0; i < items.length; i++) {
        if (mask[i]) lines.push(`[${editorLabelForSectionKey(sectionKey)}] ${items[i]}`);
      }
    }

    editor.value = lines.join("\n");
    hint.classList.remove("hidden");
    editCtx = { mode: "all", filterLower, showViewedInAll, masksBySection };
  } else {
    const sectionKey = currentSection;
    const orig = data.sections[sectionKey]?.items || [];
    const mask = orig.map((it) => !filterLower || String(it).toLowerCase().includes(filterLower));
    const lines = orig.filter((_, i) => mask[i]);

    editor.value = lines.join("\n");
    hint.classList.add("hidden");
    editCtx = { mode: "section", sectionKey, filterLower, mask };
  }

  document.getElementById("viewMode").classList.add("hidden");
  document.getElementById("editMode").classList.remove("hidden");
  editor.focus();
}

function cancelEdit() {
  isEditing = false;
  editCtx = null;

  setFilterLock(false);

  document.getElementById("viewMode").classList.remove("hidden");
  document.getElementById("editMode").classList.add("hidden");
  document.getElementById("editHint").classList.add("hidden");
  document.getElementById("editUse").setAttribute("href", `${ICONS}#i-pencil`);
}

function mergeByMask(original, mask, replacement) {
  const out = [];
  let ri = 0;
  const m = Array.isArray(mask) ? mask : new Array(original.length).fill(false);

  for (let i = 0; i < original.length; i++) {
    if (m[i]) {
      if (ri < replacement.length) out.push(replacement[ri++]);
      // else delete matched item
    } else out.push(original[i]);
  }
  while (ri < replacement.length) out.push(replacement[ri++]); // new items appended
  return out;
}

function parseAllEditorLines(lines) {
  const bySectionKey = {};
  let lastSectionKey = Object.keys(data.sections)[0] || "Раздел";

  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      const label = m[1].trim();
      const sectionKey = sectionKeyFromEditorLabel(label);
      const item = (m[2] || "").trim();

      if (!sectionKey) continue;
      if (!bySectionKey[sectionKey]) bySectionKey[sectionKey] = [];
      if (item) bySectionKey[sectionKey].push(item);
      lastSectionKey = sectionKey;
    } else {
      const item = line.trim();
      if (!item) continue;
      if (!bySectionKey[lastSectionKey]) bySectionKey[lastSectionKey] = [];
      bySectionKey[lastSectionKey].push(item);
    }
  }
  return { bySectionKey };
}

async function saveEdit() {
  const text = document.getElementById("editor").value;
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!editCtx) return;

  if (editCtx.mode === "section") {
    const sectionKey = editCtx.sectionKey;
    const orig = data.sections[sectionKey]?.items || [];
    const merged = mergeByMask(orig, editCtx.mask, lines);

    data.sections[sectionKey] = { items: merged, modified: new Date().toISOString() };
  }

  if (editCtx.mode === "all") {
    const parsed = parseAllEditorLines(lines);
    const newBySectionKey = parsed.bySectionKey;

    const allSections = new Set([...Object.keys(data.sections), ...Object.keys(newBySectionKey)]);

    for (const sectionKey of allSections) {
      const orig = data.sections[sectionKey]?.items || [];
      const mask = editCtx.masksBySection[sectionKey] || new Array(orig.length).fill(false);
      const replacement = newBySectionKey[sectionKey] || [];
      const merged = mergeByMask(orig, mask, replacement);

      if (!data.sections[sectionKey]) data.sections[sectionKey] = { items: [], modified: new Date().toISOString() };
      data.sections[sectionKey].items = merged;
      data.sections[sectionKey].modified = new Date().toISOString();
    }
  }

  await saveData();
  renderSectionList();
  cancelEdit();
  render();
}

// ===== RENDER =====
function shouldIncludeSectionInAll(sectionKey) {
  if (currentSection !== "__all__") return true;
  if (showViewedInAll) return true;
  return !isViewedSection(sectionKey);
}

function applyFilter(items) {
  const q = (filterQuery || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => String(it.text || "").toLowerCase().includes(q));
}

function buildItemsForView() {
  let items = [];
  if (currentSection === "__all__") {
    for (const sectionKey of Object.keys(data.sections)) {
      if (!shouldIncludeSectionInAll(sectionKey)) continue;
      const arr = data.sections[sectionKey]?.items || [];
      for (let i = 0; i < arr.length; i++) items.push({ text: arr[i], sectionKey, index: i });
    }
  } else {
    const arr = data.sections[currentSection]?.items || [];
    for (let i = 0; i < arr.length; i++) items.push({ text: arr[i], sectionKey: currentSection, index: i });
  }

  items = applyFilter(items);
  items = getSortedItems(items);
  return items;
}

function render() {
  const view = document.getElementById("viewMode");
  const items = buildItemsForView();

  if (!items.length) {
    view.innerHTML = "";
    document.getElementById("counter").textContent = "0";
    return;
  }

  const keySet = new Set(items.map((it) => `${it.sectionKey}|${it.index}`));
  if (selectedKey && !keySet.has(selectedKey)) {
    selectedKey = null;
    disarmItemDelete();
  }

  view.innerHTML = items
    .map((it) => {
      const key = `${it.sectionKey}|${it.index}`;
      const selected = selectedKey === key;

      const showTag = currentSection === "__all__";
      const viewed = isViewedSection(it.sectionKey);

      const secTag = showTag
        ? `<span class="item-section-tag">
             ${
               viewed
                 ? `<svg class="inline-icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>`
                 : ``
             }
             ${escapeHtml(baseSectionName(it.sectionKey))}
           </span>`
        : "";

      const rightAction = viewed
        ? `<button class="right-action" data-action="back" title="Вернуть из просмотренного">
             <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-undo"></use></svg>
           </button>`
        : `<button class="right-action" data-action="mark" title="Переместить в просмотренное">
             <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>
           </button>`;

      return `
        <div class="item-line ${selected ? "selected" : ""} ${
        deleteArmItemKey === key ? "del-armed" : ""
      }"
             data-key="${escapeAttr(key)}"
             data-section="${escapeAttr(it.sectionKey)}"
             data-index="${String(it.index)}">
          <button class="item-del" data-action="item-del" title="Удалить">
            <svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-x"></use></svg>
          </button>

          ${secTag}
          <span class="item-text">${escapeHtml(it.text)}</span>

          ${rightAction}
        </div>
      `;
    })
    .join("");

  document.getElementById("counter").textContent = String(items.length);
}

// ===== View mode interactions =====
const viewModeEl = document.getElementById("viewMode");

viewModeEl.addEventListener("pointerdown", (e) => {
  if (isEditing) return;
  pointer.down = true;
  pointer.moved = false;
  pointer.startX = e.clientX;
  pointer.startY = e.clientY;
  pointer.startedAt = Date.now();
});

viewModeEl.addEventListener("pointermove", (e) => {
  if (!pointer.down) return;
  if (Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > 10) pointer.moved = true;
});

viewModeEl.addEventListener("pointerup", () => {
  pointer.down = false;
});

viewModeEl.addEventListener("click", (e) => {
  if (isEditing) return;

  const line = e.target.closest(".item-line");
  if (!line) return;

  const actionEl = e.target.closest("[data-action]");
  if (actionEl) {
    e.stopPropagation();

    const action = actionEl.dataset.action;
    const sectionKey = line.dataset.section;
    const index = line.dataset.index;
    const key = line.dataset.key;

    if (action === "mark") {
      moveItemToViewed(sectionKey, index);
      return;
    }
    if (action === "back") {
      returnItemFromViewed(sectionKey, index);
      return;
    }
    if (action === "item-del") {
      // если строка не выбрана — сначала выбираем (чтобы появился сдвиг)
      if (selectedKey !== key) {
        selectedKey = key;
        disarmItemDelete();
        render();
        // после render — взводим удаление
        armItemDelete(key);
        return;
      }

      // если уже взведено — удаляем
      if (deleteArmItemKey === key) {
        deleteItemNow(sectionKey, index);
        return;
      }

      // иначе взводим
      armItemDelete(key);
      return;
    }
  }

  // если выделяли текст — не трогаем выделение строки
  const sel = window.getSelection ? window.getSelection() : null;
  if (sel && !sel.isCollapsed) return;

  // ignore long press & drag/scroll gestures
  const longPress = pointer.startedAt && Date.now() - pointer.startedAt > 350;
  if (longPress) return;
  if (pointer.moved) return;

  const key = line.dataset.key;
  const nowSelected = selectedKey !== key;

  selectedKey = nowSelected ? key : null;
  disarmItemDelete();

  document.querySelectorAll("#viewMode .item-line.selected").forEach((el) => el.classList.remove("selected"));
  if (selectedKey) line.classList.add("selected");
});

// ===== Close menus =====
function closeAllMenus(except) {
  ["sortMenu", "settingsMenu", "sectionMenu"].forEach((id) => {
    if (id !== except) document.getElementById(id).classList.add("hidden");
  });
}

document.addEventListener("click", (e) => {
  if (
    !e.target.closest(".dropdown-menu") &&
    !e.target.closest(".icon-btn") &&
    !e.target.closest(".section-btn") &&
    !e.target.closest(".all-toggle")
  ) {
    closeAllMenus();
    disarmSectionDelete();
    renderSectionList();
  }
});

window.addEventListener(
  "scroll",
  () => {
    closeAllMenus();
    disarmSectionDelete();
  },
  { passive: true }
);

// ===== Utils =====
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(str) {
  return escapeHtml(str).replaceAll("`", "&#096;");
}
function escapeQuotes(str) {
  return String(str).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

// Expose functions used by inline HTML handlers (explicitly)
Object.assign(window, {
  toggleSectionMenu,
  toggleShowViewed,
  clearFilter,
  toggleSort,
  setSortKey,
  toggleEdit,
  cancelEdit,
  saveEdit,
  toggleSettings,
  saveSettings,
  copyShareLink,
  selectSection,
  showNewSectionInput,
  handleNewSection,
  handleSectionDelete,
});

init();
