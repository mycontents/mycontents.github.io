// Contents app (GitHub Pages + Gist)
// CSS -> styles.css, icons -> icons.svg

// ===== CONFIG =====
const ICONS = "icons.svg";
const VIEWED_KEY_PREFIX = "__viewed__:";

const SECTION_UNDO_MS = 10000;
const ITEM_UNDO_MS = 10000;
const MOVE_UNDO_MS = 10000;
const TAG_UNDO_MS = 10000;

const TAG_FILTER_LS_KEY = "tag_filter";

let GIST_ID = localStorage.getItem("gist_id") || "";
let TOKEN = localStorage.getItem("github_token") || "";

let currentSection = localStorage.getItem("current_section") || "__all__";
let sortState = parseSortState(localStorage.getItem("sort_state")) || { key: "manual", dir: "desc" };

let filterQuery = localStorage.getItem("filter_query") || "";

let showViewedInAll = (localStorage.getItem("show_viewed_all") ?? "0") === "1";

let data = { sections: {} };
let isEditing = false;

const defaultSections = ["Фильмы", "Сериалы", "Аниме"];

let selectedKey = null;

let pointer = { down: false, startX: 0, startY: 0, moved: false, startedAt: 0 };

let deleteArmSection = null;
let deleteArmSectionTimer = null;

let deleteArmItemKey = null;
let deleteArmItemTimer = null;

let undoTimer = null;
let undoPayload = null;

let editCtx = null;

let tagFilter = loadTagFilter();
let tagEditorCtx = null;

let mobileSearchOpen = false;

// ===== INIT =====
async function init() {
  applyUrlSetupSilently();
  updateSettingsIcon();
  updateShareButton();
  setupFilterUI();
  updateViewedToggleUI();
  updateTagFilterBtnUI();

  if (!GIST_ID || !TOKEN) {
    document.getElementById("viewMode").innerHTML = `<div class="setup-prompt">Откройте настройки</div>`;
    document.getElementById("counter").textContent = "";
    return;
  }

  await loadData();
  normalizeDataModel();
  ensureDefaultSections();
  normalizeDataModel();

  renderSectionList();
  updateSectionButton();
  render();
}

// ===== URL SETUP =====
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

// ===== Data model =====
function isItemObject(it) {
  return it && typeof it === "object" && !Array.isArray(it) && typeof it.text === "string";
}

function getItemText(it) {
  if (isItemObject(it)) return it.text;
  return String(it ?? "");
}

function normalizeTag(tag) {
  return String(tag || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueNormalizedTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    const nt = normalizeTag(t);
    if (!nt || seen.has(nt)) continue;
    seen.add(nt);
    out.push(nt);
  }
  return out;
}

function createItem(text, createdIso) {
  return {
    text: String(text ?? "").trim(),
    tags: [],
    created: createdIso || new Date().toISOString(),
  };
}

function ensureItemObject(it, createdIso) {
  if (isItemObject(it)) {
    it.text = String(it.text ?? "");
    it.tags = uniqueNormalizedTags(it.tags);
    if (!it.created) it.created = createdIso || new Date().toISOString();
    return it;
  }
  return createItem(getItemText(it), createdIso);
}

function normalizeDataModel() {
  if (!data || typeof data !== "object") data = { sections: {} };
  if (!data.sections || typeof data.sections !== "object") data.sections = {};

  for (const sectionKey of Object.keys(data.sections)) {
    let sec = data.sections[sectionKey];
    if (!sec || typeof sec !== "object") sec = { items: [], modified: new Date().toISOString() };
    if (!Array.isArray(sec.items)) sec.items = [];
    if (!sec.modified) sec.modified = new Date().toISOString();

    const baseMs = Date.parse(sec.modified) || Date.now();
    sec.items = sec.items.map((it, i) => ensureItemObject(it, new Date(baseMs + i).toISOString()));
    data.sections[sectionKey] = sec;
  }
}

