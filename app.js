// Contents app — GitHub Pages + Gist + TMDB
const ICONS = "icons.svg";
const VIEWED_TAG = "__viewed__";
const UNDO_MS = 10000;

let GIST_ID = localStorage.getItem("gist_id") || "";
let TOKEN = localStorage.getItem("github_token") || "";
let TMDB_KEY = localStorage.getItem("tmdb_key") || "";
let currentSection = localStorage.getItem("current_section") || "__all__";
let sortState = parseSortState(localStorage.getItem("sort_state")) || { key: "manual", dir: "desc" };
let filterQuery = localStorage.getItem("filter_query") || "";
let viewedFilter = localStorage.getItem("viewed_filter") || "hide";
let tagFilter = loadTagFilter();
let tagFilterExcluded = loadTagFilterExcluded();
let ratingFilter = loadRatingFilter(); // number|null : минимальный рейтинг (>=)

let data = { sections: {} };
let isEditing = false;
let selectedKey = localStorage.getItem("selected_key") || null;
let sortMenuOpen = (localStorage.getItem("sort_menu_open") || "0") === "1";
let editCtx = null;
let tagEditorCtx = null;
let mobileSearchOpen = false;

let pointer = { down: false, startX: 0, startY: 0, moved: false, startedAt: 0 };
let deleteArmSection = null, deleteArmSectionTimer = null;
let deleteArmItemKey = null, deleteArmItemTimer = null;
let undoTimer = null, undoPayload = null;
let savingInProgress = false; // Фоновое сохранение в процессе
let expandedDescKey = localStorage.getItem("expanded_desc_key") || null; // "secKey|idx" для раскрытого описания
let tmdbMode = localStorage.getItem("tmdb_mode") || "new";

let tmdbGenres = null;
let tmdbPickState = null; // { candidates: [], secKey, idx }

// If we generate missing stable ids during normalizeDataModel(), we should persist them.
let modelSaveQueued = false;
function queueModelSave() {
  if (modelSaveQueued) return;
  modelSaveQueued = true;
  setTimeout(() => {
    modelSaveQueued = false;
    try { saveData(); } catch {}
  }, 0);
}

// Auto TMDB choice for newly added items (via "+")
const PENDING_TMDB_PICK_CREATED_KEY = "pending_tmdb_pick_created";
let tmdbAutoPick = null; // { pickKey, key, secKey, idx, query, candidates: [], loading: bool }
let tmdbAutoReqId = 0;

// Pending auto-pick set helpers (support multiple "new" items at once)
// NOTE: despite the historical key name, we store stable item identifiers (item.id).
function loadPendingPickCreatedSet() {
  const raw = localStorage.getItem(PENDING_TMDB_PICK_CREATED_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(x => String(x)).filter(Boolean));
  } catch {
    // If it was stored as plain string in older builds
    return new Set([String(raw)]);
  }
  return new Set();
}
function savePendingPickCreatedSet(set) {
  const arr = [...(set || new Set())].map(String).filter(Boolean);
  if (!arr.length) localStorage.removeItem(PENDING_TMDB_PICK_CREATED_KEY);
  else localStorage.setItem(PENDING_TMDB_PICK_CREATED_KEY, JSON.stringify(arr));
}
function addPendingPickCreated(pickKey) {
  const set = loadPendingPickCreatedSet();
  set.add(String(pickKey));
  savePendingPickCreatedSet(set);
}
function removePendingPickCreated(pickKey) {
  const set = loadPendingPickCreatedSet();
  set.delete(String(pickKey));
  savePendingPickCreatedSet(set);
}
function isPendingPickCreated(pickKey) {
  const set = loadPendingPickCreatedSet();
  return set.has(String(pickKey));
}

function ensureItemHasId(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.id) item.id = genItemId();
  return String(item.id);
}

function findItemByCreated(created) {
  // Legacy helper (older builds used `created` as a pseudo-identifier)
  const c = String(created || "");
  if (!c) return null;
  for (const secKey of Object.keys(data.sections || {})) {
    const items = data.sections?.[secKey]?.items || [];
    for (let idx = 0; idx < items.length; idx++) {
      if (String(items[idx]?.created || "") === c) {
        return { secKey, idx, key: `${secKey}|${idx}` };
      }
    }
  }
  return null;
}

function genItemId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function findItemById(id) {
  const s = String(id || "");
  if (!s) return null;
  for (const secKey of Object.keys(data.sections || {})) {
    const items = data.sections?.[secKey]?.items || [];
    for (let idx = 0; idx < items.length; idx++) {
      if (String(items[idx]?.id || "") === s) {
        return { secKey, idx, key: `${secKey}|${idx}` };
      }
    }
  }
  return null;
}

function findItemByPickKey(pickKey) {
  // New builds use stable item.id, but we keep a fallback for legacy stored values.
  const k = String(pickKey || "");
  if (!k) return null;
  return findItemById(k) || findItemByCreated(k);
}

// Inline rename in view mode
let inlineEdit = { active: false, key: null, secKey: null, idx: null, el: null, orig: "" };
let ignoreOutsideCommitOnce = false; // prevent immediate commit on the same click that started inline edit
let lastItemTap = { key: null, at: 0 };

// Inline rename for section name (header)
let sectionRename = { active: false, orig: "", lastTapAt: 0 };

// Long press for move menu
let longPressTimer = null;
let longPressTarget = null;
const LONG_PRESS_MS = 2000;

// Prevent browser auto scroll restoration fighting with our saved scroll
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// Do not overwrite saved UI state during initial load
let restoringUI = true;

const $ = (id) => document.getElementById(id);

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// Safari/iOS: if inline edit is started by a click that is NOT on the text node itself
// (e.g. "+" button adding an empty item, or tapping empty area of an empty item),
// our global document click handler would otherwise immediately commit it.
// We ignore committing for exactly the same click event.
function markIgnoreOutsideCommitOnce() {
  ignoreOutsideCommitOnce = true;
  // IMPORTANT: do NOT use microtasks here.
  // Some browsers can run a microtask checkpoint between event listeners of the same click,
  // which would reset this flag too early and immediately commit/close the editor.
  setTimeout(() => { ignoreOutsideCommitOnce = false; }, 0);
}

function ensureIosKeyboardFocus(el) {
  // iOS Safari can ignore focus() on contenteditable unless we force a selection range.
  if (!el) return;
  try {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  } catch {}

  try {
    const sel = window.getSelection();
    if (!sel) return;
    // If selection is not inside el, force it to be.
    const needs = !(sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer));
    if (needs) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {}
}
function sanitizeInlineText(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function charOffsetFromRange(containerEl, range) {
  try {
    const pre = document.createRange();
    pre.selectNodeContents(containerEl);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  } catch {
    return null;
  }
}

function caretOffsetFromEvent(containerEl, e) {
  if (!containerEl) return null;

  // 1) Prefer current selection if it's inside the element
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (containerEl.contains(r.startContainer)) {
        const off = charOffsetFromRange(containerEl, r);
        if (typeof off === "number") return off;
      }
    }
  } catch {}

  // 2) Fallback to caret-from-point APIs
  const x = e?.clientX, y = e?.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  let r = null;
  try {
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
      }
    }
  } catch {}

  if (r && containerEl.contains(r.startContainer)) {
    const off = charOffsetFromRange(containerEl, r);
    if (typeof off === "number") return off;
  }

  return null;
}

function setCaretByCharOffset(containerEl, offset) {
  const total = (containerEl?.textContent || "").length;
  let target = Number(offset);
  if (!Number.isFinite(target)) return;
  target = Math.max(0, Math.min(total, target));

  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, null);
  let node = null;
  let remaining = target;

  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length ?? 0;
    if (remaining <= len) break;
    remaining -= len;
  }

  const sel = window.getSelection();
  const range = document.createRange();

  if (node) {
    range.setStart(node, remaining);
    range.collapse(true);
  } else {
    range.selectNodeContents(containerEl);
    range.collapse(false);
  }

  sel?.removeAllRanges();
  sel?.addRange(range);
}

function beginInlineEdit(line, opts = {}) {
  if (isEditing || savingInProgress) return;
  if (!line) return;
  const key = line.dataset.key;
  const p = parseItemKey(key);
  const item = p ? data.sections?.[p.secKey]?.items?.[p.idx] : null;
  const el = line.querySelector('[data-role="text"]');
  if (!item || !el) return;

  // Ensure selected
  if (selectedKey !== key) {
    selectedKey = key;
    localStorage.setItem("selected_key", selectedKey);
    document.querySelectorAll("#viewMode .item-line.selected").forEach(x => x.classList.remove("selected"));
    line.classList.add("selected");
  }

  // IMPORTANT (iOS Safari): starting edit from a click on a non-text area
  // can be immediately cancelled by the global document click handler.
  // Mark this click as "ignore outside commit".
  markIgnoreOutsideCommitOnce();

  inlineEdit = { active: true, key, secKey: p.secKey, idx: p.idx, el, orig: item.text || "" };
  el.setAttribute("contenteditable", "true");

  // iOS Safari: focus should happen inside user gesture (and selection must be inside contenteditable).
  ensureIosKeyboardFocus(el);

  const sel = window.getSelection();

  // Caret placement priority:
  // 1) explicit char offset (used when DOM was re-rendered)
  // 2) keep browser caret if it is already inside
  // 3) fallback to end
  let caretOk = false;

  if (typeof opts.caretOffset === "number") {
    setCaretByCharOffset(el, opts.caretOffset);
    caretOk = true;
  } else if (sel && sel.rangeCount > 0) {
    const existingRange = sel.getRangeAt(0);
    if (el.contains(existingRange.startContainer)) {
      caretOk = true;
    }
  }

  if (!caretOk) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  el.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
  };
  el.onblur = () => commitInlineEdit();
}

function endInlineEditLocal() {
  if (!inlineEdit.el) { inlineEdit = { active: false, key: null, secKey: null, idx: null, el: null, orig: "" }; return; }
  inlineEdit.el.onkeydown = null;
  inlineEdit.el.onblur = null;
  inlineEdit.el.setAttribute("contenteditable", "false");
  inlineEdit = { active: false, key: null, secKey: null, idx: null, el: null, orig: "" };
}

function cancelInlineEdit() {
  if (!inlineEdit.active) return;
  if (inlineEdit.el) inlineEdit.el.textContent = inlineEdit.orig;
  endInlineEditLocal();
  scheduleRender();
}

function commitInlineEdit() {
  if (!inlineEdit.active) return;
  const { secKey, idx, el, orig } = inlineEdit;
  const item = data.sections?.[secKey]?.items?.[idx];
  const next = sanitizeInlineText(el?.textContent);

  // If empty, revert
  const finalText = next || orig;

  endInlineEditLocal();

  if (!item) return;
  if (finalText === (item.text || "")) {
    scheduleRender();
    return;
  }

  item.text = finalText;
  data.sections[secKey].modified = new Date().toISOString();

  // Stable per-item key for TMDB pick logic
  const pickKey = ensureItemHasId(item) || String(item?.created || "");

  // TMDB choice after rename:
  // - for brand-new items ("+") AND for renamed existing items, we show the pick list.
  // - we NEVER auto-apply; user either picks a candidate or chooses "Не загружать данные".
  if (pickKey && TMDB_KEY) {
    if (!isPendingPickCreated(pickKey)) addPendingPickCreated(pickKey);
    // Save text first, then search + show choices
    saveData();
    startTmdbAutoPick(pickKey);
  } else {
    // No TMDB key: just save and make sure pending is cleared.
    if (pickKey) removePendingPickCreated(pickKey);
    saveData();
  }

  scheduleRender();
}

// ===== Init =====
async function init() {
  applyUrlSetup();
  setupFilterUI();
  updateViewedToggleUI();
  updateTagFilterBtnUI();
  updateSearchBtnUI();
  updateShareButton();
  updateTmdbBtnVisibility();
  updateSectionButton(); // also updates bottom + visibility

  if (!GIST_ID || !TOKEN) {
    $("viewMode").innerHTML = `<div class="setup-prompt">Откройте меню → Подключение</div>`;
    updateCounter(0);
    return;
  }

  await loadData();
  normalizeDataModel();
  if (!Object.keys(data.sections).length) {
    ["Фильмы", "Сериалы", "Аниме"].forEach(s => data.sections[s] = { items: [], modified: new Date().toISOString() });
  }
  renderSectionList();
  updateSectionButton();
  render();

  // Restore UI state (expanded description, selection, scroll, open menus)
  // IMPORTANT: description is rendered by render(), so we must set/validate keys BEFORE restoring scroll.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (document.body.classList.contains("editing")) return;

      const existingKeys = new Set(Array.from(document.querySelectorAll("#viewMode .item-line")).map(el => el.dataset.key));

      // Validate expanded description key by DATA (not by current visibility).
      // This allows keeping an opened description even if the item is temporarily hidden by filters.
      if (expandedDescKey) {
        const p = parseItemKey(expandedDescKey);
        const it = p ? data.sections?.[p.secKey]?.items?.[p.idx] : null;
        if (!it || !it.desc) {
          expandedDescKey = null;
          localStorage.removeItem("expanded_desc_key");
        }
      }

      // Validate selected key (selection is tied to the current visible list)
      if (selectedKey && !existingKeys.has(selectedKey)) {
        selectedKey = null;
        localStorage.removeItem("selected_key");
      }

      // Re-render once only if expanded description is currently visible (so the expanded DOM exists)
      if (expandedDescKey && existingKeys.has(expandedDescKey)) render();

      // Apply selected class without forcing re-render
      if (selectedKey) {
        document.querySelectorAll("#viewMode .item-line").forEach(el => {
          if (el.dataset.key === selectedKey) el.classList.add("selected");
        });
      }

      // Restore scroll ONLY after final DOM height is settled
      requestAnimationFrame(() => {
        const y = Number(localStorage.getItem("scroll_y") || "0");
        if (Number.isFinite(y) && y > 0) {
          window.scrollTo({ top: y, left: 0, behavior: "instant" });
        }
        restoringUI = false;
      });

      // restore sort menu open state
      if (sortMenuOpen && !isEditing) {
        updateSortMenuUI();
        openMenu("sortMenu", $("sortBtn"), "right");
      }
    });
  });
}

// Detect Apple devices (iOS, iPadOS, macOS Safari)
function isAppleDevice() {
  const ua = navigator.userAgent;
  // iOS/iPadOS
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh but has touch
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  // macOS Safari (Safari UA without Chrome/Chromium)
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return true;
  return false;
}

function applyUrlSetup() {
  const setup = new URLSearchParams(location.search).get("s");
  if (!setup) return;
  try {
    const parts = atob(setup).split(":");
    const [gist, token, tmdb] = parts;
    if (gist && token) {
      localStorage.setItem("gist_id", gist);
      localStorage.setItem("github_token", token);
      GIST_ID = gist; TOKEN = token;
      if (tmdb) { localStorage.setItem("tmdb_key", tmdb); TMDB_KEY = tmdb; }
      // For Apple devices: keep URL with ?s= parameter (localStorage is unreliable)
      // For other browsers: shorten URL
      if (!isAppleDevice()) {
        history.replaceState({}, "", location.pathname);
      }
    }
  } catch {}
}

function sanitizeSectionName(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function mergeSectionInto(targetKey, sourceKey) {
  if (!data.sections?.[sourceKey] || !data.sections?.[targetKey] || sourceKey === targetKey) return;
  const src = data.sections[sourceKey];
  const dst = data.sections[targetKey];

  // Merge items (keep order: existing target items first, then source)
  dst.items = [...(dst.items || []), ...(src.items || [])];
  dst.modified = new Date().toISOString();

  // If current section points to source, redirect
  if (currentSection === sourceKey) {
    currentSection = targetKey;
    localStorage.setItem("current_section", currentSection);
  }

  // Adjust selection/expanded keys if they were in source
  if (selectedKey) {
    const p = parseItemKey(selectedKey);
    if (p && p.secKey === sourceKey) {
      selectedKey = null;
      localStorage.removeItem("selected_key");
    }
  }
  if (expandedDescKey) {
    const p = parseItemKey(expandedDescKey);
    if (p && p.secKey === sourceKey) {
      expandedDescKey = null;
      localStorage.removeItem("expanded_desc_key");
    }
  }

  delete data.sections[sourceKey];
}

function commitSectionRename() {
  if (!sectionRename.active) return;
  const el = $("currentSectionName");
  const orig = sectionRename.orig;
  const nextRaw = sanitizeSectionName(el?.textContent);

  // End edit UI first
  sectionRename.active = false;
  el?.setAttribute("contenteditable", "false");

  // IMPORTANT: reset horizontal scroll so ellipsis mode shows the beginning of text
  // (otherwise long names can end up scrolled to the far right and look "empty")
  try { if (el) el.scrollLeft = 0; } catch {}

  const from = orig;
  const to = nextRaw || orig;

  // Restore visual (will be overwritten by updateSectionButton anyway)
  el.textContent = to;

  // No change
  if (!from || to === from) {
    updateSectionButton();
    return;
  }

  // If empty -> revert
  if (!to) {
    updateSectionButton();
    return;
  }

  // If target already exists -> merge
  if (data.sections[to] && data.sections[from]) {
    mergeSectionInto(to, from);
  } else if (data.sections[from]) {
    // Rename key
    data.sections[to] = data.sections[from];
    data.sections[to].modified = new Date().toISOString();
    delete data.sections[from];

    if (currentSection === from) {
      currentSection = to;
      localStorage.setItem("current_section", currentSection);
    }
  }

  saveData();
  renderSectionList();
  updateSectionButton();
  render();
}

function cancelSectionRename() {
  if (!sectionRename.active) return;
  const el = $("currentSectionName");
  el?.setAttribute("contenteditable", "false");
  sectionRename.active = false;

  // Reset horizontal scroll to avoid "empty" look after editing long names
  try { if (el) el.scrollLeft = 0; } catch {}

  updateSectionButton();
}

function beginSectionRename() {
  if (isEditing || savingInProgress) return;
  if (currentSection === "__all__") return;
  const el = $("currentSectionName");
  if (!el) return;

  // iOS Safari: prevent immediate outside-click commit/blur and let focus show keyboard without zoom.
  markIgnoreOutsideCommitOnce();

  // Close menus to avoid conflicts
  closeAllMenus();

  sectionRename.active = true;
  sectionRename.orig = currentSection;

  el.setAttribute("contenteditable", "true");
  ensureIosKeyboardFocus(el);

  // Place caret at the end (not select all)
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false); // collapse to end
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  // Scroll to end so caret is visible
  el.scrollLeft = el.scrollWidth;

  // Keep it strictly single-line like an address bar
  el.onbeforeinput = (ev) => {
    // Block insertion of line breaks
    if (ev?.inputType === "insertParagraph" || ev?.inputType === "insertLineBreak") {
      ev.preventDefault();
    }
  };

  el.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelSectionRename(); el.blur(); }
  };

  el.onblur = () => {
    el.onkeydown = null;
    el.onblur = null;
    el.onbeforeinput = null;
    commitSectionRename();
  };
}

