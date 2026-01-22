// Contents app (GitHub Pages + Gist)
// Viewed status stored as special tag "__viewed__"

const ICONS = "icons.svg";
const VIEWED_TAG = "__viewed__";

const SECTION_UNDO_MS = 10000;
const ITEM_UNDO_MS = 10000;
const TAG_UNDO_MS = 10000;

const TAG_FILTER_LS_KEY = "tag_filter";
const VIEWED_FILTER_LS_KEY = "viewed_filter";

let GIST_ID = localStorage.getItem("gist_id") || "";
let TOKEN = localStorage.getItem("github_token") || "";

let currentSection = localStorage.getItem("current_section") || "__all__";
let sortState = parseSortState(localStorage.getItem("sort_state")) || { key: "manual", dir: "desc" };

let filterQuery = localStorage.getItem("filter_query") || "";

// Viewed filter: "hide" | "show" | "only"
let viewedFilter = localStorage.getItem(VIEWED_FILTER_LS_KEY) || "hide";

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
  setupFilterUI();
  updateViewedToggleUI();
  updateTagFilterBtnUI();
  updateShareButton();

  if (!GIST_ID || !TOKEN) {
    document.getElementById("viewMode").innerHTML = `<div class="setup-prompt">Откройте меню → Подключение</div>`;
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

// ===== Viewed helpers (tag-based) =====
function isItemViewed(item) {
  if (!item || !Array.isArray(item.tags)) return false;
  return item.tags.some(t => normalizeTag(t) === VIEWED_TAG);
}

function setItemViewed(item, viewed) {
  if (!item) return;
  item.tags = uniqueNormalizedTags(item.tags || []);
  const hasViewed = item.tags.includes(VIEWED_TAG);

  if (viewed && !hasViewed) {
    item.tags.unshift(VIEWED_TAG);
  } else if (!viewed && hasViewed) {
    item.tags = item.tags.filter(t => t !== VIEWED_TAG);
  }
}

function getDisplayTags(item) {
  if (!item || !Array.isArray(item.tags)) return [];
  return item.tags.filter(t => normalizeTag(t) !== VIEWED_TAG);
}

// ===== Mobile search toggle =====
function toggleMobileSearch() {
  mobileSearchOpen = !mobileSearchOpen;
  const row = document.getElementById("mobileSearchRow");
  const btn = document.getElementById("searchToggleBtn");

  row.classList.toggle("hidden", !mobileSearchOpen);
  btn.classList.toggle("on", mobileSearchOpen);

  if (mobileSearchOpen) {
    const input = document.getElementById("mobileFilterInput");
    input.value = filterQuery;
    input.focus();
  }
}

// ===== Filter (text) =====
function setupFilterUI() {
  const input = document.getElementById("filterInput");
  const clear = document.getElementById("filterClear");

  input.value = filterQuery;
  clear.classList.toggle("hidden", !filterQuery);

  input.oninput = () => handleFilterInput(input.value);
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      clearFilter();
      input.blur();
    }
  };

  const mobileInput = document.getElementById("mobileFilterInput");
  const mobileClear = document.getElementById("mobileFilterClear");

  if (mobileInput) {
    mobileInput.value = filterQuery;
    mobileClear.classList.toggle("hidden", !filterQuery);

    mobileInput.oninput = () => handleFilterInput(mobileInput.value);
    mobileInput.onkeydown = (e) => {
      if (e.key === "Escape") {
        clearFilter();
        mobileInput.blur();
      }
    };
  }
}

function handleFilterInput(value) {
  if (isEditing) return;
  filterQuery = value || "";
  localStorage.setItem("filter_query", filterQuery);

  document.getElementById("filterInput").value = filterQuery;
  document.getElementById("filterClear").classList.toggle("hidden", !filterQuery);

  const mobileInput = document.getElementById("mobileFilterInput");
  const mobileClear = document.getElementById("mobileFilterClear");
  if (mobileInput) {
    mobileInput.value = filterQuery;
    mobileClear.classList.toggle("hidden", !filterQuery);
  }

  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();
  render();
}

function setFilterLock(locked) {
  const input = document.getElementById("filterInput");
  const clear = document.getElementById("filterClear");
  input.disabled = locked;
  if (locked) clear.classList.add("hidden");
  else clear.classList.toggle("hidden", !filterQuery);

  const mobileInput = document.getElementById("mobileFilterInput");
  const mobileClear = document.getElementById("mobileFilterClear");
  if (mobileInput) {
    mobileInput.disabled = locked;
    if (locked) mobileClear.classList.add("hidden");
    else mobileClear.classList.toggle("hidden", !filterQuery);
  }
}

function clearFilter() {
  if (isEditing) return;
  filterQuery = "";
  localStorage.setItem("filter_query", "");

  document.getElementById("filterInput").value = "";
  document.getElementById("filterClear").classList.add("hidden");

  const mobileInput = document.getElementById("mobileFilterInput");
  const mobileClear = document.getElementById("mobileFilterClear");
  if (mobileInput) {
    mobileInput.value = "";
    mobileClear.classList.add("hidden");
  }

  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();
  render();
}