// ===== Viewed helpers =====
function isViewedSection(name) {
  return typeof name === "string" && name.startsWith(VIEWED_KEY_PREFIX);
}

function baseSectionName(name) {
  if (typeof name !== "string") return "";
  if (name.startsWith(VIEWED_KEY_PREFIX)) return name.slice(VIEWED_KEY_PREFIX.length);
  return name;
}

function viewedSectionKeyFor(sourceSectionName) {
  return VIEWED_KEY_PREFIX + baseSectionName(sourceSectionName);
}

function editorLabelForSectionKey(sectionKey) {
  return isViewedSection(sectionKey) ? `~${baseSectionName(sectionKey)}` : baseSectionName(sectionKey);
}

function sectionKeyFromEditorLabel(label) {
  const t = String(label || "").trim();
  if (t.startsWith(VIEWED_KEY_PREFIX)) return t;
  if (t.startsWith("~")) return VIEWED_KEY_PREFIX + t.slice(1).trim();
  return t;
}

function labelHTMLForSection(sectionKey) {
  const base = escapeHtml(baseSectionName(sectionKey));
  if (!isViewedSection(sectionKey)) return `<span class="sec-label">${base}</span>`;
  return `<span class="sec-label"><svg class="inline-icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>${base}</span>`;
}

// ===== Mobile search toggle =====
function toggleMobileSearch() {
  mobileSearchOpen = !mobileSearchOpen;
  const wrap = document.getElementById("filterWrap");
  const btn = document.getElementById("searchToggleBtn");
  
  wrap.classList.toggle("mobile-open", mobileSearchOpen);
  btn.classList.toggle("on", mobileSearchOpen);
  
  if (mobileSearchOpen) {
    document.getElementById("filterInput").focus();
  }
}

// ===== Filter (text) =====
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
    closeTagEditor();
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
  closeTagEditor();
  render();
  input.focus();
}

// ===== Tag filter =====
function loadTagFilter() {
  try {
    const raw = localStorage.getItem(TAG_FILTER_LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(normalizeTag).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveTagFilter() {
  localStorage.setItem(TAG_FILTER_LS_KEY, JSON.stringify([...tagFilter]));
}

function updateTagFilterBtnUI() {
  const btn = document.getElementById("tagFilterBtn");
  if (!btn) return;
  btn.classList.toggle("on", tagFilter.size > 0);
}

function toggleTagFilterMenu() {
  if (isEditing) return;

  const menu = document.getElementById("tagFilterMenu");
  const btn = document.getElementById("tagFilterBtn");

  if (!menu || !btn) return;

  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }

  renderTagFilterMenu();
  openMenu("tagFilterMenu", btn, "right");
}

function getScopeItems() {
  const out = [];

  if (currentSection === "__all__") {
    for (const sectionKey of Object.keys(data.sections)) {
      if (!shouldIncludeSectionInAll(sectionKey)) continue;
      const sec = data.sections[sectionKey];
      const arr = sec?.items || [];
      for (let i = 0; i < arr.length; i++) {
        const item = ensureItemObject(arr[i]);
        sec.items[i] = item;
        out.push({ item, sectionKey, index: i });
      }
    }
  } else {
    const sec = data.sections[currentSection];
    const arr = sec?.items || [];
    for (let i = 0; i < arr.length; i++) {
      const item = ensureItemObject(arr[i]);
      sec.items[i] = item;
      out.push({ item, sectionKey: currentSection, index: i });
    }
  }

  return out;
}

function buildTagCounts() {
  const counts = new Map();
  for (const { item } of getScopeItems()) {
    const tags = uniqueNormalizedTags(item.tags);
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

function renderTagFilterMenu() {
  const list = document.getElementById("tagFilterList");
  const hint = document.getElementById("tagFilterHint");
  if (!list || !hint) return;

  const counts = buildTagCounts();
  const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, "ru"));

  if (!tags.length) {
    list.innerHTML = `<div class="tag-empty">Тегов нет</div>`;
    hint.textContent = "";
    return;
  }

  list.innerHTML = tags
    .map((t) => {
      const on = tagFilter.has(t);
      const count = counts.get(t) || 0;
      return `
        <div class="tag-option ${on ? "on" : ""}" data-tag="${escapeAttr(t)}">
          <span class="tag-check">
            <svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-check"></use></svg>
          </span>
          <span class="tag-name">${escapeHtml(t)}</span>
          <span class="tag-count">${count}</span>
        </div>
      `;
    })
    .join("");

  // attach click handlers (no inline onclick to avoid menu closing)
  list.querySelectorAll(".tag-option").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = el.dataset.tag;
      toggleTagFilterInternal(tag);
    });
  });

  hint.textContent = tagFilter.size ? `Выбрано: ${tagFilter.size}` : "Фильтр выключен";
}