// ===== Data model =====
function normalizeDataModel() {
  if (!data?.sections) data = { sections: {} };

  // Migrate legacy pending keys (stored as `created`) to stable item ids.
  const pending = loadPendingPickCreatedSet();
  let pendingChanged = false;
  let idsGenerated = false;

  for (const key of Object.keys(data.sections)) {
    let sec = data.sections[key];
    if (!sec || typeof sec !== "object") sec = { items: [], modified: new Date().toISOString() };
    if (!Array.isArray(sec.items)) sec.items = [];
    if (!sec.modified) sec.modified = new Date().toISOString();
    sec.items = sec.items.map(it => {
      if (it && typeof it === "object" && typeof it.text === "string") {
        if (!it.id) { it.id = genItemId(); idsGenerated = true; }
        it.tags = uniqueTags(it.tags);
        if (!it.created) it.created = sec.modified;

        // Migrate pending marker: if pending contains this legacy `created`, replace with stable `id`.
        const createdKey = String(it.created || "");
        const idKey = String(it.id || "");
        if (createdKey && idKey && pending.has(createdKey) && !pending.has(idKey)) {
          pending.delete(createdKey);
          pending.add(idKey);
          pendingChanged = true;
        }

        return it;
      }
      idsGenerated = true;
      const obj = { id: genItemId(), text: String(it ?? ""), tags: [], created: sec.modified };
      return obj;
    });
    data.sections[key] = sec;
  }

  if (pendingChanged) savePendingPickCreatedSet(pending);
  // Persist newly generated ids so they stay stable across reloads/devices.
  if (idsGenerated && TOKEN && GIST_ID) queueModelSave();
}

function uniqueTags(tags) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = normTag(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function normTag(t) { return String(t || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function isViewed(item) { return item?.tags?.includes(VIEWED_TAG); }

// Country codes mapping
const COUNTRY_CODES = {
  US: "США", GB: "Великобритания", KR: "Южная Корея", JP: "Япония", FR: "Франция", 
  DE: "Германия", IT: "Италия", ES: "Испания", CN: "Китай", IN: "Индия", RU: "Россия", 
  CA: "Канада", AU: "Австралия", BR: "Бразилия", MX: "Мексика", SE: "Швеция", 
  DK: "Дания", NO: "Норвегия", FI: "Финляндия", NL: "Нидерланды", BE: "Бельгия", 
  AT: "Австрия", CH: "Швейцария", PL: "Польша", CZ: "Чехия", TR: "Турция", 
  TH: "Таиланд", PH: "Филиппины", ID: "Индонезия", MY: "Малайзия", SG: "Сингапур", 
  HK: "Гонконг", TW: "Тайвань", NZ: "Новая Зеландия", AR: "Аргентина", CL: "Чили", 
  CO: "Колумбия", ZA: "ЮАР", EG: "Египет", IL: "Израиль", AE: "ОАЭ", 
  SA: "Саудовская Аравия", UA: "Украина", BY: "Беларусь", KZ: "Казахстан"
};
const COUNTRY_CODES_SET = new Set(Object.keys(COUNTRY_CODES).map(c => c.toLowerCase()));

// Anime detection: if we have animation-related genre + production country (JP/KR/CN)
// then replace animation tags with "аниме".
const ANIME_COUNTRIES = new Set(["jp", "kr", "cn"]);
const ANIME_SOURCE_TAGS = new Set(["анимация", "мультфильм", "мультсериал"]);

function normalizeAnimeTags(tags) {
  const arr = Array.isArray(tags) ? tags.map(normTag).filter(Boolean) : [];
  const hasAnim = arr.some(t => ANIME_SOURCE_TAGS.has(t));
  const hasCountry = arr.some(t => ANIME_COUNTRIES.has(t));
  if (hasAnim && hasCountry) {
    const filtered = arr.filter(t => !ANIME_SOURCE_TAGS.has(t));
    filtered.push("аниме");
    return uniqueTags(filtered);
  }
  return uniqueTags(arr);
}

let regionDisplayNames = null;
function isCountryTag(tag) {
  const t = normTag(tag);
  if (COUNTRY_CODES_SET.has(t)) return true;
  // Fallback: TMDB country tags are ISO 3166-1 alpha-2 codes stored in lowercase.
  return /^[a-z]{2}$/.test(t);
}
function countryDisplayName(code) {
  const raw = String(code || "").trim();
  if (!raw) return "";

  // Normalize common alias
  let iso = raw.toUpperCase();
  if (iso === "UK") iso = "GB";

  // Prefer our manual map
  if (COUNTRY_CODES[iso]) return COUNTRY_CODES[iso];

  // Fallback to Intl (gives localized names in most modern browsers)
  try {
    if (!regionDisplayNames && typeof Intl !== "undefined" && Intl.DisplayNames) {
      regionDisplayNames = new Intl.DisplayNames(["ru"], { type: "region" });
    }
    const name = regionDisplayNames?.of(iso);
    if (name && name !== iso) return name;
  } catch {}

  return iso;
}
function setViewed(item, v) {
  item.tags = uniqueTags(item.tags);
  const has = item.tags.includes(VIEWED_TAG);
  if (v && !has) item.tags.unshift(VIEWED_TAG);
  else if (!v && has) item.tags = item.tags.filter(t => t !== VIEWED_TAG);
}
function displayTags(item) { return (item?.tags || []).filter(t => t !== VIEWED_TAG); }

// ===== API =====
async function loadData() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: { Authorization: `token ${TOKEN}` } });
    if (!res.ok) throw new Error();
    const gist = await res.json();
    data = gist.files?.["contents.json"] ? JSON.parse(gist.files["contents.json"].content) : { sections: {} };
    if (!data.sections) data = { sections: {} };
  } catch { data = { sections: {} }; }
}

async function saveData() {
  if (!TOKEN || !GIST_ID) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: { "contents.json": { content: JSON.stringify(data, null, 2) } } })
    });
  } catch {}
}

// ===== TMDB API =====
const TMDB_BASE = "https://api.themoviedb.org/3";

async function loadTmdbGenres() {
  if (tmdbGenres) return tmdbGenres;
  if (!TMDB_KEY) return null;
  try {
    const [movieRes, tvRes] = await Promise.all([
      fetch(`${TMDB_BASE}/genre/movie/list?api_key=${TMDB_KEY}&language=ru`),
      fetch(`${TMDB_BASE}/genre/tv/list?api_key=${TMDB_KEY}&language=ru`)
    ]);
    const movieData = await movieRes.json();
    const tvData = await tvRes.json();
    tmdbGenres = new Map();
    for (const g of [...(movieData.genres || []), ...(tvData.genres || [])]) {
      tmdbGenres.set(g.id, g.name.toLowerCase());
    }
    return tmdbGenres;
  } catch { return null; }
}

function extractYearAndCleanTitle(s) {
  let t = String(s || "").trim();
  let year = null;

  // (2004)
  let m = t.match(/\((19\d{2}|20\d{2})\)/);
  if (m) {
    year = m[1];
    t = t.replace(m[0], " ");
  }

  // 2004 - Title / 2004. Title / 2004 Title
  if (!year) {
    m = t.match(/^\s*(19\d{2}|20\d{2})\s*[-–—.,:]?\s*(.+)$/);
    if (m) {
      year = m[1];
      t = m[2];
    }
  }

  // Title - 2004 / Title. 2004 / Title 2004
  if (!year) {
    m = t.match(/^(.+?)\s*[-–—.,:]?\s*(19\d{2}|20\d{2})\s*$/);
    if (m) {
      year = m[2];
      t = m[1];
    }
  }

  // Any standalone year token
  if (!year) {
    m = t.match(/\b(19\d{2}|20\d{2})\b/);
    if (m) {
      year = m[1];
      t = t.replace(m[0], " ");
    }
  }

  t = t.replace(/\s+/g, " ").trim();
  return { title: t, year };
}

function parseTitleForSearch(text) {
  const raw = String(text || "").trim();
  const parts = raw.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean);

  let year = null;
  const names = [];
  for (const p of (parts.length ? parts : [raw])) {
    const r = extractYearAndCleanTitle(p);
    if (!year && r.year) year = r.year;
    if (r.title) names.push(r.title);
  }

  // De-dup preserve order
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const k = n.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }

  return { names: out.length ? out : [raw], year };
}

function hideTmdbPick() {
  const el = $("tmdbPick");
  if (!el) return;
  el.classList.add("hidden");
  el.innerHTML = "";
}

function tmdbAltTitleForDisplay(c) {
  const ru = String(c?.titleRu || "").trim();
  const en = String(c?.titleEn || "").trim();
  const orig = String(c?.titleOrig || "").trim();

  const ruL = ru.toLowerCase();
  const enL = en.toLowerCase();
  const origL = orig.toLowerCase();

  // Prefer English title (if present and differs from RU), otherwise fallback to original title.
  if (en && enL !== ruL) return en;
  if (orig && origL !== ruL) return orig;
  return "";
}

// This is the exact title format we apply to the item on manual TMDB load.
function formatTmdbTitleForItem(c) {
  const ru = String(c?.titleRu || "").trim();
  const alt = tmdbAltTitleForDisplay(c);
  const y = c?.year ? String(c.year).trim() : "";

  let out = ru || alt || "";
  if (ru && alt) out = `${ru} / ${alt}`;
  if (y) out = `${out} (${y})`;
  return out.trim();
}

function formatTmdbCandidateLabel(c) {
  return formatTmdbTitleForItem(c);
}

function tmdbCandidateMetaText(c) {
  const parts = [];
  const type = c.mediaType === "movie" ? "Фильм" : "Сериал";
  if (type) parts.push(type);

  if (c.year) parts.push(String(c.year));

  const cc = c.countryCode ? String(c.countryCode) : "";
  if (cc) parts.push(countryDisplayName(cc));

  const r = Number(c.voteAverage);
  if (Number.isFinite(r) && r > 0) {
    const votes = formatVotes(c.voteCount);
    parts.push(votes ? `${r.toFixed(1)} (${votes})` : r.toFixed(1));
  }

  return parts.join(" · ");
}

async function hydrateTmdbCandidateCountry(c) {
  if (!c || c.__countryHydrated) return c;
  c.__countryHydrated = true;

  // TV: can come from search response
  if (c.mediaType === "tv" && Array.isArray(c.origin_country) && c.origin_country.length) {
    if (!c.countryCode) c.countryCode = String(c.origin_country[0]).toLowerCase();
    return c;
  }

  if (!TMDB_KEY) return c;
  try {
    // Use EN details: we can also take English title from here
    const res = await fetch(`${TMDB_BASE}/${c.mediaType}/${c.id}?api_key=${TMDB_KEY}&language=en-US`);
    const details = await res.json();

    // English title
    if (!c.titleEn) {
      c.titleEn = (c.mediaType === "movie") ? (details.title || null) : (details.name || null);
    }

    // Country code
    if (!c.countryCode) {
      let code = null;
      if (c.mediaType === "tv") {
        code = (Array.isArray(details.origin_country) && details.origin_country.length) ? details.origin_country[0] : null;
      } else {
        code = (Array.isArray(details.production_countries) && details.production_countries.length)
          ? details.production_countries[0].iso_3166_1
          : null;
      }
      if (code) c.countryCode = String(code).toLowerCase();
    }
  } catch {}

  return c;
}

function tmdbCandidateChipsHtml(c) {
  if (!c) return "";

  const chips = [];

  // Keep ordering identical to the main item list:
  // сериал → жанры (A-Я) → страны → рейтинг

  // Country code (stored lowercase)
  const cc = c.countryCode ? String(c.countryCode).toLowerCase() : "";

  // (1) TV marker first
  if (c.mediaType === "tv") {
    chips.push(`<span class="tag-chip serial">сериал</span>`);
  }

  // (2) Genre tags: normalize (incl. anime rules) and sort like in the item list
  const rawGenreNames = Array.isArray(c.genreNames) ? c.genreNames.map(x => String(x)) : [];
  const pool = [];
  for (const g of rawGenreNames) {
    const t = normTag(g);
    if (!t || t === "сериал") continue;
    pool.push(t);
  }
  if (cc) pool.push(cc);

  const normalized = normalizeAnimeTags(pool);

  const genreTags = normalized
    .filter(t => t && t !== "сериал" && !isCountryTag(t))
    .sort((a, b) => a.localeCompare(b, "ru"));

  for (const t of genreTags) {
    chips.push(`<span class="tag-chip">${esc(t)}</span>`);
  }

  // (3) Country last (before rating)
  if (cc) {
    chips.push(`<span class="tag-chip country">${esc(countryDisplayName(cc))}</span>`);
  }

  // (4) Rating at the end
  const r = Number(c.voteAverage);
  if (Number.isFinite(r) && r > 0) {
    const votesMeta = formatVotes(c.voteCount);
    const rColor = ratingColor(r);
    chips.push(
      `<span class="tag-chip rating" style="--rating-color:${esc(rColor)}"><span class="rating-val">${esc(r.toFixed(1))}</span>${votesMeta ? `<span class="rating-votes"> (${esc(votesMeta)})</span>` : ""}</span>`
    );
  }

  if (!chips.length) return "";
  return `<span class="item-tags">${chips.join("")}</span>`;
}