// ===== Tag filter =====
function loadTagFilter() {
  try {
    const raw = localStorage.getItem(TAG_FILTER_LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(normalizeTag).filter(t => t && t !== VIEWED_TAG));
  } catch {
    return new Set();
  }
}

function saveTagFilter() {
  const arr = [...tagFilter].filter(t => t !== VIEWED_TAG);
  localStorage.setItem(TAG_FILTER_LS_KEY, JSON.stringify(arr));
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
    const tags = getDisplayTags(item);
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
  if (!t || t === VIEWED_TAG) return;

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

  const tags = getDisplayTags(item).sort((a, b) => a.localeCompare(b, "ru"));
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

  if (!oldTag || !newTag || oldTag === newTag || oldTag === VIEWED_TAG || newTag === VIEWED_TAG) {
    input.value = oldTag;
    return;
  }

  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const tags = uniqueNormalizedTags(item.tags);
  const idx = tags.indexOf(oldTag);
  if (idx === -1) return;

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
  if (!t || t === VIEWED_TAG) return;
  input.value = "";
  addTagToCurrentItem(t);
}

function addTagToCurrentItem(tag) {
  const item = getCurrentTagEditorItem();
  if (!item || !tagEditorCtx) return;

  const t = normalizeTag(tag);
  if (!t || t === VIEWED_TAG) return;

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
  if (!t || t === VIEWED_TAG) return;

  const oldTags = [...item.tags];
  item.tags = uniqueNormalizedTags((item.tags || []).filter((x) => normalizeTag(x) !== t));

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();

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

  const wasViewed = isItemViewed(item);
  const oldTags = [...item.tags];
  item.tags = wasViewed ? [VIEWED_TAG] : [];

  const { sectionKey, index } = tagEditorCtx;
  data.sections[sectionKey].items[index] = item;
  data.sections[sectionKey].modified = new Date().toISOString();

  saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();

  if (oldTags.filter(t => t !== VIEWED_TAG).length) {
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

// ===== Viewed toggle (3 states: hide / show / only) =====
function updateViewedToggleUI() {
  const btn = document.getElementById("viewedToggleBtn");
  const use = document.getElementById("viewedToggleUse");

  btn.classList.remove("state-show", "state-only");

  if (viewedFilter === "hide") {
    use.setAttribute("href", `${ICONS}#i-eye-off`);
  } else if (viewedFilter === "show") {
    btn.classList.add("state-show");
    use.setAttribute("href", `${ICONS}#i-eye`);
  } else if (viewedFilter === "only") {
    btn.classList.add("state-only");
    use.setAttribute("href", `${ICONS}#i-eye`);
  }
}

function cycleViewedFilter() {
  if (isEditing) return;

  if (viewedFilter === "hide") viewedFilter = "show";
  else if (viewedFilter === "show") viewedFilter = "only";
  else viewedFilter = "hide";

  localStorage.setItem(VIEWED_FILTER_LS_KEY, viewedFilter);
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

// ===== SETTINGS (inside section menu) =====
function toggleSettingsPanel() {
  const panel = document.getElementById("settingsPanel");
  if (!panel) return;

  const isHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !isHidden);

  if (isHidden) {
    document.getElementById("inputGistId").value = GIST_ID;
    document.getElementById("inputToken").value = TOKEN;
    updateShareButton();
  }
}

function saveSettings() {
  const gistId = document.getElementById("inputGistId").value.trim();
  const token = document.getElementById("inputToken").value.trim();
  if (!gistId || !token) return;

  localStorage.setItem("gist_id", gistId);
  localStorage.setItem("github_token", token);
  GIST_ID = gistId;
  TOKEN = token;

  document.getElementById("sectionMenu").classList.add("hidden");
  document.getElementById("settingsPanel").classList.add("hidden");
  updateShareButton();
  init();
}

function updateShareButton() {
  const btn = document.getElementById("shareBtn");
  if (btn) btn.style.display = GIST_ID && TOKEN ? "grid" : "none";
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
    document.getElementById("settingsPanel").classList.add("hidden");
    disarmSectionDelete();
    return;
  }

  renderSectionList();
  document.getElementById("newSectionInput").classList.add("hidden");
  document.getElementById("settingsPanel").classList.add("hidden");
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
          <span>${escapeHtml(sectionKey)}</span>

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
  document.getElementById("sectionMenu").classList.add("hidden");
  document.getElementById("settingsPanel").classList.add("hidden");
  render();
}

function updateSectionButton() {
  const el = document.getElementById("currentSectionName");
  el.textContent = currentSection === "__all__" ? "Все" : currentSection;
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
    }

    selectedKey = null;
    disarmItemDelete();
    closeTagEditor();
    disarmSectionDelete();

    saveData();
    renderSectionList();
    render();

    startUndo(payload, SECTION_UNDO_MS, `Раздел удалён: ${sectionKey}`);
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

  if (undoPayload.type === "viewed") {
    const { sectionKey, index, wasViewed } = undoPayload;
    const item = data.sections?.[sectionKey]?.items?.[index];
    if (item) {
      setItemViewed(item, wasViewed);
      data.sections[sectionKey].modified = new Date().toISOString();
      saveData();
      render();
    }
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
function toggleItemViewed(sectionKey, index) {
  const sec = data.sections[sectionKey];
  if (!sec) return;

  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= sec.items.length) return;

  const item = ensureItemObject(sec.items[idx]);
  sec.items[idx] = item;

  const wasViewed = isItemViewed(item);
  setItemViewed(item, !wasViewed);
  sec.modified = new Date().toISOString();

  selectedKey = null;
  disarmItemDelete();
  closeTagEditor();

  saveData();
  render();

  startUndo(
    {
      type: "viewed",
      sectionKey,
      index: idx,
      wasViewed,
    },
    TAG_UNDO_MS,
    wasViewed ? "Снято: просмотрено" : "Отмечено просмотренным"
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
    toggleSectionMenu();
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
  const tags = getDisplayTags(item);
  return tags.some((t) => tagSet.has(t));
}

function matchesViewedFilter(item) {
  const viewed = isItemViewed(item);
  if (viewedFilter === "hide") return !viewed;
  if (viewedFilter === "only") return viewed;
  return true; // "show"
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
      const sec = data.sections[sectionKey];
      const items = sec?.items || [];

      const mask = items.map((it, i) => {
        const item = ensureItemObject(it);
        sec.items[i] = item;
        return matchesTextFilter(item, filterLower) && matchesTagFilter(item, tagSet) && matchesViewedFilter(item);
      });

      if (mask.some(Boolean)) masksBySection[sectionKey] = mask;

      for (let i = 0; i < items.length; i++) {
        if (mask[i]) lines.push(`[${sectionKey}] ${getItemText(sec.items[i])}`);
      }
    }

    editor.value = lines.join("\n");
    hint.classList.remove("hidden");
    editCtx = { mode: "all", filterLower, viewedFilter, tagFilterArr: [...tagSet], masksBySection };
  } else {
    const sectionKey = currentSection;
    const sec = data.sections[sectionKey];
    const orig = sec?.items || [];

    const mask = orig.map((it, i) => {
      const item = ensureItemObject(it);
      sec.items[i] = item;
      return matchesTextFilter(item, filterLower) && matchesTagFilter(item, tagSet) && matchesViewedFilter(item);
    });

    const lines = sec.items.filter((_, i) => mask[i]).map((x) => x.text);

    editor.value = lines.join("\n");
    hint.classList.add("hidden");
    editCtx = { mode: "section", sectionKey, filterLower, viewedFilter, tagFilterArr: [...tagSet], mask };
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
      const sectionKey = m[1].trim();
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
function applyTextFilter(items) {
  const q = (filterQuery || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => String(it.text || "").toLowerCase().includes(q));
}

function applyTagFilterToItems(items) {
  if (!tagFilter || tagFilter.size === 0) return items;
  return items.filter((it) => {
    const tags = getDisplayTags(it.item);
    return tags.some((t) => tagFilter.has(t));
  });
}

function applyViewedFilterToItems(items) {
  return items.filter((it) => matchesViewedFilter(it.item));
}

function buildItemsForView() {
  normalizeDataModel();

  let items = [];
  if (currentSection === "__all__") {
    for (const sectionKey of Object.keys(data.sections)) {
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
  items = applyTagFilterToItems(items);
  items = applyViewedFilterToItems(items);
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
      const viewed = isItemViewed(it.item);

      const showSecTag = currentSection === "__all__";
      const secTag = showSecTag
        ? `<span class="item-section-tag">${escapeHtml(it.sectionKey)}</span>`
        : "";

      // Regular tags (excluding __viewed__)
      const tags = getDisplayTags(it.item).sort((a, b) => a.localeCompare(b, "ru"));
      const tagsHtml = tags.length
        ? `<span class="item-tags">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</span>`
        : "";

      // Viewed button: different states
      // For viewed items: always visible (light color), shows eye icon
      // When selected: shows crossed eye (to unmark)
      // For not viewed: only visible when selected, shows eye icon (to mark)
      let viewedBtnHtml;
      if (viewed) {
        const iconId = selected ? "i-eye-off" : "i-eye";
        viewedBtnHtml = `<button class="viewed-action is-viewed" data-action="toggle-viewed" title="Снять отметку">
           <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#${iconId}"></use></svg>
         </button>`;
      } else {
        viewedBtnHtml = `<button class="viewed-action not-viewed" data-action="toggle-viewed" title="Отметить просмотренным">
           <svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg>
         </button>`;
      }

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

          ${viewedBtnHtml}
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

    if (action === "toggle-viewed") {
      toggleItemViewed(sectionKey, index);
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
  ["sortMenu", "sectionMenu", "tagFilterMenu", "tagEditorMenu"].forEach((id) => {
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
    !e.target.closest(".view-toggle") &&
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
  cycleViewedFilter,
  clearFilter,
  toggleSort,
  setSortKey,
  toggleEdit,
  cancelEdit,
  saveEdit,
  toggleSettingsPanel,
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