function toggleTagFilterInternal(tag) {
  if (isEditing) return;
  const t = normalizeTag(tag);
  if (!t) return;

  if (tagFilter.has(t)) tagFilter.delete(t);
  else tagFilter.add(t);

  saveTagFilter();
  updateTagFilterBtnUI();
  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  renderTagFilterMenu();
  render();
}

function toggleTagFilter(tag) {
  toggleTagFilterInternal(tag);
}

function clearTagFilter() {
  if (isEditing) return;
  tagFilter = new Set();
  saveTagFilter();
  updateTagFilterBtnUI();
  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  renderTagFilterMenu();
  render();
}

// ===== Tag editor (per item) =====
function openTagEditor(sectionKey, index, anchorEl) {
  if (isEditing) return;

  const menu = document.getElementById("tagEditorMenu");
  if (!menu) return;

  const sec = data.sections[sectionKey];
  const idx = Number(index);
  if (!sec || !Array.isArray(sec.items) || !Number.isFinite(idx) || idx < 0 || idx >= sec.items.length) return;

  const item = ensureItemObject(sec.items[idx]);
  sec.items[idx] = item;

  tagEditorCtx = { sectionKey, index: idx };

  const title = document.getElementById("tagEditorTitle");
  if (title) title.textContent = `Теги: ${truncate(item.text, 24)}`;

  const input = document.getElementById("tagAddInput");
  if (input) input.value = "";

  renderTagEditorList();
  openMenu("tagEditorMenu", anchorEl, "right");

  if (input) input.focus();
}

function closeTagEditor() {
  tagEditorCtx = null;
  const menu = document.getElementById("tagEditorMenu");
  if (menu) menu.classList.add("hidden");
}

function getCurrentTagEditorItem() {
  if (!tagEditorCtx) return null;
  const { sectionKey, index } = tagEditorCtx;
  const item = data.sections?.[sectionKey]?.items?.[index];
  if (!item) return null;
  return ensureItemObject(item);
}

function renderTagEditorList() {
  const list = document.getElementById("tagEditorList");
  if (!list) return;

  const item = getCurrentTagEditorItem();
  if (!item) {
    list.innerHTML = `<div class="tag-empty">—</div>`;
    return;
  }

  const tags = uniqueNormalizedTags(item.tags).sort((a, b) => a.localeCompare(b, "ru"));
  if (!tags.length) {
    list.innerHTML = `<div class="tag-empty">Нет тегов</div>`;
    return;
  }

  list.innerHTML = tags
    .map((t, i) => {
      return `
        <div class="tag-pill" data-idx="${i}" data-original="${escapeAttr(t)}">
          <input type="text" class="tag-pill-text" value="${escapeAttr(t)}" data-tag="${escapeAttr(t)}" />
          <button class="mini-btn danger" title="Удалить" data-action="remove-tag" data-tag="${escapeAttr(t)}">×</button>
        </div>
      `;
    })
    .join("");

  // attach handlers
  list.querySelectorAll(".tag-pill-text").forEach((input) => {
    input.addEventListener("blur", () => handleTagRename(input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        input.value = input.dataset.tag;
        input.blur();
      }
    });
  });

  list.querySelectorAll("[data-action='remove-tag']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = btn.dataset.tag;
      removeTagFromCurrentItemWithUndo(tag);
    });
  });
}