function showTmdbPick(candidates) {
  const wrap = $("tmdbPick");
  if (!wrap) return;
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="tmdb-pick-title">Найдено несколько совпадений</div>
    <div class="tmdb-pick-list" id="tmdbPickList"></div>
  `;
  const list = $("tmdbPickList");
  list.innerHTML = candidates.map((c, i) => {
    const label = formatTmdbCandidateLabel(c);
    const chips = tmdbCandidateChipsHtml(c);
    return `
      <button class="tmdb-pick-item" type="button" data-pick="${i}">
        <div class="tmdb-pick-label">${esc(label)}</div>
        ${chips ? `<div class="tmdb-pick-tags">${chips}</div>` : ""}
      </button>`;
  }).join("");

  list.querySelectorAll("[data-pick]").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.pick);
      const c = candidates[i];
      if (!c) return;
      await applyTmdbCandidateToCurrentItem(c);
    };
  });
}

// ===== TMDB auto-pick for newly created items (via "+") =====
// Per requirements: ALWAYS show choice list (even if only 1 match). Never auto-apply.
async function startTmdbAutoPick(pickKey) {
  const k = String(pickKey || "");
  if (!k) return;
  if (!TMDB_KEY) { removePendingPickCreated(k); tmdbAutoPick = null; scheduleRender(); return; }

  // Ensure it is actually pending; if not, don't open UI
  if (!isPendingPickCreated(k)) { tmdbAutoPick = null; scheduleRender(); return; }

  const found = findItemByPickKey(k);
  if (!found) { removePendingPickCreated(k); tmdbAutoPick = null; scheduleRender(); return; }

  const { secKey, idx, key } = found;
  const item = data.sections?.[secKey]?.items?.[idx];
  const title = String(item?.text || "").trim();

  if (!title) {
    // Empty title => no search; keep pending but no UI
    tmdbAutoPick = null;
    scheduleRender();
    return;
  }

  const reqId = ++tmdbAutoReqId;

  // Close expanded description (we use the same space under item)
  if (expandedDescKey === key) closeDescMenu();

  // Show loading state
  tmdbAutoPick = { pickKey: k, key, secKey, idx, query: title, candidates: [], loading: true };
  scheduleRender();

  try {
    const genresMap = await loadTmdbGenres();
    const { names, year } = parseTitleForSearch(title);

    const gather = async (name, y) => {
      const out = [];
      const movies = await searchTmdbMany(name, y, "movie", 8);
      for (const r of movies) {
        const y2 = r.release_date ? r.release_date.slice(0, 4) : null;
        out.push({
          id: r.id,
          mediaType: "movie",
          genre_ids: r.genre_ids,
          genreNames: (Array.isArray(r.genre_ids) && genresMap)
            ? r.genre_ids.map(id => genresMap.get(id)).filter(Boolean)
            : [],
          overview: r.overview || null,
          poster: r.poster_path ? TMDB_IMG + r.poster_path : null,
          titleRu: r.title || "",
          titleOrig: r.original_title || "",
          titleEn: null,
          year: y2,
          origin_country: r.origin_country || [],
          voteAverage: (typeof r.vote_average === "number") ? r.vote_average : null,
          voteCount: (typeof r.vote_count === "number") ? r.vote_count : null,
          countryCode: null
        });
      }
      const tvs = await searchTmdbMany(name, y, "tv", 8);
      for (const r of tvs) {
        const y2 = r.first_air_date ? r.first_air_date.slice(0, 4) : null;
        out.push({
          id: r.id,
          mediaType: "tv",
          genre_ids: r.genre_ids,
          genreNames: (Array.isArray(r.genre_ids) && genresMap)
            ? r.genre_ids.map(id => genresMap.get(id)).filter(Boolean)
            : [],
          overview: r.overview || null,
          poster: r.poster_path ? TMDB_IMG + r.poster_path : null,
          titleRu: r.name || "",
          titleOrig: r.original_name || "",
          titleEn: null,
          year: y2,
          origin_country: r.origin_country || [],
          voteAverage: (typeof r.vote_average === "number") ? r.vote_average : null,
          voteCount: (typeof r.vote_count === "number") ? r.vote_count : null,
          countryCode: (Array.isArray(r.origin_country) && r.origin_country.length) ? String(r.origin_country[0]).toLowerCase() : null
        });
      }
      return out;
    };

    let candidates = [];
    for (const n of names) candidates.push(...await gather(n, year));
    if (!candidates.length && year) {
      for (const n of names) candidates.push(...await gather(n, null));
    }

    // Dedupe preserving order
    const uniq = new Map();
    for (const cand of candidates) {
      const k = `${cand.mediaType}:${cand.id}`;
      if (!uniq.has(k)) uniq.set(k, cand);
    }
    candidates = [...uniq.values()];

    // Outdated request or state changed
    if (reqId !== tmdbAutoReqId) return;
    if (!tmdbAutoPick || tmdbAutoPick.pickKey !== k) return;

    if (!candidates.length) {
      // Nothing to choose => keep user's text and stop pending
      removePendingPickCreated(k);
      tmdbAutoPick = null;
      scheduleRender();
      return;
    }

    tmdbAutoPick = { ...tmdbAutoPick, candidates, loading: false };
    scheduleRender();

    // Hydrate countries + English titles in background, then re-render
    (async () => {
      try {
        await Promise.all(candidates.map(x => hydrateTmdbCandidateCountry(x)));
        if (reqId !== tmdbAutoReqId) return;
        if (!tmdbAutoPick || tmdbAutoPick.pickKey !== k) return;
        tmdbAutoPick = { ...tmdbAutoPick, candidates: [...candidates], loading: false };
        scheduleRender();
      } catch {}
    })();

  } catch {
    // On error: keep user's text and stop pending
    removePendingPickCreated(k);
    tmdbAutoPick = null;
    scheduleRender();
  }
}

async function applyTmdbCandidateToItemFromAutoPick(pickKey, c) {
  const k = String(pickKey || "");
  if (!k || !c || !TMDB_KEY) {
    if (k) removePendingPickCreated(k);
    tmdbAutoPick = null;
    scheduleRender();
    return;
  }

  const found = findItemByPickKey(k);
  if (!found) {
    removePendingPickCreated(k);
    tmdbAutoPick = null;
    scheduleRender();
    return;
  }

  const { secKey, idx, key } = found;
  const item = data.sections?.[secKey]?.items?.[idx];
  if (!item) {
    removePendingPickCreated(k);
    tmdbAutoPick = null;
    scheduleRender();
    return;
  }

  // ===== Apply FAST (immediate UX) =====
  // Close pick UI immediately and apply everything we already have from search response.
  // Then hydrate missing details in background (genres/country + TV meta) and save again.

  const wasViewed = isViewed(item);
  item.tags = wasViewed ? [VIEWED_TAG] : [];
  clearApiDataForItem(item, { keepTags: true });

  // Title: set exactly as in pick list (RU / EN-or-Orig (YYYY))
  item.text = formatTmdbTitleForItem(c) || (item.text || "");

  // Desc + poster (available from search)
  item.desc = c.overview || null;
  item.poster = c.poster || null;

  // Rating (available from search)
  item.rating = (typeof c.voteAverage === "number") ? c.voteAverage : null;
  item.votes = (typeof c.voteCount === "number") ? c.voteCount : null;

  // Type + year (available from search)
  item.tmdbType = c.mediaType || null;
  item.year = c.year ? String(c.year) : null;

  // Tags from search payload if present (no awaits)
  // (We still re-hydrate & normalize in background for correctness)
  try {
    const pool = [];
    if (Array.isArray(c.genreNames) && c.genreNames.length) pool.push(...c.genreNames.map(normTag));
    if (c.countryCode) pool.push(String(c.countryCode).toLowerCase());
    const normalized = normalizeAnimeTags(pool);
    const fresh = normalized.map(normTag).filter(t => t && t !== VIEWED_TAG);
    if (fresh.length) item.tags = uniqueTags([...(item.tags || []), ...fresh]);
  } catch {}

  // TV marker tag (based on mediaType)
  if (c.mediaType === "tv") {
    const hasSerialTag = (item.tags || []).some(t => normTag(t) === "сериал");
    if (!hasSerialTag) {
      const viewedIdx = (item.tags || []).indexOf(VIEWED_TAG);
      if (viewedIdx >= 0) item.tags.splice(viewedIdx + 1, 0, "сериал");
      else item.tags = ["сериал", ...(item.tags || [])];
      item.tags = uniqueTags(item.tags);
    }
  }

  data.sections[secKey].modified = new Date().toISOString();

  // Done: this item is no longer "new"
  removePendingPickCreated(k);

  // Close pick UI NOW
  if (tmdbAutoPick && tmdbAutoPick.pickKey === k) tmdbAutoPick = null;

  // Immediate UI update + save with current data
  selectedKey = key;
  localStorage.setItem("selected_key", selectedKey);
  render();
  saveData();

  // ===== Hydrate in background (details) =====
  (async () => {
    try {
      // Fetch RU details: country + TV meta
      let countryCode = c.countryCode ? String(c.countryCode).toLowerCase() : null;
      let tvMeta = { seasons: null, episodes: null, firstAirDate: null, lastAirDate: null, inProduction: null };

      const detailsRes = await fetch(`${TMDB_BASE}/${c.mediaType}/${c.id}?api_key=${TMDB_KEY}&language=ru`);
      const details = await detailsRes.json();

      if (c.mediaType === "tv") {
        if (Array.isArray(details.origin_country) && details.origin_country.length) countryCode = String(details.origin_country[0]).toLowerCase();
        else if (Array.isArray(c.origin_country) && c.origin_country.length) countryCode = String(c.origin_country[0]).toLowerCase();

        tvMeta = {
          seasons: Number.isFinite(Number(details.number_of_seasons)) ? Number(details.number_of_seasons) : null,
          episodes: Number.isFinite(Number(details.number_of_episodes)) ? Number(details.number_of_episodes) : null,
          firstAirDate: details.first_air_date || null,
          lastAirDate: details.last_air_date || null,
          inProduction: (typeof details.in_production === "boolean") ? details.in_production : null
        };

        item.seasons = tvMeta.seasons;
        item.episodes = tvMeta.episodes;
        item.firstAirDate = tvMeta.firstAirDate;
        item.lastAirDate = tvMeta.lastAirDate;
        item.inProduction = tvMeta.inProduction;

        if (!item.year && tvMeta.firstAirDate) item.year = String(tvMeta.firstAirDate).slice(0, 4);
      } else {
        if (Array.isArray(details.production_countries) && details.production_countries.length) {
          countryCode = String(details.production_countries[0].iso_3166_1).toLowerCase();
        }
      }

      // Rebuild tags from ids + country (authoritative)
      const genresMap2 = await loadTmdbGenres();
      const genreTagsRaw2 = (Array.isArray(c.genre_ids) ? c.genre_ids : [])
        .map(id => genresMap2?.get(id))
        .filter(Boolean);

      const pool2 = [...genreTagsRaw2];
      if (countryCode) pool2.push(countryCode);

      const normalized2 = normalizeAnimeTags(pool2);
      const fresh2 = normalized2.map(normTag).filter(t => t && t !== VIEWED_TAG);

      // Keep viewed + serial tag positions stable-ish
      const wasViewed2 = isViewed(item);
      const hasSerial = (item.tags || []).some(t => normTag(t) === "сериал");
      const prefix = [];
      if (wasViewed2) prefix.push(VIEWED_TAG);
      if (hasSerial) prefix.push("сериал");

      item.tags = uniqueTags([ ...prefix, ...fresh2 ]);

      data.sections[secKey].modified = new Date().toISOString();
      await saveData();
      scheduleRender();
    } catch {
      // ignore
    }
  })();
}

async function searchTmdb(query, year, type) {
  if (!TMDB_KEY) return null;
  const params = new URLSearchParams({ api_key: TMDB_KEY, query, language: "ru" });
  if (year) {
    params.set(type === "movie" ? "year" : "first_air_date_year", year);
  }
  try {
    const res = await fetch(`${TMDB_BASE}/search/${type}?${params}`);
    const json = await res.json();
    const result = json.results?.[0];
    if (!result) return null;

    // Получаем детали (страна + метаданные для сериалов)
    try {
      const detailsRes = await fetch(`${TMDB_BASE}/${type}/${result.id}?api_key=${TMDB_KEY}&language=ru`);
      const details = await detailsRes.json();

      // Keep minimal details payload for later formatting (seasons/episodes/year range)
      result.__details = {
        number_of_seasons: details.number_of_seasons,
        number_of_episodes: details.number_of_episodes,
        first_air_date: details.first_air_date,
        last_air_date: details.last_air_date,
        in_production: details.in_production,
        status: details.status,
        production_countries: details.production_countries,
        origin_country: details.origin_country
      };

      result.production_countries = details.production_countries || [];
      result.origin_country = details.origin_country || [];
    } catch {}

    return result;
  } catch { return null; }
}

async function searchTmdbMany(query, year, type, limit = 6) {
  if (!TMDB_KEY) return [];
  const params = new URLSearchParams({ api_key: TMDB_KEY, query, language: "ru" });
  if (year) {
    params.set(type === "movie" ? "year" : "first_air_date_year", year);
  }
  try {
    const res = await fetch(`${TMDB_BASE}/search/${type}?${params}`);
    const json = await res.json();
    const arr = Array.isArray(json.results) ? json.results : [];
    return arr.slice(0, limit);
  } catch { return []; }
}

const TMDB_IMG = "https://image.tmdb.org/t/p/w300";

async function fetchTmdbDataForItem(text) {
  const genres = await loadTmdbGenres();
  if (!genres) return {
    genres: [], overview: null, poster: null, originalTitle: null,
    year: null, rating: null, votes: null, tmdbType: null,
    seasons: null, episodes: null, firstAirDate: null, lastAirDate: null, inProduction: null
  };
  
  const { names, year } = parseTitleForSearch(text);
  
  const trySearch = async (name, y) => {
    let result = await searchTmdb(name, y, "movie");
    if (result?.genre_ids?.length) return { ...result, mediaType: "movie" };
    result = await searchTmdb(name, y, "tv");
    if (result?.genre_ids?.length) return { ...result, mediaType: "tv" };
    return null;
  };
  
  const extractData = (result) => {
    const isMovie = result.mediaType === "movie";
    const origTitle = isMovie ? result.original_title : result.original_name;
    const releaseDate = isMovie ? result.release_date : result.first_air_date;
    const resultYear = releaseDate ? releaseDate.substring(0, 4) : null;

    const genreListRaw = result.genre_ids.map(id => genres.get(id)).filter(Boolean);

    // Извлекаем код страны (US, KR, JP и т.д.) — храним как код
    let countryCode = null;
    if (result.origin_country?.length) {
      countryCode = result.origin_country[0];
    } else if (result.production_countries?.length) {
      // Попробуем найти код по названию
      const countryName = result.production_countries[0].name?.toLowerCase();
      for (const [code, name] of Object.entries(COUNTRY_CODES)) {
        if (name.toLowerCase() === countryName) { countryCode = code; break; }
      }
    }

    // Добавляем код страны в теги (в нижнем регистре)
    const genreListWithCountry = [...genreListRaw];
    if (countryCode && !genreListWithCountry.includes(countryCode.toLowerCase())) {
      genreListWithCountry.push(countryCode.toLowerCase());
    }

    // Normalize anime tags (only for data loaded from TMDB)
    const normalizedGenreTags = normalizeAnimeTags(genreListWithCountry);

    // Extra series meta (from details, if available)
    const d = result.__details || null;
    const seasons = (d && Number.isFinite(Number(d.number_of_seasons))) ? Number(d.number_of_seasons) : null;
    const episodes = (d && Number.isFinite(Number(d.number_of_episodes))) ? Number(d.number_of_episodes) : null;
    const firstAirDate = d?.first_air_date || null;
    const lastAirDate = d?.last_air_date || null;
    const inProduction = (typeof d?.in_production === "boolean") ? d.in_production : null;

    return {
      genres: normalizedGenreTags,
      overview: result.overview || null,
      poster: result.poster_path ? TMDB_IMG + result.poster_path : null,
      originalTitle: origTitle || null,
      year: resultYear,
      rating: (typeof result.vote_average === "number") ? result.vote_average : null,
      votes: (typeof result.vote_count === "number") ? result.vote_count : null,
      tmdbType: result.mediaType || null,
      seasons,
      episodes,
      firstAirDate,
      lastAirDate,
      inProduction
    };
  };
  
  for (const name of names) {
    const result = await trySearch(name, year);
    if (result) return extractData(result);
  }
  
  if (year) {
    for (const name of names) {
      const result = await trySearch(name, null);
      if (result) return extractData(result);
    }
  }
  
  return {
    genres: [], overview: null, poster: null, originalTitle: null,
    year: null, rating: null, votes: null, tmdbType: null,
    seasons: null, episodes: null, firstAirDate: null, lastAirDate: null, inProduction: null
  };
}

async function applyTmdbCandidateToCurrentItem(c) {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;

  const genresMap = await loadTmdbGenres();
  if (!genresMap) return;

  // Fetch details: country code + (for TV) seasons/episodes + air dates
  let countryCode = null;
  let tvMeta = { seasons: null, episodes: null, firstAirDate: null, lastAirDate: null, inProduction: null };

  try {
    const detailsRes = await fetch(`${TMDB_BASE}/${c.mediaType}/${c.id}?api_key=${TMDB_KEY}&language=ru`);
    const details = await detailsRes.json();

    if (c.mediaType === "tv") {
      if (Array.isArray(details.origin_country) && details.origin_country.length) countryCode = details.origin_country[0];
      else if (Array.isArray(c.origin_country) && c.origin_country.length) countryCode = c.origin_country[0];

      tvMeta = {
        seasons: Number.isFinite(Number(details.number_of_seasons)) ? Number(details.number_of_seasons) : null,
        episodes: Number.isFinite(Number(details.number_of_episodes)) ? Number(details.number_of_episodes) : null,
        firstAirDate: details.first_air_date || null,
        lastAirDate: details.last_air_date || null,
        inProduction: (typeof details.in_production === "boolean") ? details.in_production : null
      };

    } else {
      // movie
      if (Array.isArray(details.production_countries) && details.production_countries.length) {
        countryCode = details.production_countries[0].iso_3166_1;
      }
    }
  } catch {}

  // ===== Requirement: manual TMDB apply should overwrite/clear previous data полностью =====
  // Clear ALL previous TMDB/API loaded fields AND tags (keep __viewed__ only).
  const wasViewed = isViewed(item);
  item.tags = wasViewed ? [VIEWED_TAG] : [];
  clearApiDataForItem(item, { keepTags: true });

  const genreTagsRaw = (Array.isArray(c.genre_ids) ? c.genre_ids : [])
    .map(id => genresMap.get(id))
    .filter(Boolean);

  // Add country tag as code (lowercase)
  const tagPool = [...genreTagsRaw];
  if (countryCode) tagPool.push(String(countryCode).toLowerCase());

  // Normalize anime tags for anything applied from TMDB
  const genreTags = normalizeAnimeTags(tagPool);

  // Title normalize/additions (orig + year)
  const nextTitle = buildTitleUpdate(item.text, c.titleOrig, c.year);
  if (nextTitle) item.text = nextTitle;

  // Tags (fresh)
  const freshTags = genreTags.map(normTag).filter(t => t && t !== VIEWED_TAG);
  item.tags = uniqueTags([...(item.tags || []), ...freshTags]);

  // Desc + poster (overwrite)
  item.desc = c.overview || null;
  item.poster = c.poster || null;

  // Rating (overwrite)
  item.rating = (typeof c.voteAverage === "number") ? c.voteAverage : null;
  item.votes = (typeof c.voteCount === "number") ? c.voteCount : null;

  // Type + year (overwrite)
  item.tmdbType = c.mediaType || null;
  item.year = c.year ? String(c.year) : null;

  // TV meta (overwrite)
  if (c.mediaType === "tv") {
    item.seasons = tvMeta.seasons;
    item.episodes = tvMeta.episodes;
    item.firstAirDate = tvMeta.firstAirDate;
    item.lastAirDate = tvMeta.lastAirDate;
    item.inProduction = tvMeta.inProduction;

    // If year is missing, try to derive from first_air_date
    if (!item.year && tvMeta.firstAirDate) item.year = String(tvMeta.firstAirDate).slice(0, 4);

    // Add "сериал" tag for TV shows
    const hasSerialTag = (item.tags || []).some(t => normTag(t) === "сериал");
    if (!hasSerialTag) {
      const viewedIdx = (item.tags || []).indexOf(VIEWED_TAG);
      if (viewedIdx >= 0) item.tags.splice(viewedIdx + 1, 0, "сериал");
      else item.tags = ["сериал", ...(item.tags || [])];
      item.tags = uniqueTags(item.tags);
    }
  } else {
    // Not TV => clear TV meta explicitly
    item.seasons = null;
    item.episodes = null;
    item.firstAirDate = null;
    item.lastAirDate = null;
    item.inProduction = null;
  }

  data.sections[tagEditorCtx.secKey].modified = new Date().toISOString();
  await saveData();
  render();
  renderTagEditorList();
  renderTagFilterMenu();

  tmdbPickState = null;
  hideTmdbPick();
}

async function fetchTmdbTags() {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  if (!TMDB_KEY) { alert("TMDB API Key не задан. Добавьте его в настройках подключения."); return; }

  // Requirement: remove pick-preview inside tag editor.
  // Instead, close tag editor and open the same "TMDB выбрать" flow under the item in the main list.
  const { secKey, idx } = tagEditorCtx;
  const pickKey = ensureItemHasId(item) || "";

  closeTagEditor();

  if (!pickKey) return;

  // Mark pending so it behaves as "new" until user chooses or "не загружать данные"
  addPendingPickCreated(pickKey);

  // Ensure the item is selected in the main list
  selectedKey = `${secKey}|${idx}`;
  localStorage.setItem("selected_key", selectedKey);

  // Start (or restart) the pick flow
  startTmdbAutoPick(pickKey);
}

// Нормализует название: приводит год к виду (YYYY) и при необходимости добавляет / Original Title
function buildTitleUpdate(text, originalTitle, tmdbYear) {
  const raw = String(text || "").trim();
  const parts = raw.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean);

  let yearInText = null;
  const cleanedParts = [];

  for (const p of (parts.length ? parts : [raw])) {
    const r = extractYearAndCleanTitle(p);
    if (!yearInText && r.year) yearInText = r.year;
    if (r.title) cleanedParts.push(r.title);
  }

  let out = cleanedParts.join(" / ").replace(/\s+/g, " ").trim();

  // Decide year to show: prefer year already present in text, else TMDB year
  const y = yearInText || (tmdbYear ? String(tmdbYear) : null);
  if (y) {
    // Ensure year is only once and always as (YYYY)
    out = out.replace(/\s*\((19\d{2}|20\d{2})\)\s*$/g, "").trim();
    out = `${out} (${y})`;
  }

  // Add original title if we have only one title part and it's not already bilingual
  // and original looks Latin while current looks non-Latin.
  if (originalTitle) {
    const hasSlash = out.includes("/");
    if (!hasSlash) {
      const cur = out.replace(/\s*\((19\d{2}|20\d{2})\)\s*$/g, "").trim();
      const orig = String(originalTitle).trim();
      const isLatin = /^[A-Za-z]/.test(orig);
      const curIsLatin = /^[A-Za-z]/.test(cur);
      if (isLatin && !curIsLatin && orig.toLowerCase() !== cur.toLowerCase()) {
        out = out.replace(/\s*\((19\d{2}|20\d{2})\)\s*$/g, "").trim();
        out = `${out} / ${orig}`;
        if (y) out = `${out} (${y})`;
      }
    }
  }

  return out && out !== raw ? out : null;
}

function formatVotes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + "k";
  return String(v);
}

function ruPlural(n, one, few, many) {
  const x = Math.abs(Number(n));
  if (!Number.isFinite(x)) return many;
  const mod10 = x % 10;
  const mod100 = x % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function formatTvYearRange(item) {
  const start = (item?.firstAirDate || "").slice(0, 4);
  const end = (item?.lastAirDate || "").slice(0, 4);
  const inProd = (typeof item?.inProduction === "boolean") ? item.inProduction : null;

  if (start) {
    if (inProd) return `${start}–…`;
    if (end && end !== start) return `${start}–${end}`;
    return start;
  }

  // Fallback to stored year if any
  const y = String(item?.year || "").trim();
  return y || "";
}

function updateTmdbBtnVisibility() {
  const btn = $("tmdbBtn");
  if (btn) btn.style.display = TMDB_KEY ? "grid" : "none";
  if (!TMDB_KEY) { tmdbPickState = null; hideTmdbPick(); }
}

function cycleTmdbMode() {
  if (!TMDB_KEY) {
    alert("TMDB API Key не задан. Добавьте его в настройках подключения.");
    return;
  }
  // Порядок: new → all → clear → off → new
  tmdbMode = tmdbMode === "new" ? "all" : tmdbMode === "all" ? "clear" : tmdbMode === "clear" ? "off" : "new";
  localStorage.setItem("tmdb_mode", tmdbMode);
  updateTmdbModeBtn();
}

function updateTmdbModeBtn() {
  const btn = $("tmdbModeBtn");
  if (!btn) return;
  btn.classList.remove("mode-off", "mode-new", "mode-all", "mode-clear");
  if (!TMDB_KEY) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "grid";
  if (tmdbMode === "new") btn.classList.add("mode-new");
  else if (tmdbMode === "all") btn.classList.add("mode-all");
  else if (tmdbMode === "clear") btn.classList.add("mode-clear");
  else btn.classList.add("mode-off");
}

// ===== Progress bar =====
function showProgress(text, percent) {
  const bar = $("progressBar"), fill = $("progressFill"), txt = $("progressText");
  bar.classList.remove("hidden");
  fill.style.width = percent + "%";
  txt.textContent = text;
}

function hideProgress() {
  $("progressBar").classList.add("hidden");
  $("progressFill").style.width = "0%";
}

// ===== Filter (text) =====
function setupFilterUI() {
  const input = $("filterInput"), clear = $("filterClear");
  const mInput = $("mobileFilterInput"), mClear = $("mobileFilterClear");
  input.value = mInput.value = filterQuery;
  clear.classList.toggle("hidden", !filterQuery);
  mClear.classList.toggle("hidden", !filterQuery);

  const handle = (v) => {
    if (isEditing) return;
    filterQuery = v || "";
    localStorage.setItem("filter_query", filterQuery);
    input.value = mInput.value = filterQuery;
    clear.classList.toggle("hidden", !filterQuery);
    mClear.classList.toggle("hidden", !filterQuery);
    updateSearchBtnUI();

    // On filter change: reset scroll (but do not affect initial load restoration)
    localStorage.setItem("scroll_y", "0");
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });

    selectedKey = null; disarmItemDelete(); closeTagEditor(); render();
  };
  input.oninput = () => handle(input.value);
  mInput.oninput = () => handle(mInput.value);
  input.onkeydown = mInput.onkeydown = (e) => { if (e.key === "Escape") { clearFilter(); e.target.blur(); } };
}

function clearFilter() {
  if (isEditing) return;
  filterQuery = "";
  localStorage.setItem("filter_query", "");
  $("filterInput").value = $("mobileFilterInput").value = "";
  $("filterClear").classList.add("hidden");
  $("mobileFilterClear").classList.add("hidden");
  updateSearchBtnUI();

  // reset scroll on filter change
  localStorage.setItem("scroll_y", "0");
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });

  selectedKey = null; disarmItemDelete(); closeTagEditor(); render();
}

function setFilterLock(locked) {
  $("filterInput").disabled = $("mobileFilterInput").disabled = locked;
  if (locked) { $("filterClear").classList.add("hidden"); $("mobileFilterClear").classList.add("hidden"); }
  else {
    $("filterClear").classList.toggle("hidden", !filterQuery);
    $("mobileFilterClear").classList.toggle("hidden", !filterQuery);
  }
}

function updateSearchBtnUI() {
  const hasFilter = filterQuery.trim().length > 0;
  $("searchToggleBtn").classList.toggle("on", mobileSearchOpen || hasFilter);
}

function toggleMobileSearch() {
  mobileSearchOpen = !mobileSearchOpen;
  $("mobileSearchRow").classList.toggle("hidden", !mobileSearchOpen);
  updateSearchBtnUI();
  if (mobileSearchOpen) { $("mobileFilterInput").value = filterQuery; $("mobileFilterInput").focus(); }
}

// ===== Tag filter =====
function loadTagFilter() {
  try {
    const arr = JSON.parse(localStorage.getItem("tag_filter") || "[]");
    return new Set(arr.map(normTag).filter(t => t && t !== VIEWED_TAG));
  } catch { return new Set(); }
}
function loadTagFilterExcluded() {
  try {
    const arr = JSON.parse(localStorage.getItem("tag_filter_excluded") || "[]");
    return new Set(arr.map(normTag).filter(t => t && t !== VIEWED_TAG));
  } catch { return new Set(); }
}
function saveTagFilter() {
  localStorage.setItem("tag_filter", JSON.stringify([...tagFilter]));
  localStorage.setItem("tag_filter_excluded", JSON.stringify([...tagFilterExcluded]));
}

function loadRatingFilter() {
  const v = Number(localStorage.getItem("rating_filter") || "0");
  return Number.isFinite(v) && v > 0 ? v : null;
}
function saveRatingFilter() {
  if (ratingFilter == null) localStorage.removeItem("rating_filter");
  else localStorage.setItem("rating_filter", String(ratingFilter));
}

function updateTagFilterBtnUI() {
  $("tagFilterBtn")?.classList.toggle("on", tagFilter.size > 0 || tagFilterExcluded.size > 0 || ratingFilter != null);
}

function toggleTagFilterMenu() {
  if (isEditing) return;
  const menu = $("tagFilterMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  renderTagFilterMenu();
  renderRatingFilterMenu();
  openMenu("tagFilterMenu", $("tagFilterBtn"), "right");
}

function renderTagFilterMenu() {
  const list = $("tagFilterList"), hint = $("tagFilterHint");
  const counts = new Map();
  // Collect tags only from current section (or all sections if "__all__")
  const sectionKeys = currentSection === "__all__" ? Object.keys(data.sections) : [currentSection];
  for (const secKey of sectionKeys) {
    const sec = data.sections[secKey];
    if (!sec) continue;
    for (const it of sec.items || []) {
      for (const t of displayTags(it)) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const tags = [...counts.keys()].sort((a, b) => {
    // "сериал" always first
    const aS = normTag(a) === "сериал", bS = normTag(b) === "сериал";
    if (aS !== bS) return aS ? -1 : 1;
    // countries last
    const aC = isCountryTag(a), bC = isCountryTag(b);
    if (aC !== bC) return aC ? 1 : -1;
    const aN = isCountryTag(a) ? countryDisplayName(a) : a;
    const bN = isCountryTag(b) ? countryDisplayName(b) : b;
    return aN.localeCompare(bN, "ru");
  });
  if (!tags.length) { list.innerHTML = `<div class="tag-empty">Тегов нет</div>`; hint.textContent = ""; return; }

  list.innerHTML = tags.map(t => {
    const displayName = isCountryTag(t) ? countryDisplayName(t) : t;
    const isIncluded = tagFilter.has(t);
    const isExcluded = tagFilterExcluded.has(t);
    const stateClass = isExcluded ? "excluded" : (isIncluded ? "on" : "");
    const iconId = isExcluded ? "i-x" : "i-check";
    return `
    <div class="tag-option ${stateClass}" data-tag="${esc(t)}">
      <span class="tag-check"><svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#${iconId}"></use></svg></span>
      <span class="tag-name">${esc(displayName)}</span>
      <span class="tag-count">${counts.get(t)}</span>
    </div>`;
  }).join("");

  list.querySelectorAll(".tag-option").forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); toggleTagFilterItem(el.dataset.tag); };
  });

  const parts = [];
  if (tagFilter.size) parts.push(`Вкл: ${tagFilter.size}`);
  if (tagFilterExcluded.size) parts.push(`Искл: ${tagFilterExcluded.size}`);
  if (ratingFilter != null) parts.push(`Рейтинг ≥ ${ratingFilter}`);
  hint.textContent = parts.join(" · ");
}

function renderRatingFilterMenu() {
  const wrap = $("ratingFilterList");
  if (!wrap) return;
  const values = [2,3,4,5,6,7,8,9];
  wrap.innerHTML = values.map(v => {
    const on = ratingFilter === v;
    return `<button class="rating-btn ${on ? "on" : ""}" type="button" data-rating="${v}">≥${v}</button>`;
  }).join("");

  wrap.querySelectorAll("[data-rating]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const v = Number(btn.dataset.rating);
      ratingFilter = (ratingFilter === v) ? null : v;
      saveRatingFilter();
      updateTagFilterBtnUI();

      // reset scroll on filter change
      localStorage.setItem("scroll_y", "0");
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });

      selectedKey = null; disarmItemDelete(); closeTagEditor();
      renderTagFilterMenu();
      renderRatingFilterMenu();
      render();
    };
  });
}

function toggleTagFilterItem(tag) {
  const t = normTag(tag);
  if (!t || t === VIEWED_TAG) return;
  
  // Cycle: off → on → excluded → off
  const isIncluded = tagFilter.has(t);
  const isExcluded = tagFilterExcluded.has(t);
  
  if (!isIncluded && !isExcluded) {
    // off → on
    tagFilter.add(t);
  } else if (isIncluded && !isExcluded) {
    // on → excluded
    tagFilter.delete(t);
    tagFilterExcluded.add(t);
  } else {
    // excluded → off
    tagFilterExcluded.delete(t);
  }
  
  saveTagFilter(); updateTagFilterBtnUI();

  // reset scroll on filter change
  localStorage.setItem("scroll_y", "0");
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });

  selectedKey = null; disarmItemDelete(); closeTagEditor();
  renderTagFilterMenu(); render();
}

function clearTagFilter() {
  tagFilter = new Set();
  tagFilterExcluded = new Set();
  ratingFilter = null;
  saveTagFilter();
  saveRatingFilter();
  updateTagFilterBtnUI();

  // reset scroll on filter change
  localStorage.setItem("scroll_y", "0");
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });

  selectedKey = null; disarmItemDelete(); closeTagEditor();
  renderTagFilterMenu();
  renderRatingFilterMenu();
  render();
}

// ===== Tag editor =====
function openTagEditor(secKey, idx, anchor) {
  if (isEditing) return;
  const sec = data.sections[secKey];
  if (!sec?.items?.[idx]) return;

  // По требованию: при открытии редактора тегов закрываем раскрытое описание
  if (expandedDescKey) closeDescMenu();

  tagEditorCtx = { secKey, idx };
  tmdbPickState = null;
  hideTmdbPick();

  $("tagEditorTitle").textContent = `Теги`;
  $("tagAddInput").value = "";
  updateTmdbBtnVisibility();
  renderTagEditorList();
  openMenu("tagEditorMenu", anchor, "right");
  $("tagAddInput").focus();
}

function closeTagEditor() {
  tagEditorCtx = null;
  tmdbPickState = null;
  hideTmdbPick();
  $("tagEditorMenu").classList.add("hidden");
}

function getEditorItem() {
  if (!tagEditorCtx) return null;
  return data.sections?.[tagEditorCtx.secKey]?.items?.[tagEditorCtx.idx];
}

function renderTagEditorList() {
  const list = $("tagEditorList"), item = getEditorItem();
  if (!item) { list.innerHTML = ""; return; }
  const tags = displayTags(item).sort((a, b) => {
    const aC = isCountryTag(a), bC = isCountryTag(b);
    if (aC !== bC) return aC ? 1 : -1; // страны внизу
    const aN = isCountryTag(a) ? countryDisplayName(a) : a;
    const bN = isCountryTag(b) ? countryDisplayName(b) : b;
    return aN.localeCompare(bN, "ru");
  });
  if (!tags.length) { list.innerHTML = `<div class="tag-empty">Нет тегов</div>`; return; }

  list.innerHTML = tags.map(t => {
    const displayName = isCountryTag(t) ? countryDisplayName(t) : t;
    return `
    <div class="tag-pill">
      <input type="text" class="tag-pill-text" value="${esc(displayName)}" data-tag="${esc(t)}" />
      <button class="mini-btn danger" data-rm="${esc(t)}">×</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".tag-pill-text").forEach(inp => {
    inp.onblur = () => renameTag(inp);
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } else if (e.key === "Escape") { inp.value = inp.dataset.tag; inp.blur(); } };
  });
  list.querySelectorAll("[data-rm]").forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); removeTagWithUndo(btn.dataset.rm); };
  });
}