function handleTagRename(input) {
  const oldTag = normalizeTag(input.dataset.tag);
  const newTag = normalizeTag(input.value);

  if (!oldTag || !newTag || oldTag === newTag) {
    input.value = oldTag;
    return;
  }

  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const tags = uniqueNormalizedTags(item.tags);
  const idx = tags.indexOf(oldTag);
  if (idx === -1) return;

  // check duplicate
  if (tags.includes(newTag)) {
    tags.splice(idx, 1);
  } else {
    tags[idx] = newTag;
  }

  item.tags = uniqueNormalizedTags(tags);

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();
}

function handleTagAdd(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    addTagFromInput();
  } else if (e.key === "Escape") {
    closeTagEditor();
  }
}

function addTagFromInput() {
  const input = document.getElementById("tagAddInput");
  if (!input) return;
  const t = normalizeTag(input.value);
  if (!t) return;
  input.value = "";
  addTagToCurrentItem(t);
}

function addTagToCurrentItem(tag) {
  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const t = normalizeTag(tag);
  if (!t) return;

  item.tags = uniqueNormalizedTags([...(item.tags || []), t]);

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();
}

function removeTagFromCurrentItemWithUndo(tag) {
  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const t = normalizeTag(tag);
  if (!t) return;

  const oldTags = [...item.tags];
  item.tags = uniqueNormalizedTags((item.tags || []).filter((x) => normalizeTag(x) !== t));

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();

  // undo
  startUndo(
    {
      type: "tag",
      sectionKey,
      index,
      oldTags,
      removedTag: t,
    },
    TAG_UNDO_MS,
    `Тег удалён: ${t}`
  );
}

function removeTagFromCurrentItem(tag) {
  removeTagFromCurrentItemWithUndo(tag);
}

function clearTagsForCurrentItem() {
  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const oldTags = [...item.tags];
  item.tags = [];

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();

  if (oldTags.length) {
    startUndo(
      {
        type: "tagClear",
        sectionKey,
        index,
        oldTags,
      },
      TAG_UNDO_MS,
      `Теги очищены`
    );
  }
}

// ===== Viewed toggle =====
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
  closeTagEditor();
  updateViewedToggleUI();
  render();
}

// ===== Menu positioning =====
function openMenu(menuId, anchorEl, align = "left") {
  closeAllMenus(menuId);

  const menu = document.getElementById(menuId);
  const container = document.getElementById("container");

  if (!menu || !container || !anchorEl) return;

  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";

  const cRect = container.getBoundingClientRect();
  const aRect = anchorEl.getBoundingClientRect();
  const mRect = menu.getBoundingClientRect();

  const top = aRect.bottom - cRect.top + 8;
  let left = align === "right" ? aRect.right - cRect.left - mRect.width : aRect.left - cRect.left;

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
        <div class="menu-option ${currentSection === sectionKey ? "active" : ""} ${armed ? "armed" : ""}"
             onclick="selectSection('${escapeQuotes(sectionKey)}')">
          <span>${labelHTMLForSection(sectionKey)}</span>

          <span class="menu-actions" onclick="event.stopPropagation()">
            <button class="mini-btn danger" title="Удалить" onclick="handleSectionDelete('${escapeQuotes(sectionKey)}')">×</button>
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
  closeTagEditor();
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

function handleSectionDelete(sectionKey) {
  if (Object.keys(data.sections).length <= 1) return;
  if (!data.sections[sectionKey]) return;

  if (deleteArmSection === sectionKey) {
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
    closeTagEditor();
    disarmSectionDelete();

    saveData();
    renderSectionList();
    render();

    startUndo(payload, SECTION_UNDO_MS, `Раздел удалён: ${baseSectionName(sectionKey)}`);
    return;
  }

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
  closeTagEditor();
  updateSortMenuUI();
  document.getElementById("sortMenu").classList.add("hidden");
  render();
}

function defaultDirForKey(key) {
  if (key === "alpha") return "asc";
  if (key === "date") return "desc";
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

function createdMs(item) {
  const v = item?.created;
  const ms = typeof v === "number" ? v : Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function getSortedItems(items) {
  if (!items || sortState.key === "manual") return items;

  const sorted = [...items];
  const getText = (x) => x.text ?? x.item?.text ?? "";

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
      sorted.sort((a, b) => createdMs(a.item) - createdMs(b.item));
      if (sortState.dir === "desc") sorted.reverse();
      break;
  }

  return sorted;
}

// ===== API =====
async function loadData() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const gist = await res.json();
    if (gist.files?.["contents.json"]) {
      const loaded = JSON.parse(gist.files["contents.json"].content);
      data = loaded?.sections ? loaded : { sections: {} };
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
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { "contents.json": { content: JSON.stringify(data, null, 2) } },
      }),
    });
  } catch (e) {
    console.error(e);
  }
}