function renameTag(inp) {
  const oldT = normTag(inp.dataset.tag), newT = normTag(inp.value);
  // При отображении стран используем русское имя, но храним код. Редактирование страны запрещаем.
  if (isCountryTag(oldT)) { inp.value = countryDisplayName(oldT); return; }
  if (!oldT || !newT || oldT === newT || oldT === VIEWED_TAG || newT === VIEWED_TAG) { inp.value = oldT; return; }
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  const tags = uniqueTags(item.tags), i = tags.indexOf(oldT);
  if (i === -1) return;
  tags.includes(newT) ? tags.splice(i, 1) : (tags[i] = newT);
  item.tags = uniqueTags(tags);
  data.sections[tagEditorCtx.secKey].modified = new Date().toISOString();
  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
}

function handleTagAdd(e) { if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); } else if (e.key === "Escape") closeTagEditor(); }

function addTagFromInput() {
  const inp = $("tagAddInput"), t = normTag(inp.value);
  if (!t || t === VIEWED_TAG) return;
  inp.value = "";
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  item.tags = uniqueTags([...(item.tags || []), t]);
  data.sections[tagEditorCtx.secKey].modified = new Date().toISOString();
  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
}

function clearApiDataForItem(item, { keepTags = true } = {}) {
  if (!item) return;
  // Clear anything that could be loaded from TMDB/API
  item.desc = null;
  item.poster = null;
  item.rating = null;
  item.votes = null;
  item.tmdbType = null;
  item.year = null;

  // Series meta (TMDB TV details)
  item.seasons = null;
  item.episodes = null;
  item.firstAirDate = null;
  item.lastAirDate = null;
  item.inProduction = null;

  // Keep tags by default (only tag manipulation is requested here)
  if (!keepTags) {
    const wasViewed = isViewed(item);
    item.tags = wasViewed ? [VIEWED_TAG] : [];
  }
}

function removeTagWithUndo(tag) {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  const t = normTag(tag);
  if (!t || t === VIEWED_TAG) return;

  // Per requirement: removing tags from tag editor should also clear API-loaded fields
  const oldItem = JSON.parse(JSON.stringify(item));

  item.tags = uniqueTags(item.tags.filter(x => normTag(x) !== t));
  clearApiDataForItem(item, { keepTags: true });

  const { secKey, idx } = tagEditorCtx;
  data.sections[secKey].modified = new Date().toISOString();

  // Close expanded description if it was open for this item (since desc is cleared)
  const key = `${secKey}|${idx}`;
  if (expandedDescKey === key) closeDescMenu();

  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
  startUndo({ type: "itemRestore", secKey, idx, oldItem }, `Тег удалён: ${t}`);
}

function clearTagsForCurrentItem() {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;

  // Per requirement: clearing tags should also clear API-loaded fields
  const oldItem = JSON.parse(JSON.stringify(item));

  const wasViewed = isViewed(item);
  item.tags = wasViewed ? [VIEWED_TAG] : [];
  clearApiDataForItem(item, { keepTags: true });

  const { secKey, idx } = tagEditorCtx;
  data.sections[secKey].modified = new Date().toISOString();

  const key = `${secKey}|${idx}`;
  if (expandedDescKey === key) closeDescMenu();

  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
  startUndo({ type: "itemRestore", secKey, idx, oldItem }, "Теги очищены");
}

// ===== Description inline expand =====
function toggleDescExpand(secKey, idx) {
  const key = `${secKey}|${idx}`;
  expandedDescKey = (expandedDescKey === key) ? null : key;
  if (expandedDescKey) localStorage.setItem("expanded_desc_key", expandedDescKey);
  else localStorage.removeItem("expanded_desc_key");
  render();
}

function closeDescMenu() { 
  expandedDescKey = null;
  localStorage.removeItem("expanded_desc_key");
}

function clearDescForItem(secKey, idx) {
  const item = data.sections?.[secKey]?.items?.[idx];
  if (!item) return;
  
  const oldDesc = item.desc;
  const oldPoster = item.poster;
  if (!oldDesc && !oldPoster) return;
  
  item.desc = null;
  item.poster = null;
  data.sections[secKey].modified = new Date().toISOString();
  
  expandedDescKey = null;
  saveData();
  render();
  
  startUndo({ type: "desc", secKey, idx, oldDesc, oldPoster }, "Описание удалено");
}

// ===== Viewed toggle =====
function updateViewedToggleUI() {
  const btn = $("viewedToggleBtn"), use = $("viewedToggleUse");
  btn.classList.remove("state-show", "state-only");
  if (viewedFilter === "hide") use.setAttribute("href", `${ICONS}#i-eye-off`);
  else if (viewedFilter === "show") { btn.classList.add("state-show"); use.setAttribute("href", `${ICONS}#i-eye`); }
  else { btn.classList.add("state-only"); use.setAttribute("href", `${ICONS}#i-eye`); }
}

function cycleViewedFilter() {
  if (isEditing) return;
  viewedFilter = viewedFilter === "hide" ? "show" : viewedFilter === "show" ? "only" : "hide";
  localStorage.setItem("viewed_filter", viewedFilter);
  selectedKey = null; disarmItemDelete(); closeTagEditor();
  updateViewedToggleUI(); render();
}

// ===== Menu =====
function openMenu(menuId, anchor, align = "left") {
  closeAllMenus(menuId);
  const menu = $(menuId);
  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";

  // Tag editor should move with content → position:absolute relative to .container
  if (menuId === "tagEditorMenu") {
    const container = $("container");
    const cR = container.getBoundingClientRect();
    const aR = anchor.getBoundingClientRect();
    const mR = menu.getBoundingClientRect();

    const top = (aR.bottom - cR.top) + 8;
    let left = align === "right" ? (aR.right - cR.left - mR.width) : (aR.left - cR.left);

    // clamp inside container width
    left = Math.max(8, Math.min(left, cR.width - mR.width - 8));

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = "visible";
    return;
  }

  // Other menus are fixed to viewport
  const aR = anchor.getBoundingClientRect();
  const mR = menu.getBoundingClientRect();

  const top = aR.bottom + 8;
  let left = align === "right" ? (aR.right - mR.width) : aR.left;

  // clamp inside viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  left = Math.max(8, Math.min(left, vw - mR.width - 8));
  const maxTop = vh - mR.height - 8;
  const clampedTop = Math.max(8, Math.min(top, maxTop));

  menu.style.top = `${clampedTop}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = "visible";
}

function closeAllMenus(except) {
  ["sortMenu", "sectionMenu", "tagFilterMenu", "tagEditorMenu"].forEach(id => { if (id !== except) $(id)?.classList.add("hidden"); });
  if (except !== "tagEditorMenu") tagEditorCtx = null;
}

// ===== Settings =====
function toggleSettingsPanel() {
  const p = $("settingsPanel"), show = p.classList.contains("hidden");
  p.classList.toggle("hidden", !show);
  if (show) {
    $("inputGistId").value = GIST_ID;
    $("inputToken").value = TOKEN;
    $("inputTmdbKey").value = TMDB_KEY;
    updateShareButton();
  }
}

function saveSettings() {
  const g = $("inputGistId").value.trim(), t = $("inputToken").value.trim();
  const tmdb = $("inputTmdbKey").value.trim();
  if (!g || !t) return;
  localStorage.setItem("gist_id", g);
  localStorage.setItem("github_token", t);
  localStorage.setItem("tmdb_key", tmdb);
  GIST_ID = g; TOKEN = t; TMDB_KEY = tmdb;
  tmdbGenres = null;
  $("sectionMenu").classList.add("hidden"); $("settingsPanel").classList.add("hidden");
  updateShareButton(); updateTmdbBtnVisibility(); init();
}

function updateShareButton() { $("shareBtn").style.display = GIST_ID && TOKEN ? "grid" : "none"; }

function copyShareLink() {
  if (!GIST_ID || !TOKEN) return;
  const payload = TMDB_KEY ? `${GIST_ID}:${TOKEN}:${TMDB_KEY}` : `${GIST_ID}:${TOKEN}`;
  const link = `${location.origin}${location.pathname}?s=${btoa(payload)}`;
  navigator.clipboard?.writeText(link);
}

// ===== Sections =====
function toggleSectionMenu() {
  if (isEditing) return;

  // If user is currently renaming the section name, do nothing.
  if (sectionRename.active) return;

  // Elegant rename: fast double tap on the section button (when not "Все") starts rename instead of opening menu.
  if (currentSection !== "__all__") {
    const now = Date.now();
    const fast = (now - (sectionRename.lastTapAt || 0)) <= 350;
    sectionRename.lastTapAt = now;
    if (fast) {
      beginSectionRename();
      return;
    }
  }

  const menu = $("sectionMenu");
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    $("newSectionInput").classList.add("hidden");
    $("settingsPanel").classList.add("hidden");
    disarmSectionDelete();
    return;
  }
  renderSectionList(); $("newSectionInput").classList.add("hidden"); $("settingsPanel").classList.add("hidden");
  openMenu("sectionMenu", $("sectionBtn"), "left");
}

function renderSectionList() {
  const keys = Object.keys(data.sections);
  $("sectionList").innerHTML = keys.map(key => `
    <div class="menu-option ${currentSection === key ? "active" : ""} ${deleteArmSection === key ? "armed" : ""}" onclick="selectSection('${escQ(key)}')">
      <span>${esc(key)}</span>
      <span class="menu-actions" onclick="event.stopPropagation()">
        <button class="mini-btn danger" onclick="event.stopPropagation(); handleSectionDelete('${escQ(key)}')">×</button>
      </span>
    </div>`).join("");
}

function selectSection(key) {
  currentSection = key; localStorage.setItem("current_section", key);
  selectedKey = null; disarmItemDelete(); closeTagEditor(); disarmSectionDelete();
  updateSectionButton(); $("sectionMenu").classList.add("hidden"); $("settingsPanel").classList.add("hidden");
  // сбрасываем scroll, чтобы не сохранялось старое положение другого раздела
  localStorage.setItem("scroll_y", "0");
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  render();
}

function updateSectionButton() {
  const el = $("currentSectionName");
  if (!el) return;
  el.textContent = currentSection === "__all__" ? "Все" : currentSection;
  // Ensure we are showing the start of the text in ellipsis mode
  try { el.scrollLeft = 0; } catch {}

  // Bottom add button is not available in "Все"
  const footer = $("addItemFooter");
  if (footer) footer.style.display = (currentSection === "__all__" || isEditing) ? "none" : "flex";
}

function showNewSectionInput() { const inp = $("newSectionInput"); inp.classList.remove("hidden"); inp.value = ""; inp.focus(); disarmSectionDelete(); }

function handleNewSection(e) {
  if (e.key === "Enter") {
    const name = e.target.value.trim();
    if (name && !data.sections[name]) { data.sections[name] = { items: [], modified: new Date().toISOString() }; saveData(); renderSectionList(); selectSection(name); }
    e.target.classList.add("hidden");
  } else if (e.key === "Escape") e.target.classList.add("hidden");
}

function handleSectionDelete(key) {
  if (!data.sections[key]) return;
  if (deleteArmSection === key) {
    const payload = { type: "section", key, secData: JSON.parse(JSON.stringify(data.sections[key])), prev: currentSection };
    delete data.sections[key];
    if (currentSection === key) {
      currentSection = "__all__";
      localStorage.setItem("current_section", "__all__");
      updateSectionButton();
    }
    selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); disarmSectionDelete();
    saveData(); renderSectionList(); render();
    startUndo(payload, `Раздел удалён: ${key}`);
    return;
  }
  deleteArmSection = key;
  renderSectionList();
  if (deleteArmSectionTimer) clearTimeout(deleteArmSectionTimer);
  deleteArmSectionTimer = setTimeout(() => { disarmSectionDelete(); renderSectionList(); }, 6000);
}

function disarmSectionDelete() { deleteArmSection = null; if (deleteArmSectionTimer) clearTimeout(deleteArmSectionTimer); deleteArmSectionTimer = null; }

// ===== Sort =====
function toggleSort() {
  if (isEditing) return;
  const menu = $("sortMenu");
  const willOpen = menu.classList.contains("hidden");
  if (!willOpen) { menu.classList.add("hidden"); sortMenuOpen = false; localStorage.setItem("sort_menu_open", "0"); return; }
  sortMenuOpen = true;
  localStorage.setItem("sort_menu_open", "1");
  openMenu("sortMenu", $("sortBtn"), "right");
  updateSortMenuUI();
}

function setSortKey(key) {
  if (key === "manual") sortState = { key: "manual", dir: "desc" };
  else if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  else sortState = { key, dir: key === "alpha" ? "asc" : "desc" };
  localStorage.setItem("sort_state", `${sortState.key}:${sortState.dir}`);
  selectedKey = null; localStorage.removeItem("selected_key");
  disarmItemDelete(); closeTagEditor();
  // описание можно оставить раскрытым
  updateSortMenuUI();
  $("sortMenu").classList.add("hidden");
  sortMenuOpen = false; localStorage.setItem("sort_menu_open", "0");
  render();
}

function parseSortState(s) { if (!s) return null; const [k, d] = s.split(":"); return k ? { key: k, dir: d === "asc" ? "asc" : "desc" } : null; }

function updateSortMenuUI() {
  document.querySelectorAll("#sortMenu .menu-option").forEach(el => {
    const k = el.dataset.key, active = k === sortState.key;
    el.classList.toggle("active", active);
    const dir = el.querySelector(".sort-dir");
    if (dir) dir.textContent = !active || k === "manual" ? "" : sortState.dir === "asc" ? "↑" : "↓";
  });
}

function sortItems(items) {
  if (sortState.key === "manual") return items;
  const sorted = [...items], text = x => x.text || "";
  if (sortState.key === "alpha") sorted.sort((a, b) => text(a).localeCompare(text(b), "ru"));
  else if (sortState.key === "year") sorted.sort((a, b) => {
    const yA = (text(a).match(/\((\d{4})\)/) || [, 0])[1], yB = (text(b).match(/\((\d{4})\)/) || [, 0])[1];
    return Number(yA) - Number(yB);
  });
  else if (sortState.key === "date") sorted.sort((a, b) => (Date.parse(a.item?.created) || 0) - (Date.parse(b.item?.created) || 0));
  if (sortState.dir === "desc") sorted.reverse();
  return sorted;
}

// ===== Undo =====
function startUndo(payload, label) {
  undoPayload = payload;
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { hideUndo(); undoPayload = null; }, UNDO_MS);
  $("undoText").textContent = label; $("undoBar").classList.remove("hidden");
}

function hideUndo() { $("undoBar").classList.add("hidden"); }

$("undoBtn").onclick = () => {
  if (!undoPayload) return;
  const p = undoPayload;
  if (p.type === "section") {
    let k = p.key;
    if (data.sections[k]) { let i = 2; while (data.sections[`${k} (${i})`]) i++; k = `${k} (${i})`; }
    data.sections[k] = p.secData;
    if (p.prev === p.key) { currentSection = k; localStorage.setItem("current_section", k); updateSectionButton(); }
    saveData(); renderSectionList(); render();
  } else if (p.type === "item") {
    if (!data.sections[p.secKey]) data.sections[p.secKey] = { items: [], modified: new Date().toISOString() };
    const arr = data.sections[p.secKey].items;
    arr.splice(Math.min(p.idx, arr.length), 0, p.item);
    data.sections[p.secKey].modified = new Date().toISOString();
    saveData(); render();
  } else if (p.type === "viewed") {
    const item = data.sections?.[p.secKey]?.items?.[p.idx];
    if (item) { setViewed(item, p.was); data.sections[p.secKey].modified = new Date().toISOString(); saveData(); render(); }
  } else if (p.type === "tag" || p.type === "tagClear") {
    const item = data.sections?.[p.secKey]?.items?.[p.idx];
    if (item) { item.tags = uniqueTags(p.oldTags); data.sections[p.secKey].modified = new Date().toISOString(); saveData(); render(); renderTagEditorList(); renderTagFilterMenu(); }
  } else if (p.type === "itemRestore") {
    const item = data.sections?.[p.secKey]?.items?.[p.idx];
    if (item) {
      // Restore the entire item snapshot (including tags and API-loaded fields)
      const wasViewed = isViewed(item);
      Object.assign(item, p.oldItem);
      // Ensure viewed tag stays consistent if it was toggled elsewhere
      if (wasViewed) setViewed(item, true);
      data.sections[p.secKey].modified = new Date().toISOString();
      saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
    }
  } else if (p.type === "desc") {
    const item = data.sections?.[p.secKey]?.items?.[p.idx];
    if (item) { 
      item.desc = p.oldDesc; 
      item.poster = p.oldPoster; 
      data.sections[p.secKey].modified = new Date().toISOString(); 
      saveData(); render(); 
    }
  } else if (p.type === "moveItem") {
    // Undo move: remove from toSec, insert back to fromSec at original position
    const toArr = data.sections?.[p.toSec]?.items;
    const fromArr = data.sections?.[p.fromSec]?.items;
    if (toArr && fromArr) {
      // Find and remove from target
      const idxInTarget = toArr.findIndex(it => 
        it.text === p.item.text && it.created === p.item.created
      );
      if (idxInTarget >= 0) {
        toArr.splice(idxInTarget, 1);
        data.sections[p.toSec].modified = new Date().toISOString();
      }
      // Insert back at original position
      fromArr.splice(Math.min(p.fromIdx, fromArr.length), 0, p.item);
      data.sections[p.fromSec].modified = new Date().toISOString();
      saveData(); renderSectionList(); render();
    }
  }
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null; undoPayload = null; hideUndo();
};

// ===== Item actions =====
function toggleItemViewed(secKey, idx) {
  const sec = data.sections[secKey];
  if (!sec?.items?.[idx]) return;

  const key = `${secKey}|${idx}`;
  const item = sec.items[idx];
  const was = isViewed(item);

  setViewed(item, !was);
  sec.modified = new Date().toISOString();

  // Keep selection/expanded description only when we are in "show all" mode.
  // In hide/only modes the item may disappear after toggling.
  const keepFocus = viewedFilter === "show";
  if (!keepFocus) {
    if (selectedKey === key) {
      selectedKey = null;
      localStorage.removeItem("selected_key");
    }
    if (expandedDescKey === key) {
      expandedDescKey = null;
      localStorage.removeItem("expanded_desc_key");
    }
  }

  disarmItemDelete();
  closeTagEditor();

  saveData();
  render();
  startUndo({ type: "viewed", secKey, idx, was }, was ? "Снято: просмотрено" : "Отмечено просмотренным");
}

function armItemDelete(key) {
  deleteArmItemKey = key;
  if (deleteArmItemTimer) clearTimeout(deleteArmItemTimer);
  deleteArmItemTimer = setTimeout(disarmItemDelete, 6000);
  document.querySelectorAll("#viewMode .item-line").forEach(el => el.classList.toggle("del-armed", el.dataset.key === key));
}

function disarmItemDelete() {
  deleteArmItemKey = null;
  if (deleteArmItemTimer) clearTimeout(deleteArmItemTimer);
  deleteArmItemTimer = null;
  document.querySelectorAll("#viewMode .item-line.del-armed").forEach(el => el.classList.remove("del-armed"));
}

function deleteItemNow(secKey, idx) {
  const arr = data.sections[secKey]?.items;
  if (!arr?.[idx]) return;
  const item = JSON.parse(JSON.stringify(arr[idx]));
  arr.splice(idx, 1);
  data.sections[secKey].modified = new Date().toISOString();
  disarmItemDelete(); closeTagEditor(); closeDescMenu(); selectedKey = null;
  saveData(); render();
  startUndo({ type: "item", secKey, idx, item }, "Запись удалена");
}

// ===== Edit =====
function toggleEdit() {
  if (!TOKEN || !GIST_ID) { toggleSectionMenu(); return; }
  if (savingInProgress) return;
  isEditing ? cancelEdit() : startEdit();
}

function itemRating(item) {
  const r = Number(item?.rating);
  if (!Number.isFinite(r)) return null;
  // По требованию: если рейтинг не получен/нулевой (0.0), считаем что его нет
  if (r <= 0) return null;
  return r;
}

function ratingColor(r) {
  const v = Number(r);
  if (!Number.isFinite(v)) return null;

  // Map 0..10 to red..green (hue 0..120)
  const t = Math.max(0, Math.min(1, v / 10));
  const hue = 120 * t;
  // Slightly bright but not neon
  return `hsl(${hue} 70% 55%)`;
}

function matchFilters(item) {
  const q = filterQuery.trim().toLowerCase();
  if (q && !String(item.text).toLowerCase().includes(q)) return false;
  
  const itemTags = displayTags(item);
  
  // Excluded tags have highest priority — if any excluded tag is present, hide item
  if (tagFilterExcluded.size && itemTags.some(t => tagFilterExcluded.has(normTag(t)))) return false;
  
  // Included tags — item must have at least one of them
  if (tagFilter.size && !itemTags.some(t => tagFilter.has(normTag(t)))) return false;

  if (ratingFilter != null) {
    const r = itemRating(item);
    if (r == null || r < ratingFilter) return false;
  }

  const v = isViewed(item);
  if (viewedFilter === "hide" && v) return false;
  if (viewedFilter === "only" && !v) return false;
  return true;
}

function adjustEditHeight() {
  if (!isEditing) return;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.body.style.height = vh + "px";
}

function startEdit() {
  isEditing = true; selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); setFilterLock(true);
  document.body.classList.add("editing");
  // Ensure bottom "+" button is hidden in edit mode even if it had inline display:flex.
  updateSectionButton();
  adjustEditHeight();
  updateTmdbModeBtn();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", adjustEditHeight);
    window.visualViewport.addEventListener("scroll", adjustEditHeight);
  }
  const editor = $("editor"), hint = $("editHint");
  $("editUse").setAttribute("href", `${ICONS}#i-x`);
  normalizeDataModel();

  if (currentSection === "__all__") {
    const masks = {}, lines = [];
    for (const key of Object.keys(data.sections)) {
      const sec = data.sections[key];
      const mask = sec.items.map(it => matchFilters(it));
      if (mask.some(Boolean)) masks[key] = mask;
      sec.items.forEach((it, i) => { if (mask[i]) lines.push(`[${key}] ${it.text}`); });
    }
    editor.value = lines.join("\n");
    hint.classList.remove("hidden");
    editCtx = { mode: "all", masks };
  } else {
    const sec = data.sections[currentSection];
    const mask = sec?.items.map(it => matchFilters(it)) || [];
    const lines = sec?.items.filter((_, i) => mask[i]).map(it => it.text) || [];
    editor.value = lines.join("\n");
    hint.classList.add("hidden");
    editCtx = { mode: "section", secKey: currentSection, mask };
  }
  $("viewMode").classList.add("hidden"); $("editMode").classList.remove("hidden"); editor.focus();
}