// ===== Undo =====
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

function findItemIndexByCreated(arr, created) {
  if (!Array.isArray(arr) || !created) return -1;
  return arr.findIndex((x) => isItemObject(x) && x.created === created);
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
    const { sectionKey, index, item } = undoPayload;

    if (!data.sections[sectionKey]) {
      data.sections[sectionKey] = { items: [], modified: new Date().toISOString() };
    }

    normalizeDataModel();

    const arr = data.sections[sectionKey].items || (data.sections[sectionKey].items = []);
    const idx = Math.max(0, Math.min(Number(index), arr.length));

    arr.splice(idx, 0, ensureItemObject(item));
    data.sections[sectionKey].modified = new Date().toISOString();

    saveData();
    render();
  }

  if (undoPayload.type === "move") {
    const { fromSectionKey, fromIndex, toSectionKey, toIndex, item } = undoPayload;

    if (!data.sections[toSectionKey]) data.sections[toSectionKey] = { items: [], modified: new Date().toISOString() };
    if (!data.sections[fromSectionKey]) data.sections[fromSectionKey] = { items: [], modified: new Date().toISOString() };

    normalizeDataModel();

    const toArr = data.sections[toSectionKey].items;
    let removedIdx = -1;

    if (Number.isFinite(toIndex) && toIndex >= 0 && toIndex < toArr.length) {
      const candidate = toArr[toIndex];
      if (isItemObject(candidate) && isItemObject(item) && candidate.created === item.created) {
        removedIdx = toIndex;
      }
    }

    if (removedIdx === -1) {
      removedIdx = findItemIndexByCreated(toArr, item?.created);
    }

    if (removedIdx === -1) {
      const t = String(item?.text ?? "");
      removedIdx = toArr.findIndex((x) => isItemObject(x) && x.text === t);
    }

    let movedItem = ensureItemObject(item);
    if (removedIdx !== -1) {
      movedItem = ensureItemObject(toArr.splice(removedIdx, 1)[0]);
    }

    data.sections[toSectionKey].modified = new Date().toISOString();

    const fromArr = data.sections[fromSectionKey].items;
    const idx = Math.max(0, Math.min(Number(fromIndex), fromArr.length));
    fromArr.splice(idx, 0, movedItem);
    data.sections[fromSectionKey].modified = new Date().toISOString();

    selectedKey = null;
    disarmItemDelete();
    closeTagEditor();

    saveData();
    renderSectionList();
    render();
  }

  if (undoPayload.type === "tag") {
    const { sectionKey, index, oldTags } = undoPayload;
    const item = data.sections?.[sectionKey]?.items?.[index];
    if (item) {
      item.tags = uniqueNormalizedTags(oldTags);
      data.sections[sectionKey].modified = new Date().toISOString();
      saveData();
      render();
      renderTagEditorList();
      renderTagFilterMenu();
    }
  }

  if (undoPayload.type === "tagClear") {
    const { sectionKey, index, oldTags } = undoPayload;
    const item = data.sections?.[sectionKey]?.items?.[index];
    if (item) {
      item.tags = uniqueNormalizedTags(oldTags);
      data.sections[sectionKey].modified = new Date().toISOString();
      saveData();
      render();
      renderTagEditorList();
      renderTagFilterMenu();
    }
  }

  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
  undoPayload = null;
  hideUndo();
});