function cancelEdit() {
  if (savingInProgress) return;
  if (window.visualViewport) {
    window.visualViewport.removeEventListener("resize", adjustEditHeight);
    window.visualViewport.removeEventListener("scroll", adjustEditHeight);
  }
  document.body.style.height = "";
  isEditing = false; editCtx = null; setFilterLock(false);
  document.body.classList.remove("editing");
  $("viewMode").classList.remove("hidden"); $("editMode").classList.add("hidden"); $("editHint").classList.add("hidden");
  $("editUse").setAttribute("href", `${ICONS}#i-pencil`);
  updateSectionButton();
}

function mergeByMask(orig, mask, texts) {
  const out = []; let ti = 0;
  for (let i = 0; i < orig.length; i++) {
    if (mask[i]) { if (ti < texts.length) out.push({ ...orig[i], text: texts[ti++].trim() }); }
    else out.push(orig[i]);
  }
  while (ti < texts.length) { const t = texts[ti++].trim(); if (t) out.push({ text: t, tags: [], created: new Date().toISOString() }); }
  return out;
}

function parseAllLines(lines) {
  const by = {}; let last = Object.keys(data.sections)[0] || "Раздел";
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) { const k = m[1].trim(), t = m[2].trim(); if (k) { if (!by[k]) by[k] = []; if (t) by[k].push(t); last = k; } }
    else { const t = line.trim(); if (t) { if (!by[last]) by[last] = []; by[last].push(t); } }
  }
  return by;
}

async function saveEdit() {
  if (savingInProgress) return;
  if (!editCtx || !isEditing) return;
  
  // Сразу закрываем режим редактирования
  const lines = $("editor").value.split("\n").map(s => s.trim()).filter(Boolean);
  const savedEditCtx = { ...editCtx };
  const savedTmdbMode = tmdbMode;
  
  // Закрываем UI редактирования
  if (window.visualViewport) {
    window.visualViewport.removeEventListener("resize", adjustEditHeight);
    window.visualViewport.removeEventListener("scroll", adjustEditHeight);
  }
  document.body.style.height = "";
  isEditing = false; editCtx = null; setFilterLock(false);
  document.body.classList.remove("editing");
  $("viewMode").classList.remove("hidden"); $("editMode").classList.add("hidden"); $("editHint").classList.add("hidden");
  $("editUse").setAttribute("href", `${ICONS}#i-pencil`);
  updateSectionButton();
  
  // Начинаем фоновое сохранение
  savingInProgress = true;
  showProgress("Сохранение...", 10);
  
  try {
    normalizeDataModel();

    // Собираем старые позиции для определения новых
    const oldItemsSet = new Set();
    for (const key of Object.keys(data.sections)) {
      const items = data.sections[key]?.items || [];
      items.forEach(it => oldItemsSet.add(`${key}|${it.text}|${it.created}`));
    }

    // Применяем изменения
    if (savedEditCtx.mode === "section") {
      const orig = data.sections[savedEditCtx.secKey]?.items || [];
      data.sections[savedEditCtx.secKey] = { items: mergeByMask(orig, savedEditCtx.mask, lines), modified: new Date().toISOString() };
    } else {
      const newBy = parseAllLines(lines);
      for (const key of new Set([...Object.keys(data.sections), ...Object.keys(newBy)])) {
        const orig = data.sections[key]?.items || [];
        const mask = savedEditCtx.masks[key] || new Array(orig.length).fill(false);
        const merged = mergeByMask(orig, mask, newBy[key] || []);
        if (!data.sections[key]) data.sections[key] = { items: [], modified: new Date().toISOString() };
        data.sections[key].items = merged;
        data.sections[key].modified = new Date().toISOString();
      }
    }

    showProgress("Сохранение...", 30);
    
    // Сохраняем в Gist
    await saveData();
    
    showProgress("Сохранено", 50);
    renderSectionList();
    render();

    // Режим "clear" — удаляем описание и постер для видимых позиций
    if (savedTmdbMode === "clear") {
      const editedSections = savedEditCtx.mode === "section" 
        ? [savedEditCtx.secKey] 
        : Object.keys(savedEditCtx.masks);

      let cleared = 0;
      for (const secKey of editedSections) {
        const items = data.sections[secKey]?.items || [];
        const mask = savedEditCtx.mode === "section" ? savedEditCtx.mask : (savedEditCtx.masks[secKey] || []);

        items.forEach((item, idx) => {
          const wasVisible = mask[idx] === true;
          if (!wasVisible) return;

          const hadDescOrPoster = !!(item.desc || item.poster);
          const hadTags = Array.isArray(item.tags) && item.tags.some(t => t !== VIEWED_TAG);

          // clear desc+poster
          item.desc = null;
          item.poster = null;

          // clear rating/meta
          item.rating = null;
          item.votes = null;
          item.tmdbType = null;
          item.year = null;

          // clear TV meta
          item.seasons = null;
          item.episodes = null;
          item.firstAirDate = null;
          item.lastAirDate = null;
          item.inProduction = null;

          // clear tags except viewed
          item.tags = isViewed(item) ? [VIEWED_TAG] : [];

          if (hadDescOrPoster || hadTags) cleared++;
        });

        if (cleared) data.sections[secKey].modified = new Date().toISOString();
      }

      if (cleared) {
        showProgress(`Удалено данных: ${cleared}`, 80);
        await saveData();
        render();
      }
    }
    
    // Определяем позиции для автозагрузки TMDB (режимы new и all)
    if ((savedTmdbMode === "new" || savedTmdbMode === "all") && TMDB_KEY) {
      const itemsToFetch = [];
      
      // Собираем ВСЕ новые позиции (для режимов new и all)
      const allNewItems = [];
      for (const secKey of Object.keys(data.sections)) {
        const items = data.sections[secKey]?.items || [];
        items.forEach((item, idx) => {
          const isNew = !oldItemsSet.has(`${secKey}|${item.text}|${item.created}`);
          const hasData = item.desc || item.poster;
          if (isNew && !hasData) {
            allNewItems.push({ secKey, idx });
          }
        });
      }
      
      if (savedTmdbMode === "new") {
        // Только новые позиции
        itemsToFetch.push(...allNewItems);
      } else if (savedTmdbMode === "all") {
        // Новые позиции + видимые в редактировании без данных
        itemsToFetch.push(...allNewItems);
        
        // Добавляем видимые позиции без данных (но не дублируем новые)
        const newItemsSet = new Set(allNewItems.map(x => `${x.secKey}|${x.idx}`));
        
        const editedSections = savedEditCtx.mode === "section" 
          ? [savedEditCtx.secKey] 
          : Object.keys(savedEditCtx.masks);
        
        for (const secKey of editedSections) {
          const items = data.sections[secKey]?.items || [];
          const mask = savedEditCtx.mode === "section" ? savedEditCtx.mask : (savedEditCtx.masks[secKey] || []);
          
          items.forEach((item, idx) => {
            const wasVisible = mask[idx] === true;
            const hasData = item.desc || item.poster;
            const alreadyAdded = newItemsSet.has(`${secKey}|${idx}`);
            
            if (wasVisible && !hasData && !alreadyAdded) {
              itemsToFetch.push({ secKey, idx });
            }
          });
        }
      }
      
      if (itemsToFetch.length) {
        const total = itemsToFetch.length;
        for (let i = 0; i < itemsToFetch.length; i++) {
          const { secKey, idx } = itemsToFetch[i];
          const item = data.sections?.[secKey]?.items?.[idx];
          if (!item) continue;
          
          const percent = 50 + Math.round((i / total) * 45);
          showProgress(`Загрузка ${i + 1}/${total}...`, percent);
          
          try {
            const { genres, overview, poster, originalTitle, year, rating, votes, tmdbType, seasons, episodes, firstAirDate, lastAirDate, inProduction } = await fetchTmdbDataForItem(item.text);
            let updated = false;
            
            // Нормализуем/дополняем наименование (orig + year)
            const nextTitle = buildTitleUpdate(item.text, originalTitle, year);
            if (nextTitle) {
              item.text = nextTitle;
              updated = true;
            }
            
            if (genres.length) {
              const existing = new Set((item.tags || []).map(normTag));
              const newTags = genres.filter(g => !existing.has(normTag(g)));
              if (newTags.length) {
                item.tags = uniqueTags([...(item.tags || []), ...newTags]);
                // Extra normalization for anime rules
                item.tags = normalizeAnimeTags(item.tags);
                updated = true;
              } else {
                // Still normalize (in case item already had anim+country)
                const before = JSON.stringify(uniqueTags(item.tags || []));
                const afterArr = normalizeAnimeTags(item.tags || []);
                const after = JSON.stringify(afterArr);
                if (before !== after) {
                  item.tags = afterArr;
                  updated = true;
                }
              }
            }

            // Add "сериал" tag for TV shows (first among regular tags)
            if (tmdbType === "tv") {
              const hasSeriалTag = (item.tags || []).some(t => normTag(t) === "сериал");
              if (!hasSeriалTag) {
                // Insert after __viewed__ if present, else at start
                const viewedIdx = (item.tags || []).indexOf(VIEWED_TAG);
                if (viewedIdx >= 0) {
                  item.tags.splice(viewedIdx + 1, 0, "сериал");
                } else {
                  item.tags = ["сериал", ...(item.tags || [])];
                }
                item.tags = uniqueTags(item.tags);
                updated = true;
              }
            }
            
            if (overview && !item.desc) {
              item.desc = overview;
              updated = true;
            }
            
            if (poster && !item.poster) {
              item.poster = poster;
              updated = true;
            }

            if (rating != null && item.rating == null) { item.rating = rating; updated = true; }
            if (votes != null && item.votes == null) { item.votes = votes; updated = true; }
            if (tmdbType && !item.tmdbType) { item.tmdbType = tmdbType; updated = true; }
            if (year && !item.year) { item.year = String(year); updated = true; }

            // TV meta (store for later rendering)
            if (tmdbType === "tv") {
              if (seasons != null && item.seasons == null) { item.seasons = seasons; updated = true; }
              if (episodes != null && item.episodes == null) { item.episodes = episodes; updated = true; }
              if (firstAirDate && !item.firstAirDate) { item.firstAirDate = firstAirDate; updated = true; }
              if (lastAirDate && !item.lastAirDate) { item.lastAirDate = lastAirDate; updated = true; }
              if (inProduction != null && item.inProduction == null) { item.inProduction = inProduction; updated = true; }

              // If year is missing, derive from first_air_date
              if (!item.year && firstAirDate) { item.year = String(firstAirDate).slice(0, 4); updated = true; }
            }
            
            if (updated) {
              data.sections[secKey].modified = new Date().toISOString();
            }
          } catch {}
        }
        
        showProgress("Сохранение данных...", 98);
        await saveData();
        render();
      }
    }
    
    showProgress("Готово", 100);
    setTimeout(hideProgress, 500);
    
  } catch (err) {
    showProgress("Ошибка", 100);
    setTimeout(hideProgress, 2000);
  } finally {
    savingInProgress = false;
  }
}

// ===== Render =====
function buildItems() {
  normalizeDataModel();
  let items = [];
  const sections = currentSection === "__all__" ? Object.keys(data.sections) : [currentSection];
  for (const key of sections) {
    const sec = data.sections[key];
    if (!sec) continue;
    sec.items.forEach((it, i) => items.push({ item: it, text: it.text, secKey: key, idx: i }));
  }
  const q = filterQuery.trim().toLowerCase();
  if (q) items = items.filter(x => x.text.toLowerCase().includes(q));
  
  // Excluded tags — hide items that have any excluded tag (highest priority)
  if (tagFilterExcluded.size) items = items.filter(x => !displayTags(x.item).some(t => tagFilterExcluded.has(normTag(t))));
  
  // Included tags — show only items that have at least one included tag
  if (tagFilter.size) items = items.filter(x => displayTags(x.item).some(t => tagFilter.has(normTag(t))));

  if (ratingFilter != null) {
    items = items.filter(x => {
      const r = itemRating(x.item);
      return r != null && r >= ratingFilter;
    });
  }

  items = items.filter(x => {
    const v = isViewed(x.item);
    if (viewedFilter === "hide") return !v;
    if (viewedFilter === "only") return v;
    return true;
  });
  return sortItems(items);
}