// ===== ITEM actions =====
function moveItemToViewed(sectionKey, index) {
  if (!data.sections[sectionKey]) return;
  if (isViewedSection(sectionKey)) return;

  normalizeDataModel();

  const srcItems = data.sections[sectionKey].items || [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= srcItems.length) return;

  const item = ensureItemObject(srcItems[idx]);
  const payloadItem = JSON.parse(JSON.stringify(item));

  srcItems.splice(idx, 1);
  data.sections[sectionKey].modified = new Date().toISOString();

  const destKey = viewedSectionKeyFor(sectionKey);
  if (!data.sections[destKey]) data.sections[destKey] = { items: [], modified: new Date().toISOString() };
  normalizeDataModel();

  const toIndex = data.sections[destKey].items.length;
  data.sections[destKey].items.push(item);
  data.sections[destKey].modified = new Date().toISOString();

  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  saveData();
  renderSectionList();
  render();

  startUndo(
    {
      type: "move",
      fromSectionKey: sectionKey,
      fromIndex: idx,
      toSectionKey: destKey,
      toIndex,
      item: payloadItem,
    },
    MOVE_UNDO_MS,
    "Перемещено в просмотренное"
  );
}

function returnItemFromViewed(viewedSectionKey, index) {
  if (!data.sections[viewedSectionKey]) return;
  if (!isViewedSection(viewedSectionKey)) return;

  normalizeDataModel();

  const srcItems = data.sections[viewedSectionKey].items || [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= srcItems.length) return;

  const item = ensureItemObject(srcItems[idx]);
  const payloadItem = JSON.parse(JSON.stringify(item));

  srcItems.splice(idx, 1);
  data.sections[viewedSectionKey].modified = new Date().toISOString();

  const baseKey = baseSectionName(viewedSectionKey);
  if (!data.sections[baseKey]) data.sections[baseKey] = { items: [], modified: new Date().toISOString() };
  normalizeDataModel();

  const toIndex = data.sections[baseKey].items.length;
  data.sections[baseKey].items.push(item);
  data.sections[baseKey].modified = new Date().toISOString();

  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  saveData();
  renderSectionList();
  render();

  startUndo(
    {
      type: "move",
      fromSectionKey: viewedSectionKey,
      fromIndex: idx,
      toSectionKey: baseKey,
      toIndex,
      item: payloadItem,
    },
    MOVE_UNDO_MS,
    "Возвращено из просмотренного"
  );
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

  const item = ensureItemObject(arr[idx]);

  arr.splice(idx, 1);
  data.sections[sectionKey].modified = new Date().toISOString();

  disarmItemDelete();
  closeTagEditor();
  selectedKey = null;

  saveData();
  render();

  startUndo(
    { type: "item", sectionKey, index: idx, item: JSON.parse(JSON.stringify(item)) },
    ITEM_UNDO_MS,
    `Запись удалена`
  );
}

// ===== EDIT =====
function toggleEdit() {
  if (!TOKEN || !GIST_ID) {
    toggleSettings();
    return;
  }
  isEditing ? cancelEdit() : startEdit();
}

function matchesTextFilter(item, filterLower) {
  if (!filterLower) return true;
  return String(item?.text || "").toLowerCase().includes(filterLower);
}

function matchesTagFilter(item, tagSet) {
  if (!tagSet || tagSet.size === 0) return true;
  const tags = uniqueNormalizedTags(item?.tags);
  return tags.some((t) => tagSet.has(t));
}