function render() {
  // If an inline edit is active, preserve it across a full re-render.
  // This prevents background updates (e.g. TMDB fetch completion) from destroying
  // the editable DOM node and effectively "ending" the user's current editing session.
  let restoreInline = null;
  if (inlineEdit?.active && inlineEdit?.el) {
    const el = inlineEdit.el;
    let caretOffset = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (el.contains(r.startContainer)) {
          const off = charOffsetFromRange(el, r);
          if (typeof off === "number") caretOffset = off;
        }
      }
    } catch {}

    restoreInline = {
      key: inlineEdit.key,
      draftText: String(el.textContent || ""),
      caretOffset,
      orig: inlineEdit.orig
    };

    // Remove handlers to avoid accidental commit on blur when DOM is replaced
    try {
      el.onkeydown = null;
      el.onblur = null;
      el.setAttribute("contenteditable", "false");
    } catch {}

    inlineEdit = { active: false, key: null, secKey: null, idx: null, el: null, orig: "" };
  }

  const view = $("viewMode"), items = buildItems();
  updateTagFilterBtnUI();
  if (!items.length) {
    // If the list became empty (filters/section), keep the pick state (like description).
    // IMPORTANT: do NOT resolve the item (do not remove pending).
    view.innerHTML = "";
    updateCounter(0);
    return;
  }

  const keySet = new Set(items.map(x => `${x.secKey}|${x.idx}`));
  if (selectedKey && !keySet.has(selectedKey)) { selectedKey = null; disarmItemDelete(); closeTagEditor(); }

  // Validate TMDB pick by DATA (not by current visibility), like description.
  // IMPORTANT: use stable item.id (pickKey), NOT `created` and NOT sec|idx.
  // This prevents the pick panel from attaching to a wrong item after deletes/moves/sorts.
  if (tmdbAutoPick?.pickKey) {
    const pickKey = String(tmdbAutoPick.pickKey || "");
    const found = findItemByPickKey(pickKey);
    const it = found ? data.sections?.[found.secKey]?.items?.[found.idx] : null;

    // If item no longer exists OR it is no longer pending => close pick.
    if (!it || !isPendingPickCreated(pickKey)) {
      tmdbAutoPick = null;
    } else {
      // If the item is currently being edited inline, do not re-render/move the pick panel.
      // This avoids a nasty UX where DOM changes can steal focus.
      // If the item moved (sec/idx changed), update the rendered key so the panel stays with the same item.
      if (tmdbAutoPick.key !== found.key) {
        tmdbAutoPick = { ...tmdbAutoPick, key: found.key, secKey: found.secKey, idx: found.idx };
      }
    }
  }

  // Keep expanded description even if the item is temporarily hidden by filters/section.
  // Only reset when the item no longer exists in DATA or has no description anymore.
  if (expandedDescKey) {
    const p = parseItemKey(expandedDescKey);
    const it = p ? data.sections?.[p.secKey]?.items?.[p.idx] : null;
    if (!it || !it.desc) {
      expandedDescKey = null;
      localStorage.removeItem("expanded_desc_key");
    }
  }

  view.innerHTML = items.map(x => {
    const key = `${x.secKey}|${x.idx}`, sel = selectedKey === key, viewed = isViewed(x.item);
    const hasDesc = !!x.item.desc;
    const isExpanded = expandedDescKey === key;
    const secTag = currentSection === "__all__" ? `<span class="item-section-tag">${esc(x.secKey)}</span>` : "";
    const rawTags = displayTags(x.item);
    // Разделяем на: тег "сериал" (первый), обычные теги, страны (последние)
    const serialTag = rawTags.find(t => normTag(t) === "сериал");
    const otherTags = rawTags.filter(t => !isCountryTag(t) && normTag(t) !== "сериал").sort((a, b) => a.localeCompare(b, "ru"));
    const countryTags = rawTags.filter(t => isCountryTag(t)).sort((a, b) => a.localeCompare(b, "ru"));

    const ratingVal = itemRating(x.item);
    const votesMeta = (ratingVal != null) ? formatVotes(x.item.votes) : null;
    const rColor = (ratingVal != null) ? ratingColor(ratingVal) : null;

    // Rating chip: colored, without border, with votes count (if available)
    const ratingChip = (ratingVal != null)
      ? `<span class="tag-chip rating" style="--rating-color:${esc(rColor)}"><span class="rating-val">${esc(ratingVal.toFixed(1))}</span>${votesMeta ? `<span class="rating-votes"> (${esc(votesMeta)})</span>` : ""}</span>`
      : "";

    const tagsHtml = (serialTag || countryTags.length || otherTags.length || ratingChip)
      ? `<span class="item-tags">${serialTag ? `<span class="tag-chip serial">${esc(serialTag)}</span>` : ""}${otherTags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join("")}${countryTags.map(t => `<span class="tag-chip country">${esc(countryDisplayName(t))}</span>`).join("")}${ratingChip}</span>`
      : "";

    const descBtn = hasDesc
      ? `<button class="desc-action has-desc ${isExpanded ? "open" : ""}" data-action="desc"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-doc"></use></svg></button>`
      : "";

    let viewedBtn;
    if (viewed) {
      const icon = sel ? "i-eye-off" : "i-eye";
      viewedBtn = `<button class="viewed-action is-viewed" data-action="toggle-viewed"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#${icon}"></use></svg></button>`;
    } else {
      viewedBtn = `<button class="viewed-action not-viewed" data-action="toggle-viewed"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg></button>`;
    }

    // Inline TMDB auto-pick block (for pending items)
    // Behavior must match description: it stays open even if item becomes unselected,
    // and it should not disappear due to filters/section switches (unless item is gone or resolved).
    let autoPickBlock = "";
    if (tmdbAutoPick && tmdbAutoPick.key === key) {
      if (tmdbAutoPick.loading) {
        autoPickBlock = `
          <div class="tmdb-pick">
            <div class="tmdb-pick-title">TMDB: поиск...</div>
          </div>`;
      } else {
        const candidates = Array.isArray(tmdbAutoPick.candidates) ? tmdbAutoPick.candidates : [];
        autoPickBlock = `
          <div class="tmdb-pick">
            <div class="tmdb-pick-title">TMDB: выбрать (${candidates.length})</div>
            <div class="tmdb-pick-list">
              <button class="tmdb-pick-item tmdb-no-load" type="button" data-action="tmdb-keep">
                <div class="tmdb-pick-label">${esc(x.text)}</div>
                <div style="margin-top:6px;">
                  <span class="tag-chip" style="border-color:transparent;background:transparent;">не загружать данные</span>
                </div>
              </button>
              ${candidates.map((c, i) => {
                const label = formatTmdbCandidateLabel(c);
                const chips = tmdbCandidateChipsHtml(c);
                return `
                  <button class="tmdb-pick-item" type="button" data-action="tmdb-auto" data-pick="${i}">
                    <div class="tmdb-pick-label">${esc(label)}</div>
                    ${chips ? `<div class="tmdb-pick-tags">${chips}</div>` : ""}
                  </button>`;
              }).join("")}
            </div>
          </div>`;
      }
    }

    // Inline description block (expanded)
    let descBlock = "";
    if (isExpanded && hasDesc) {
      const posterHtml = x.item.poster 
        ? `<img class="item-desc-poster" src="${esc(x.item.poster)}" alt="" loading="lazy" />`
        : "";

      // Meta: type · seasons · episodes · year-range
      const tagsForType = displayTags(x.item);
      const isAnime = tagsForType.includes("аниме");
      const hasAnim = tagsForType.includes("анимация") || tagsForType.includes("мультфильм") || tagsForType.includes("мультсериал");

      const typeLabel = x.item.tmdbType === "movie"
        ? (isAnime ? "Аниме" : (hasAnim ? "Мультфильм" : "Фильм"))
        : (x.item.tmdbType === "tv" ? (isAnime ? "Аниме" : "Сериал") : "");

      const leftParts = [];
      if (typeLabel) leftParts.push(typeLabel);

      // Only for TV: seasons + total episodes
      if (x.item.tmdbType === "tv") {
        const s = Number(x.item.seasons);
        const e = Number(x.item.episodes);
        if (Number.isFinite(s) && s > 0) leftParts.push(`${s} ${ruPlural(s, "сезон", "сезона", "сезонов")}`);
        if (Number.isFinite(e) && e > 0) leftParts.push(`${e} ${ruPlural(e, "серия", "серии", "серий")}`);
      }

      const yearMeta = (x.item.tmdbType === "tv")
        ? formatTvYearRange(x.item)
        : (x.item.year || ((x.text.match(/\((\d{4})\)/) || [])[1] || ""));

      if (yearMeta) leftParts.push(yearMeta);
      const leftText = leftParts.join(" · ");

      const metaHtml = leftText
        ? `<div class="item-desc-meta">
             <span class="item-desc-meta-left">${esc(leftText)}</span>
           </div>`
        : "";

      descBlock = `
        <div class="item-desc-block">
          ${posterHtml}
          <div class="item-desc-content">
            ${metaHtml}
            <div class="item-desc-text">${esc(x.item.desc)}</div>
          </div>
          <button class="desc-del-btn" data-action="clear-desc" title="Удалить описание">
            <svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-trash"></use></svg>
          </button>
        </div>`;
    }

    return `
      <div class="item-line ${sel ? "selected" : ""} ${isExpanded ? "expanded" : ""} ${deleteArmItemKey === key ? "del-armed" : ""}" data-key="${esc(key)}" data-sec="${esc(x.secKey)}" data-idx="${x.idx}">
        <div class="item-row">
          <button class="item-del" data-action="del"><svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-x"></use></svg></button>
          ${secTag}
          <div class="item-main"><span class="item-text" data-role="text" contenteditable="false" spellcheck="false">${esc(x.text)}</span>${tagsHtml}</div>
          <div class="item-actions">
            ${descBtn}
            <button class="tag-action" data-action="tags"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-tag"></use></svg></button>
            ${viewedBtn}
          </div>
        </div>
        ${autoPickBlock}
        ${descBlock}
      </div>`;
  }).join("");
  updateCounter(items.length);

  // Restore inline edit session (if any) after DOM update
  if (restoreInline && restoreInline.key) {
    const line = document.querySelector(`#viewMode .item-line[data-key="${CSS.escape(restoreInline.key)}"]`);
    if (line) {
      beginInlineEdit(line, (typeof restoreInline.caretOffset === "number") ? { caretOffset: restoreInline.caretOffset } : {});
      // Re-apply user's uncommitted text draft
      if (inlineEdit?.el) {
        inlineEdit.el.textContent = restoreInline.draftText;
        if (typeof restoreInline.caretOffset === "number") {
          setCaretByCharOffset(inlineEdit.el, restoreInline.caretOffset);
        }
      }
    }
  }
}

function updateCounter(n) {
  const text = String(n);
  $("filterCounter").textContent = text;
  $("mobileFilterCounter").textContent = text;
}

// ===== Interactions =====
$("viewMode").addEventListener("pointerdown", e => {
  if (isEditing) return;

  const line = e.target.closest(".item-line");
  const isButton = !!e.target.closest("button");
  const isAction = !!e.target.closest("[data-action]");

  // Text areas where selection is allowed (title + expanded description text)
  const isText = !!e.target.closest('[data-role="text"], .item-desc-text');
  const isInput = !!e.target.closest('input, textarea, [contenteditable="true"]');

  pointer = {
    down: true,
    moved: false,
    startX: e.clientX,
    startY: e.clientY,
    startedAt: Date.now(),
    // If user started press on a non-text zone, we will clear any accidental selection on release
    startedOnNonText: !!(line && !isButton && !isAction && !isText && !isInput)
  };

  // Long press detection — only on empty/non-text area (not buttons, not title text, not desc text)
  if (line && !isButton && !isText && !isAction && !isInput) {
    cancelLongPress();
    longPressTarget = line;
    longPressTimer = setTimeout(() => {
      if (!pointer.moved && longPressTarget === line) {
        // Clear any browser text selection that could have appeared
        try { window.getSelection()?.removeAllRanges(); } catch {}

        const sec = line.dataset.sec;
        const idx = Number(line.dataset.idx);
        if (sec && Number.isInteger(idx)) {
          // Anchor move menu to the top row so it won't be pushed down by expanded desc/TMDB pick
          const row = line.querySelector(".item-row") || line;
          openMoveMenu(sec, idx, row);
        }
      }
      cancelLongPress();
    }, LONG_PRESS_MS);
  }
});

// Prevent browser context menu on long press (mobile Chrome shows "Download/Share/Print")
$("viewMode").addEventListener("contextmenu", e => {
  e.preventDefault();
  return false;
});

$("viewMode").addEventListener("pointermove", e => {
  if (pointer.down && Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > 10) {
    pointer.moved = true;
    cancelLongPress();
  }
});

$("viewMode").addEventListener("pointerup", () => {
  // If the press started on a non-text area, avoid accidental selection of nearby text on mobile
  if (pointer?.startedOnNonText) {
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }
  pointer.down = false;
  cancelLongPress();
});

$("viewMode").addEventListener("pointercancel", () => {
  if (pointer?.startedOnNonText) {
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }
  pointer.down = false;
  cancelLongPress();
});

$("viewMode").addEventListener("click", e => {
  if (isEditing) return;

  // If inline edit is active and user clicks elsewhere — commit.
  // IMPORTANT: ignore the same click that just started inline edit (iOS Safari keyboard/focus fix).
  if (inlineEdit.active) {
    if (!ignoreOutsideCommitOnce) {
      const inside = e.target === inlineEdit.el || e.target.closest('[data-role="text"]') === inlineEdit.el;
      if (!inside) commitInlineEdit();
    }
  }

  const line = e.target.closest(".item-line");
  if (!line) return;

  const key = line.dataset.key;
  const prevSelectedKey = selectedKey;
  const wasSelected = selectedKey === key;

  const act = e.target.closest("[data-action]");
  if (act) {
    e.stopPropagation();
    if (inlineEdit.active) commitInlineEdit();

    const a = act.dataset.action, sec = line.dataset.sec, idx = +line.dataset.idx;

    if (a === "toggle-viewed") { toggleItemViewed(sec, idx); return; }

    if (a === "tmdb-auto") {
      const pickIdx = Number(act.dataset.pick);
      if (!tmdbAutoPick || tmdbAutoPick.key !== key) return;
      const cand = tmdbAutoPick.candidates?.[pickIdx];
      if (!cand) return;

      // Close pick UI immediately (fast UX)
      const pickKey = String(tmdbAutoPick.pickKey || "");
      tmdbAutoPick = null;

      // Apply immediately (without waiting for extra TMDB details);
      // any missing meta (country/TV numbers) is hydrated in background.
      applyTmdbCandidateToItemFromAutoPick(pickKey, cand);
      return;
    }

    if (a === "tmdb-keep") {
      if (!tmdbAutoPick || tmdbAutoPick.key !== key) return;
      const pickKey = String(tmdbAutoPick.pickKey || "");
      if (pickKey) removePendingPickCreated(pickKey);
      tmdbAutoPick = null;
      render();
      saveData();
      return;
    }

    if (a === "desc") {
      if (selectedKey !== key) {
        selectedKey = key;
        localStorage.setItem("selected_key", selectedKey);
        disarmItemDelete();
      }
      closeTagEditor();
      toggleDescExpand(sec, idx);
      return;
    }

    if (a === "clear-desc") { clearDescForItem(sec, idx); return; }

    if (a === "tags") {
      // Toggle: second press closes
      const menu = $("tagEditorMenu");
      const same = tagEditorCtx && tagEditorCtx.secKey === sec && tagEditorCtx.idx === idx;
      if (same && menu && !menu.classList.contains("hidden")) { closeTagEditor(); return; }

      if (selectedKey !== key) {
        selectedKey = key;
        localStorage.setItem("selected_key", selectedKey);
        disarmItemDelete();
        document.querySelectorAll("#viewMode .item-line.selected").forEach(el => el.classList.remove("selected"));
        line.classList.add("selected");
      }

      openTagEditor(sec, idx, act);
      return;
    }

    if (a === "del") {
      if (selectedKey !== key) {
        selectedKey = key;
        localStorage.setItem("selected_key", selectedKey);
        disarmItemDelete();
        closeTagEditor();
        closeDescMenu();
        render();
        armItemDelete(key);
        return;
      }
      if (deleteArmItemKey === key) { deleteItemNow(sec, idx); return; }
      armItemDelete(key);
      return;
    }
  }

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  if (pointer.startedAt && Date.now() - pointer.startedAt > 350) return;
  if (pointer.moved) return;

  // Selection: clicking the already selected item does NOT clear selection.
  if (!wasSelected) {
    // IMPORTANT: switching selection should NOT resolve pending TMDB pick.
    // The pick UI will be hidden automatically because the previous item loses `.selected`.
    selectedKey = key;
    localStorage.setItem("selected_key", selectedKey);
    disarmItemDelete();
    closeTagEditor();
    document.querySelectorAll("#viewMode .item-line.selected").forEach(el => el.classList.remove("selected"));
    line.classList.add("selected");
  } else {
    // Keep selection, just disarm delete if it was armed
    disarmItemDelete();
  }

  // If this item is still pending TMDB pick, ensure pick list is (re)shown for it.
  // This allows returning to the choice later, and also works after renaming.
  // NOTE: pick panel must behave like description (not tied to selection),
  // but tapping the pending item can re-trigger search if query changed.
  try {
    const sec = line.dataset.sec, idx = +line.dataset.idx;
    const it = data.sections?.[sec]?.items?.[idx];
    const pickKey = ensureItemHasId(it) || "";
    const title = String(it?.text || "").trim();

    // If this item is still pending TMDB pick, ensure pick list is (re)shown for it.
    // IMPORTANT: use stable item.id (pickKey), NOT `created`.
    if (pickKey && title && TMDB_KEY && isPendingPickCreated(pickKey)) {
      const needsReload = !tmdbAutoPick || String(tmdbAutoPick.pickKey || "") !== pickKey || String(tmdbAutoPick.query || "") !== title;
      if (needsReload) startTmdbAutoPick(pickKey);
    }
  } catch {}

  const clickedAction = !!e.target.closest('[data-action]');
  const clickedButton = !!e.target.closest('button');
  const textEl = e.target.closest('[data-role="text"]');

  // (3) If item title is empty: a single tap on ANY non-button zone starts inline edit.
  if (!clickedAction && !clickedButton) {
    const sec = line.dataset.sec, idx = +line.dataset.idx;
    const item = data.sections?.[sec]?.items?.[idx];
    const empty = !String(item?.text || "").trim();
    if (empty) {
      beginInlineEdit(line, textEl ? (typeof caretOffsetFromEvent(textEl, e) === 'number' ? { caretOffset: caretOffsetFromEvent(textEl, e) } : {}) : {});
      return;
    }
  }

  // Double tap behavior:
  // - on title text: start inline edit (only)
  // - elsewhere on the item (excluding buttons/actions): toggle description (if any)
  if (!clickedAction && !clickedButton) {
    const now = Date.now();
    const sameKey = lastItemTap.key === key;
    const fast = (now - lastItemTap.at) <= 350;

    if (sameKey && fast) {
      lastItemTap = { key: null, at: 0 };
      const sec = line.dataset.sec, idx = +line.dataset.idx;
      const item = data.sections?.[sec]?.items?.[idx];

      // Ensure selected
      if (selectedKey !== key) {
        selectedKey = key;
        localStorage.setItem('selected_key', selectedKey);
        document.querySelectorAll('#viewMode .item-line.selected').forEach(el => el.classList.remove('selected'));
        line.classList.add('selected');
      }

      if (textEl) {
        // Start inline edit with caret at click position
        const caretOffset = caretOffsetFromEvent(textEl, e);
        beginInlineEdit(line, (typeof caretOffset === 'number') ? { caretOffset } : {});
        return;
      }

      // Double tap elsewhere:
      // - if TMDB pick is currently open for this item, close it
      // - else toggle description (if any)
      const pickKey = ensureItemHasId(item) || "";
      const isPickOpen = !!(tmdbAutoPick && tmdbAutoPick.key === key && pickKey && isPendingPickCreated(pickKey));
      if (isPickOpen) {
        // Closing the pick panel resolves the item: it is no longer treated as "new".
        if (pickKey) removePendingPickCreated(pickKey);
        tmdbAutoPick = null;
        render();
        return;
      }

      if (item?.desc) {
        closeTagEditor();
        toggleDescExpand(sec, idx);
      }
    } else {
      lastItemTap = { key, at: now };
    }
  }
});