function startEdit() {
  isEditing = true;
  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  setFilterLock(true);

  const editor = document.getElementById("editor");
  const hint = document.getElementById("editHint");
  document.getElementById("editUse").setAttribute("href", `${ICONS}#i-x`);

  const filterLower = (filterQuery || "").trim().toLowerCase();
  const tagSet = new Set(tagFilter);

  normalizeDataModel();

  if (currentSection === "__all__") {
    const masksBySection = {};
    const lines = [];

    for (const sectionKey of Object.keys(data.sections)) {
      if (!showViewedInAll && isViewedSection(sectionKey)) continue;

      const sec = data.sections[sectionKey];
      const items = sec?.items || [];

      const mask = items.map((it, i) => {
        const item = ensureItemObject(it);
        sec.items[i] = item;
        return matchesTextFilter(item, filterLower) && matchesTagFilter(item, tagSet);
      });

      if (mask.some(Boolean)) masksBySection[sectionKey] = mask;

      for (let i = 0; i < items.length; i++) {
        if (mask[i]) lines.push(`[${editorLabelForSectionKey(sectionKey)}] ${getItemText(sec.items[i])}`);
      }
    }

    editor.value = lines.join("\n");
    hint.classList.remove("hidden");
    editCtx = { mode: "all", filterLower, showViewedInAll, tagFilterArr: [...tagSet], masksBySection };
  } else {
    const sectionKey = currentSection;
    const sec = data.sections[sectionKey];
    const orig = sec?.items || [];

    const mask = orig.map((it, i) => {
      const item = ensureItemObject(it);
      sec.items[i] = item;
      return matchesTextFilter(item, filterLower) && matchesTagFilter(item, tagSet);
    });

    const lines = sec.items.filter((_, i) => mask[i]).map((x) => x.text);

    editor.value = lines.join("\n");
    hint.classList.add("hidden");
    editCtx = { mode: "section", sectionKey, filterLower, tagFilterArr: [...tagSet], mask };
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

function mergeByMask(original, mask, replacementTexts) {
  const out = [];
  let ri = 0;
  const m = Array.isArray(mask) ? mask : new Array(original.length).fill(false);

  for (let i = 0; i < original.length; i++) {
    if (m[i]) {
      if (ri < replacementTexts.length) {
        const nextText = replacementTexts[ri++];
        const origItem = ensureItemObject(original[i]);
        out.push({ ...origItem, text: String(nextText ?? "").trim() });
      }
    } else out.push(original[i]);
  }

  while (ri < replacementTexts.length) {
    const t = String(replacementTexts[ri++] ?? "").trim();
    if (!t) continue;
    out.push(createItem(t));
  }

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

  normalizeDataModel();

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

function applyTextFilter(items) {
  const q = (filterQuery || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => String(it.text || "").toLowerCase().includes(q));
}

function applyTagFilter(items) {
  if (!tagFilter || tagFilter.size === 0) return items;
  return items.filter((it) => {
    const tags = uniqueNormalizedTags(it.item?.tags);
    return tags.some((t) => tagFilter.has(t));
  });
}

function buildItemsForView() {
  normalizeDataModel();

  let items = [];
  if (currentSection === "__all__") {
    for (const sectionKey of Object.keys(data.sections)) {
      if (!shouldIncludeSectionInAll(sectionKey)) continue;
      const sec = data.sections[sectionKey];
      const arr = sec?.items || [];
      for (let i = 0; i < arr.length; i++) {
        const item = ensureItemObject(arr[i]);
        sec.items[i] = item;
        items.push({ item, text: item.text, sectionKey, index: i });
      }
    }
  } else {
    const sec = data.sections[currentSection];
    const arr = sec?.items || [];
    for (let i = 0; i < arr.length; i++) {
      const item = ensureItemObject(arr[i]);
      sec.items[i] = item;
      items.push({ item, text: item.text, sectionKey: currentSection, index: i });
    }
  }

  items = applyTextFilter(items);
  items = applyTagFilter(items);
  items = getSortedItems(items);
  return items;
}

function render() {
  const view = document.getElementById("viewMode");
  const items = buildItemsForView();

  updateTagFilterBtnUI();

  if (!items.length) {
    view.innerHTML = "";
    document.getElementById("counter").textContent = "0";
    return;
  }

  const keySet = new Set(items.map((it) => `${it.sectionKey}|${it.index}`));
  if (selectedKey && !keySet.has(selectedKey)) {
    selectedKey = null;
    disarmItemDelete();
    closeTagEditor();
  }

  view.innerHTML = items
    .map((it) => {
      const key = `${it.sectionKey}|${it.index}`;
      const selected = selectedKey === key;

      const showSecTag = currentSection === "__all__";
      const viewed = isViewedSection(it.sectionKey);

      const secTag = showSecTag
        ? `<span class="item-section-tag">
             ${viewed ? `<svg class="inline-icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>` : ``}
             ${escapeHtml(baseSectionName(it.sectionKey))}
           </span>`
        : "";

      const tags = uniqueNormalizedTags(it.item?.tags).sort((a, b) => a.localeCompare(b, "ru"));
      const tagsHtml = tags.length
        ? `<span class="item-tags">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</span>`
        : "";

      const rightAction = viewed
        ? `<button class="right-action" data-action="back" title="Вернуть из просмотренного">
             <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-undo"></use></svg>
           </button>`
        : `<button class="right-action" data-action="mark" title="Переместить в просмотренное">
             <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>
           </button>`;

      return `
        <div class="item-line ${selected ? "selected" : ""} ${deleteArmItemKey === key ? "del-armed" : ""}"
             data-key="${escapeAttr(key)}"
             data-section="${escapeAttr(it.sectionKey)}"
             data-index="${String(it.index)}">
          <button class="item-del" data-action="item-del" title="Удалить">
            <svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-x"></use></svg>
          </button>

          ${secTag}

          <div class="item-main">
            <span class="item-text">${escapeHtml(it.text)}</span>
            ${tagsHtml}
          </div>

          <button class="tag-action" data-action="tags" title="Теги">
            <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-tag"></use></svg>
          </button>

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
    if (action === "tags") {
      if (selectedKey !== key) {
        selectedKey = key;
        disarmItemDelete();
        render();
      }
      openTagEditor(sectionKey, index, actionEl);
      return;
    }
    if (action === "item-del") {
      if (selectedKey !== key) {
        selectedKey = key;
        disarmItemDelete();
        closeTagEditor();
        render();
        armItemDelete(key);
        return;
      }

      if (deleteArmItemKey === key) {
        deleteItemNow(sectionKey, index);
        return;
      }

      armItemDelete(key);
      return;
    }
  }

  const sel = window.getSelection ? window.getSelection() : null;
  if (sel && !sel.isCollapsed) return;

  const longPress = pointer.startedAt && Date.now() - pointer.startedAt > 350;
  if (longPress) return;
  if (pointer.moved) return;

  const key = line.dataset.key;
  const nowSelected = selectedKey !== key;

  selectedKey = nowSelected ? key : null;
  disarmItemDelete();
  closeTagEditor();

  document.querySelectorAll("#viewMode .item-line.selected").forEach((el) => el.classList.remove("selected"));
  if (selectedKey) line.classList.add("selected");
});

// ===== Close menus =====
function closeAllMenus(except) {
  ["sortMenu", "settingsMenu", "sectionMenu", "tagFilterMenu", "tagEditorMenu"].forEach((id) => {
    if (id === except) return;
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  if (except !== "tagEditorMenu") tagEditorCtx = null;
}

document.addEventListener("click", (e) => {
  if (
    !e.target.closest(".dropdown-menu") &&
    !e.target.closest(".icon-btn") &&
    !e.target.closest(".section-btn") &&
    !e.target.closest(".all-toggle") &&
    !e.target.closest(".search-toggle-btn")
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

function truncate(str, max) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

// Expose functions
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
  toggleTagFilterMenu,
  clearTagFilter,
  toggleTagFilter,
  closeTagEditor,
  handleTagAdd,
  addTagFromInput,
  removeTagFromCurrentItem,
  clearTagsForCurrentItem,
  toggleMobileSearch,
});

init();