// Persist scroll position (normal mode only)
window.addEventListener("scroll", () => {
  if (document.body.classList.contains("editing")) return;
  if (restoringUI) return; // don't overwrite while restoring
  localStorage.setItem("scroll_y", String(window.scrollY || 0));
}, { passive: true });

// Also persist scroll on unload (more reliable on mobile)
window.addEventListener("beforeunload", () => {
  if (!document.body.classList.contains("editing")) {
    localStorage.setItem("scroll_y", String(window.scrollY || 0));
  }
});

document.addEventListener("click", e => {
  // Commit inline edit on any outside click
  // IMPORTANT: ignore the same click that just started inline edit (iOS Safari keyboard/focus fix).
  if (inlineEdit.active) {
    if (!ignoreOutsideCommitOnce) {
      const inside = e.target === inlineEdit.el || e.target.closest('[data-role="text"]') === inlineEdit.el;
      if (!inside) commitInlineEdit();
    }
  }

  // Commit section rename if user clicked outside the section name
  if (sectionRename.active) {
    const nameEl = $("currentSectionName");
    const insideName = (e.target === nameEl) || e.target.closest('#currentSectionName') === nameEl;
    if (!insideName) {
      // Trigger blur -> commit
      nameEl?.blur();
    }
  }

  if (!e.target.closest(".dropdown-menu") && !e.target.closest(".icon-btn") && !e.target.closest(".section-btn") && !e.target.closest(".view-toggle") && !e.target.closest(".search-toggle-btn")) {
    closeAllMenus();
    closeMoveMenu();
    sortMenuOpen = false; localStorage.setItem("sort_menu_open", "0");
    disarmSectionDelete();
    renderSectionList();
  }
});

function parseItemKey(key) {
  if (!key) return null;
  const s = String(key);
  const i = s.lastIndexOf("|");
  if (i < 0) return null;
  const secKey = s.slice(0, i);
  const idx = Number(s.slice(i + 1));
  if (!secKey || !Number.isInteger(idx) || idx < 0) return null;
  return { secKey, idx };
}

function keyExistsInData(key) {
  const p = parseItemKey(key);
  if (!p) return false;
  return !!data.sections?.[p.secKey]?.items?.[p.idx];
}

// ===== Move item to section =====
let moveCtx = null; // { secKey, idx }

function openMoveMenu(secKey, idx, anchorEl) {
  if (isEditing || savingInProgress) return;
  const item = data.sections?.[secKey]?.items?.[idx];
  if (!item) return;

  // Close any other open menus first
  closeAllMenus();
  closeMoveMenu();

  // Set context AFTER closeMoveMenu(), otherwise it would be wiped.
  moveCtx = { secKey, idx };

  const menu = $("moveMenu");
  const list = $("moveSectionList");
  const input = $("moveNewInput");
  const okBtn = $("moveNewOkBtn");

  // Build section buttons (exclude __all__)
  const keys = Object.keys(data.sections);
  list.innerHTML = keys.map(k => {
    const isCurrent = k === secKey;
    return `<button class="move-section-btn ${isCurrent ? "current" : ""}" type="button" data-move-to="${escQ(k)}">${esc(k)}</button>`;
  }).join("");

  list.querySelectorAll("[data-move-to]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const targetSec = btn.dataset.moveTo;
      if (targetSec === secKey) {
        // Same section — do nothing
        closeMoveMenu();
        return;
      }
      moveItemToSection(secKey, idx, targetSec);
    };
  });

  // Input + OK button state
  const updateOk = () => {
    const name = sanitizeSectionName(input.value);
    const enabled = !!name;
    if (okBtn) {
      okBtn.disabled = !enabled;
      okBtn.classList.toggle("disabled", !enabled);
    }
  };

  input.value = "";
  updateOk();

  input.oninput = () => updateOk();
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Only act if non-empty
      if (sanitizeSectionName(input.value)) confirmMoveToNewSection();
    }
    else if (e.key === "Escape") { e.preventDefault(); closeMoveMenu(); }
  };

  // Position menu near anchor
  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";

  const container = $("container");
  const cR = container.getBoundingClientRect();
  const aR = anchorEl.getBoundingClientRect();
  const mR = menu.getBoundingClientRect();

  const top = (aR.bottom - cR.top) + 8;
  let left = (aR.left - cR.left) + (aR.width / 2) - (mR.width / 2);
  left = Math.max(8, Math.min(left, cR.width - mR.width - 8));

  menu.style.position = "absolute";
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = "visible";
}

function closeMoveMenu() {
  moveCtx = null;
  const menu = $("moveMenu");
  if (menu) menu.classList.add("hidden");
}

function confirmMoveToNewSection() {
  if (!moveCtx) return;
  const input = $("moveNewInput");
  const newSecName = sanitizeSectionName(input.value);
  // If empty — do nothing (OK button should be disabled anyway)
  if (!newSecName) {
    input?.focus();
    return;
  }

  const { secKey, idx } = moveCtx;

  // If new section name equals current — do nothing
  if (newSecName === secKey) {
    closeMoveMenu();
    return;
  }

  // Create section if needed
  if (!data.sections[newSecName]) {
    data.sections[newSecName] = { items: [], modified: new Date().toISOString() };
    renderSectionList();
  }

  moveItemToSection(secKey, idx, newSecName);
}

function moveItemToSection(fromSec, idx, toSec) {
  const fromArr = data.sections[fromSec]?.items;
  if (!fromArr || !fromArr[idx]) { closeMoveMenu(); return; }
  if (fromSec === toSec) { closeMoveMenu(); return; }

  const item = fromArr[idx];
  const itemCopy = JSON.parse(JSON.stringify(item));
  const pickKey = ensureItemHasId(item) || "";

  // If TMDB pick panel is open for this item — close it like description does.
  // Also resolve "new" state: moving to another section is a deliberate action.
  if (pickKey) {
    if (tmdbAutoPick && String(tmdbAutoPick.pickKey || "") === pickKey) tmdbAutoPick = null;
    removePendingPickCreated(pickKey);
  }

  // Remove from source
  fromArr.splice(idx, 1);
  data.sections[fromSec].modified = new Date().toISOString();

  // Add to target (at end)
  if (!data.sections[toSec]) {
    data.sections[toSec] = { items: [], modified: new Date().toISOString() };
  }
  const toArr = data.sections[toSec].items;
  const newIdx = toArr.length;
  toArr.push(item);
  data.sections[toSec].modified = new Date().toISOString();

  // Clear selection/expanded if they pointed to moved item
  const oldKey = `${fromSec}|${idx}`;
  if (selectedKey === oldKey) {
    selectedKey = null;
    localStorage.removeItem("selected_key");
  }
  if (expandedDescKey === oldKey) {
    expandedDescKey = null;
    localStorage.removeItem("expanded_desc_key");
  }

  closeMoveMenu();
  saveData();
  renderSectionList();
  render();

  // Undo
  startUndo({
    type: "moveItem",
    fromSec,
    fromIdx: idx,
    toSec,
    toIdx: newIdx,
    item: itemCopy
  }, `Перенесено в: ${toSec}`);
}

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressTarget = null;
}

// ===== Add new item (bottom +) =====
async function fetchTmdbForSingleItem(secKey, idx) {
  if (!TMDB_KEY) return;
  const item = data.sections?.[secKey]?.items?.[idx];
  if (!item) return;

  // Only load if there is some title text
  const title = String(item.text || "").trim();
  if (!title) return;

  showProgress("Загрузка данных...", 60);

  try {
    const { genres, overview, poster, originalTitle, year, rating, votes, tmdbType, seasons, episodes, firstAirDate, lastAirDate, inProduction } = await fetchTmdbDataForItem(title);
    let updated = false;

    // Normalize/additions to title
    const nextTitle = buildTitleUpdate(item.text, originalTitle, year);
    if (nextTitle) { item.text = nextTitle; updated = true; }

    if (genres.length) {
      const existing = new Set((item.tags || []).map(normTag));
      const newTags = genres.filter(g => !existing.has(normTag(g)) && normTag(g) !== VIEWED_TAG);
      if (newTags.length) {
        item.tags = uniqueTags([...(item.tags || []), ...newTags]);
        item.tags = normalizeAnimeTags(item.tags);
        updated = true;
      } else {
        const before = JSON.stringify(uniqueTags(item.tags || []));
        const afterArr = normalizeAnimeTags(item.tags || []);
        const after = JSON.stringify(afterArr);
        if (before !== after) {
          item.tags = afterArr;
          updated = true;
        }
      }
    }

    // Serial tag + TV meta
    if (tmdbType === "tv") {
      const hasSerialTag = (item.tags || []).some(t => normTag(t) === "сериал");
      if (!hasSerialTag) {
        const viewedIdx = (item.tags || []).indexOf(VIEWED_TAG);
        if (viewedIdx >= 0) item.tags.splice(viewedIdx + 1, 0, "сериал");
        else item.tags = ["сериал", ...(item.tags || [])];
        item.tags = uniqueTags(item.tags);
        updated = true;
      }

      if (seasons != null && item.seasons == null) { item.seasons = seasons; updated = true; }
      if (episodes != null && item.episodes == null) { item.episodes = episodes; updated = true; }
      if (firstAirDate && !item.firstAirDate) { item.firstAirDate = firstAirDate; updated = true; }
      if (lastAirDate && !item.lastAirDate) { item.lastAirDate = lastAirDate; updated = true; }
      if (inProduction != null && item.inProduction == null) { item.inProduction = inProduction; updated = true; }
      if (!item.year && firstAirDate) { item.year = String(firstAirDate).slice(0, 4); updated = true; }
    }

    if (overview && !item.desc) { item.desc = overview; updated = true; }
    if (poster && !item.poster) { item.poster = poster; updated = true; }
    if (rating != null && item.rating == null) { item.rating = rating; updated = true; }
    if (votes != null && item.votes == null) { item.votes = votes; updated = true; }
    if (tmdbType && !item.tmdbType) { item.tmdbType = tmdbType; updated = true; }
    if (year && !item.year) { item.year = String(year); updated = true; }

    if (updated) {
      data.sections[secKey].modified = new Date().toISOString();
      showProgress("Сохранение данных...", 90);
      await saveData();
    }

    showProgress("Готово", 100);
    setTimeout(hideProgress, 500);
    render();

  } catch {
    showProgress("Ошибка", 100);
    setTimeout(hideProgress, 1200);
  }
}

function addNewItem() {
  if (isEditing || savingInProgress) return;
  if (currentSection === "__all__") return;
  if (!data.sections[currentSection]) data.sections[currentSection] = { items: [], modified: new Date().toISOString() };

  normalizeDataModel();

  const sec = data.sections[currentSection];
  const newItem = { id: genItemId(), text: "", tags: [], created: new Date().toISOString() };
  const idx = sec.items.length;
  sec.items.push(newItem);
  sec.modified = new Date().toISOString();

  // Save immediately so undo/refresh won't lose it
  saveData();

  // Ensure it is visible by clearing filters (otherwise inline edit element won't exist)
  if (filterQuery) {
    filterQuery = "";
    localStorage.setItem("filter_query", "");
    $("filterInput").value = $("mobileFilterInput").value = "";
    $("filterClear").classList.add("hidden");
    $("mobileFilterClear").classList.add("hidden");
    updateSearchBtnUI();
  }

  // For tag filters: clear them so the empty item is not hidden
  if (tagFilter.size || tagFilterExcluded.size || ratingFilter != null) {
    tagFilter = new Set();
    tagFilterExcluded = new Set();
    ratingFilter = null;
    saveTagFilter();
    saveRatingFilter();
    updateTagFilterBtnUI();
  }

  // Ensure viewed filter is not "only" (new item has no viewed tag)
  if (viewedFilter === "only") {
    viewedFilter = "show";
    localStorage.setItem("viewed_filter", viewedFilter);
    updateViewedToggleUI();
  }

  const key = `${currentSection}|${idx}`;
  selectedKey = key;
  localStorage.setItem("selected_key", selectedKey);

  // Mark this item as pending TMDB pick (choice list will be shown after first commit)
  // Use stable identifier (item.id) to avoid any index/sort/filter issues.
  addPendingPickCreated(String(newItem.id));

  // Cleanup legacy keys (older builds)
  localStorage.removeItem("pending_tmdb_created");
  localStorage.removeItem("pending_tmdb_for");

  // Render immediately so the new DOM node exists
  render();

  // iOS Safari: to show keyboard, focus must happen as close as possible to the user gesture.
  // So we start inline edit synchronously (no rAF). If element isn't in DOM yet, fallback to rAF.
  const line = document.querySelector(`#viewMode .item-line[data-key="${CSS.escape(key)}"]`);
  if (line) {
    try { line.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
    beginInlineEdit(line);
  } else {
    requestAnimationFrame(() => {
      const line2 = document.querySelector(`#viewMode .item-line[data-key="${CSS.escape(key)}"]`);
      if (line2) {
        try { line2.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
        beginInlineEdit(line2);
      }
    });
  }
}

// ===== Utils =====
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;"); }
function escQ(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

// Expose
Object.assign(window, { toggleSectionMenu, cycleViewedFilter, clearFilter, toggleSort, setSortKey, toggleEdit, cancelEdit, saveEdit, toggleSettingsPanel, saveSettings, copyShareLink, selectSection, showNewSectionInput, handleNewSection, handleSectionDelete, toggleTagFilterMenu, clearTagFilter, closeTagEditor, handleTagAdd, addTagFromInput, clearTagsForCurrentItem, toggleMobileSearch, fetchTmdbTags, cycleTmdbMode, beginSectionRename, confirmMoveToNewSection, closeMoveMenu, addNewItem });

// Ensure "+" click runs in a real user gesture (iOS keyboard reliability)
try {
  const btn = $("addItemBtn");
  if (btn && !btn.__wired) {
    btn.__wired = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addNewItem();
    });
  }
} catch {}

init();
