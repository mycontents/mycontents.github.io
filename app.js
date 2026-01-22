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

let data = { sections: {} };
let isEditing = false;
let selectedKey = null;
let editCtx = null;
let tagEditorCtx = null;
let mobileSearchOpen = false;

let pointer = { down: false, startX: 0, startY: 0, moved: false, startedAt: 0 };
let deleteArmSection = null, deleteArmSectionTimer = null;
let deleteArmItemKey = null, deleteArmItemTimer = null;
let undoTimer = null, undoPayload = null;
let savingEdit = false;

// TMDB genre cache
let tmdbGenres = null;

const $ = (id) => document.getElementById(id);

// ===== Init =====
async function init() {
  applyUrlSetup();
  setupFilterUI();
  updateViewedToggleUI();
  updateTagFilterBtnUI();
  updateSearchBtnUI();
  updateShareButton();
  updateTmdbBtnVisibility();

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
      history.replaceState({}, "", location.pathname);
    }
  } catch {}
}

// ===== Data model =====
function normalizeDataModel() {
  if (!data?.sections) data = { sections: {} };
  for (const key of Object.keys(data.sections)) {
    let sec = data.sections[key];
    if (!sec || typeof sec !== "object") sec = { items: [], modified: new Date().toISOString() };
    if (!Array.isArray(sec.items)) sec.items = [];
    if (!sec.modified) sec.modified = new Date().toISOString();
    sec.items = sec.items.map(it => {
      if (it && typeof it === "object" && typeof it.text === "string") {
        it.tags = uniqueTags(it.tags);
        if (!it.created) it.created = sec.modified;
        return it;
      }
      return { text: String(it ?? ""), tags: [], created: sec.modified };
    });
    data.sections[key] = sec;
  }
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

function parseTitleForSearch(text) {
  const yearMatch = text.match(/\((\d{4})\)/);
  const year = yearMatch ? yearMatch[1] : null;
  let clean = text.replace(/\(\d{4}\)/, "").trim();
  const parts = clean.split(/\s*\/\s*/).map(p => p.trim()).filter(Boolean);
  return { names: parts.length ? parts : [clean], year };
}

async function searchTmdb(query, year, type) {
  if (!TMDB_KEY) return null;
  const params = new URLSearchParams({ api_key: TMDB_KEY, query, language: "ru" });
  if (year) {
    params.set(type === "movie" ? "year" : "first_air_date_year", year);
  }
  try {
    const res = await fetch(`${TMDB_BASE}/search/${type}?${params}`);
    const data = await res.json();
    return data.results?.[0] || null;
  } catch { return null; }
}

const TMDB_IMG = "https://image.tmdb.org/t/p/w300";

async function fetchTmdbDataForItem(text) {
  const genres = await loadTmdbGenres();
  if (!genres) return { genres: [], overview: null, poster: null };
  
  const { names, year } = parseTitleForSearch(text);
  
  const trySearch = async (name, y) => {
    let result = await searchTmdb(name, y, "movie");
    if (result?.genre_ids?.length) return result;
    result = await searchTmdb(name, y, "tv");
    if (result?.genre_ids?.length) return result;
    return null;
  };
  
  for (const name of names) {
    const result = await trySearch(name, year);
    if (result) {
      return {
        genres: result.genre_ids.map(id => genres.get(id)).filter(Boolean),
        overview: result.overview || null,
        poster: result.poster_path ? TMDB_IMG + result.poster_path : null
      };
    }
  }
  
  if (year) {
    for (const name of names) {
      const result = await trySearch(name, null);
      if (result) {
        return {
          genres: result.genre_ids.map(id => genres.get(id)).filter(Boolean),
          overview: result.overview || null,
          poster: result.poster_path ? TMDB_IMG + result.poster_path : null
        };
      }
    }
  }
  
  return { genres: [], overview: null, poster: null };
}

async function fetchTmdbTags() {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  if (!TMDB_KEY) { alert("TMDB API Key не задан. Добавьте его в настройках подключения."); return; }
  
  const btn = $("tmdbBtn");
  btn.classList.add("loading");
  btn.classList.remove("success", "error");
  
  try {
    const { genres, overview, poster } = await fetchTmdbDataForItem(item.text);
    let updated = false;
    
    if (genres.length) {
      const existing = new Set(item.tags.map(normTag));
      const newTags = genres.filter(g => !existing.has(normTag(g)));
      if (newTags.length) {
        item.tags = uniqueTags([...item.tags, ...newTags]);
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
    
    if (updated) {
      data.sections[tagEditorCtx.secKey].modified = new Date().toISOString();
      saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
      btn.classList.add("success");
    } else if (genres.length || overview || poster) {
      btn.classList.add("success");
    } else {
      btn.classList.add("error");
    }
  } catch {
    btn.classList.add("error");
  } finally {
    btn.classList.remove("loading");
    setTimeout(() => btn.classList.remove("success", "error"), 2000);
  }
}

function updateTmdbBtnVisibility() {
  const btn = $("tmdbBtn");
  if (btn) btn.style.display = TMDB_KEY ? "grid" : "none";
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
    selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); render();
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
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); render();
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
function saveTagFilter() { localStorage.setItem("tag_filter", JSON.stringify([...tagFilter])); }
function updateTagFilterBtnUI() { $("tagFilterBtn")?.classList.toggle("on", tagFilter.size > 0); }

function toggleTagFilterMenu() {
  if (isEditing) return;
  const menu = $("tagFilterMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  renderTagFilterMenu();
  openMenu("tagFilterMenu", $("tagFilterBtn"), "right");
}

function renderTagFilterMenu() {
  const list = $("tagFilterList"), hint = $("tagFilterHint");
  const counts = new Map();
  for (const sec of Object.values(data.sections)) {
    for (const it of sec.items || []) {
      for (const t of displayTags(it)) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, "ru"));
  if (!tags.length) { list.innerHTML = `<div class="tag-empty">Тегов нет</div>`; hint.textContent = ""; return; }

  list.innerHTML = tags.map(t => `
    <div class="tag-option ${tagFilter.has(t) ? "on" : ""}" data-tag="${esc(t)}">
      <span class="tag-check"><svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-check"></use></svg></span>
      <span class="tag-name">${esc(t)}</span>
      <span class="tag-count">${counts.get(t)}</span>
    </div>`).join("");

  list.querySelectorAll(".tag-option").forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); toggleTagFilterItem(el.dataset.tag); };
  });
  hint.textContent = tagFilter.size ? `Выбрано: ${tagFilter.size}` : "";
}

function toggleTagFilterItem(tag) {
  const t = normTag(tag);
  if (!t || t === VIEWED_TAG) return;
  tagFilter.has(t) ? tagFilter.delete(t) : tagFilter.add(t);
  saveTagFilter(); updateTagFilterBtnUI();
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu();
  renderTagFilterMenu(); render();
}

function clearTagFilter() {
  tagFilter = new Set();
  saveTagFilter(); updateTagFilterBtnUI();
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu();
  renderTagFilterMenu(); render();
}

// ===== Tag editor =====
function openTagEditor(secKey, idx, anchor) {
  if (isEditing) return;
  const sec = data.sections[secKey];
  if (!sec?.items?.[idx]) return;
  tagEditorCtx = { secKey, idx };
  $("tagEditorTitle").textContent = `Теги`;
  $("tagAddInput").value = "";
  updateTmdbBtnVisibility();
  renderTagEditorList();
  openMenu("tagEditorMenu", anchor, "right");
  $("tagAddInput").focus();
}

function closeTagEditor() { tagEditorCtx = null; $("tagEditorMenu").classList.add("hidden"); }

function getEditorItem() {
  if (!tagEditorCtx) return null;
  return data.sections?.[tagEditorCtx.secKey]?.items?.[tagEditorCtx.idx];
}

function renderTagEditorList() {
  const list = $("tagEditorList"), item = getEditorItem();
  if (!item) { list.innerHTML = ""; return; }
  const tags = displayTags(item).sort((a, b) => a.localeCompare(b, "ru"));
  if (!tags.length) { list.innerHTML = `<div class="tag-empty">Нет тегов</div>`; return; }

  list.innerHTML = tags.map(t => `
    <div class="tag-pill">
      <input type="text" class="tag-pill-text" value="${esc(t)}" data-tag="${esc(t)}" />
      <button class="mini-btn danger" data-rm="${esc(t)}">×</button>
    </div>`).join("");

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
  item.tags = uniqueTags([...item.tags, t]);
  data.sections[tagEditorCtx.secKey].modified = new Date().toISOString();
  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
}

function removeTagWithUndo(tag) {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  const t = normTag(tag);
  if (!t || t === VIEWED_TAG) return;
  const oldTags = [...item.tags];
  item.tags = uniqueTags(item.tags.filter(x => normTag(x) !== t));
  const { secKey, idx } = tagEditorCtx;
  data.sections[secKey].modified = new Date().toISOString();
  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
  startUndo({ type: "tag", secKey, idx, oldTags }, `Тег удалён: ${t}`);
}

function clearTagsForCurrentItem() {
  const item = getEditorItem();
  if (!item || !tagEditorCtx) return;
  const oldTags = [...item.tags];
  const wasViewed = isViewed(item);
  item.tags = wasViewed ? [VIEWED_TAG] : [];
  const { secKey, idx } = tagEditorCtx;
  data.sections[secKey].modified = new Date().toISOString();
  saveData(); render(); renderTagEditorList(); renderTagFilterMenu();
  if (oldTags.filter(t => t !== VIEWED_TAG).length) startUndo({ type: "tagClear", secKey, idx, oldTags }, "Теги очищены");
}

// ===== Description menu =====
function openDescMenu(secKey, idx, anchor) {
  const sec = data.sections[secKey];
  if (!sec?.items?.[idx]) return;
  const item = sec.items[idx];
  if (!item.desc) return;
  
  // Set poster
  const posterEl = $("descPoster");
  if (item.poster) {
    posterEl.src = item.poster;
    posterEl.classList.remove("hidden");
  } else {
    posterEl.src = "";
    posterEl.classList.add("hidden");
  }
  
  $("descContent").textContent = item.desc;
  
  // Position menu under the item line, aligned to right edge
  const line = anchor.closest(".item-line");
  if (line) {
    openMenuUnderElement("descMenu", line);
  } else {
    openMenu("descMenu", anchor, "right");
  }
}

function openMenuUnderElement(menuId, element) {
  closeAllMenus(menuId);
  const menu = $(menuId), cont = $("container");
  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";
  
  const cR = cont.getBoundingClientRect();
  const eR = element.getBoundingClientRect();
  const mR = menu.getBoundingClientRect();
  
  const top = eR.bottom - cR.top + 4;
  let left = eR.right - cR.left - mR.width;
  left = Math.max(0, Math.min(left, cR.width - mR.width));
  
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = "visible";
}

function closeDescMenu() { $("descMenu").classList.add("hidden"); }

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
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu();
  updateViewedToggleUI(); render();
}

// ===== Menu =====
function openMenu(menuId, anchor, align = "left") {
  closeAllMenus(menuId);
  const menu = $(menuId), cont = $("container");
  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";
  const cR = cont.getBoundingClientRect(), aR = anchor.getBoundingClientRect(), mR = menu.getBoundingClientRect();
  const top = aR.bottom - cR.top + 8;
  let left = align === "right" ? aR.right - cR.left - mR.width : aR.left - cR.left;
  left = Math.max(0, Math.min(left, cR.width - mR.width));
  menu.style.top = `${top}px`; menu.style.left = `${left}px`; menu.style.visibility = "visible";
}

function closeAllMenus(except) {
  ["sortMenu", "sectionMenu", "tagFilterMenu", "tagEditorMenu", "descMenu"].forEach(id => { if (id !== except) $(id)?.classList.add("hidden"); });
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
  const menu = $("sectionMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); $("newSectionInput").classList.add("hidden"); $("settingsPanel").classList.add("hidden"); disarmSectionDelete(); return; }
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
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); disarmSectionDelete();
  updateSectionButton(); $("sectionMenu").classList.add("hidden"); $("settingsPanel").classList.add("hidden"); render();
}

function updateSectionButton() { $("currentSectionName").textContent = currentSection === "__all__" ? "Все" : currentSection; }

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
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  openMenu("sortMenu", $("sortBtn"), "right"); updateSortMenuUI();
}

function setSortKey(key) {
  if (key === "manual") sortState = { key: "manual", dir: "desc" };
  else if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  else sortState = { key, dir: key === "alpha" ? "asc" : "desc" };
  localStorage.setItem("sort_state", `${sortState.key}:${sortState.dir}`);
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu();
  updateSortMenuUI(); $("sortMenu").classList.add("hidden"); render();
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
  }
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null; undoPayload = null; hideUndo();
};

// ===== Item actions =====
function toggleItemViewed(secKey, idx) {
  const sec = data.sections[secKey];
  if (!sec?.items?.[idx]) return;
  const item = sec.items[idx], was = isViewed(item);
  setViewed(item, !was);
  sec.modified = new Date().toISOString();
  selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu();
  saveData(); render();
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
  if (savingEdit) return;
  isEditing ? cancelEdit() : startEdit();
}

function matchFilters(item) {
  const q = filterQuery.trim().toLowerCase();
  if (q && !String(item.text).toLowerCase().includes(q)) return false;
  if (tagFilter.size && !displayTags(item).some(t => tagFilter.has(t))) return false;
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
  adjustEditHeight();
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
  if (savingEdit) return;
  if (window.visualViewport) {
    window.visualViewport.removeEventListener("resize", adjustEditHeight);
    window.visualViewport.removeEventListener("scroll", adjustEditHeight);
  }
  document.body.style.height = "";
  isEditing = false; editCtx = null; setFilterLock(false);
  document.body.classList.remove("editing");
  $("viewMode").classList.remove("hidden"); $("editMode").classList.add("hidden"); $("editHint").classList.add("hidden");
  $("editUse").setAttribute("href", `${ICONS}#i-pencil`);
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
  if (savingEdit) return;
  if (!editCtx || !isEditing) return;
  savingEdit = true;

  const btns = document.querySelectorAll("#editMode .edit-panel button");
  btns.forEach(b => (b.disabled = true));

  try {
    const lines = $("editor").value.split("\n").map(s => s.trim()).filter(Boolean);
    normalizeDataModel();

    if (editCtx.mode === "section") {
      const orig = data.sections[editCtx.secKey]?.items || [];
      data.sections[editCtx.secKey] = { items: mergeByMask(orig, editCtx.mask, lines), modified: new Date().toISOString() };
    } else {
      const newBy = parseAllLines(lines);
      for (const key of new Set([...Object.keys(data.sections), ...Object.keys(newBy)])) {
        const orig = data.sections[key]?.items || [];
        const mask = editCtx.masks[key] || new Array(orig.length).fill(false);
        const merged = mergeByMask(orig, mask, newBy[key] || []);
        if (!data.sections[key]) data.sections[key] = { items: [], modified: new Date().toISOString() };
        data.sections[key].items = merged;
        data.sections[key].modified = new Date().toISOString();
      }
    }

    await saveData();
    renderSectionList();
  } finally {
    btns.forEach(b => (b.disabled = false));
    savingEdit = false;
    cancelEdit();
    render();
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
  if (tagFilter.size) items = items.filter(x => displayTags(x.item).some(t => tagFilter.has(t)));
  items = items.filter(x => {
    const v = isViewed(x.item);
    if (viewedFilter === "hide") return !v;
    if (viewedFilter === "only") return v;
    return true;
  });
  return sortItems(items);
}

function render() {
  const view = $("viewMode"), items = buildItems();
  updateTagFilterBtnUI();
  if (!items.length) { view.innerHTML = ""; updateCounter(0); return; }

  const keySet = new Set(items.map(x => `${x.secKey}|${x.idx}`));
  if (selectedKey && !keySet.has(selectedKey)) { selectedKey = null; disarmItemDelete(); closeTagEditor(); closeDescMenu(); }

  view.innerHTML = items.map(x => {
    const key = `${x.secKey}|${x.idx}`, sel = selectedKey === key, viewed = isViewed(x.item);
    const hasDesc = !!x.item.desc;
    const secTag = currentSection === "__all__" ? `<span class="item-section-tag">${esc(x.secKey)}</span>` : "";
    const tags = displayTags(x.item).sort((a, b) => a.localeCompare(b, "ru"));
    const tagsHtml = tags.length ? `<span class="item-tags">${tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join("")}</span>` : "";

    // Description button: only render if has description (will be shown only when selected via CSS)
    const descBtn = hasDesc
      ? `<button class="desc-action has-desc" data-action="desc"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-doc"></use></svg></button>`
      : "";

    let viewedBtn;
    if (viewed) {
      const icon = sel ? "i-eye-off" : "i-eye";
      viewedBtn = `<button class="viewed-action is-viewed" data-action="toggle-viewed"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#${icon}"></use></svg></button>`;
    } else {
      viewedBtn = `<button class="viewed-action not-viewed" data-action="toggle-viewed"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-eye"></use></svg></button>`;
    }

    return `
      <div class="item-line ${sel ? "selected" : ""} ${deleteArmItemKey === key ? "del-armed" : ""}" data-key="${esc(key)}" data-sec="${esc(x.secKey)}" data-idx="${x.idx}">
        <button class="item-del" data-action="del"><svg class="icon small" viewBox="0 0 16 16"><use href="${ICONS}#i-x"></use></svg></button>
        ${secTag}
        <div class="item-main"><span class="item-text">${esc(x.text)}</span>${tagsHtml}</div>
        ${descBtn}
        <button class="tag-action" data-action="tags"><svg class="icon" viewBox="0 0 16 16"><use href="${ICONS}#i-tag"></use></svg></button>
        ${viewedBtn}
      </div>`;
  }).join("");
  updateCounter(items.length);
}

function updateCounter(n) {
  const text = String(n);
  $("filterCounter").textContent = text;
  $("mobileFilterCounter").textContent = text;
}

// ===== Interactions =====
$("viewMode").addEventListener("pointerdown", e => { if (isEditing) return; pointer = { down: true, moved: false, startX: e.clientX, startY: e.clientY, startedAt: Date.now() }; });
$("viewMode").addEventListener("pointermove", e => { if (pointer.down && Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > 10) pointer.moved = true; });
$("viewMode").addEventListener("pointerup", () => { pointer.down = false; });

$("viewMode").addEventListener("click", e => {
  if (isEditing) return;
  const line = e.target.closest(".item-line");
  if (!line) return;
  const act = e.target.closest("[data-action]");
  if (act) {
    e.stopPropagation();
    const a = act.dataset.action, sec = line.dataset.sec, idx = +line.dataset.idx, key = line.dataset.key;
    if (a === "toggle-viewed") { toggleItemViewed(sec, idx); return; }
    if (a === "desc") { if (selectedKey !== key) { selectedKey = key; disarmItemDelete(); closeTagEditor(); render(); } openDescMenu(sec, idx, act); return; }
    if (a === "tags") { if (selectedKey !== key) { selectedKey = key; disarmItemDelete(); closeDescMenu(); render(); } openTagEditor(sec, idx, act); return; }
    if (a === "del") {
      if (selectedKey !== key) { selectedKey = key; disarmItemDelete(); closeTagEditor(); closeDescMenu(); render(); armItemDelete(key); return; }
      if (deleteArmItemKey === key) { deleteItemNow(sec, idx); return; }
      armItemDelete(key); return;
    }
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  if (pointer.startedAt && Date.now() - pointer.startedAt > 350) return;
  if (pointer.moved) return;
  const key = line.dataset.key;
  selectedKey = selectedKey === key ? null : key;
  disarmItemDelete(); closeTagEditor(); closeDescMenu();
  document.querySelectorAll("#viewMode .item-line.selected").forEach(el => el.classList.remove("selected"));
  if (selectedKey) line.classList.add("selected");
});

document.addEventListener("click", e => {
  if (!e.target.closest(".dropdown-menu") && !e.target.closest(".icon-btn") && !e.target.closest(".section-btn") && !e.target.closest(".view-toggle") && !e.target.closest(".search-toggle-btn")) {
    closeAllMenus(); disarmSectionDelete(); renderSectionList();
  }
});

// ===== Utils =====
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function escQ(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

// Expose
Object.assign(window, { toggleSectionMenu, cycleViewedFilter, clearFilter, toggleSort, setSortKey, toggleEdit, cancelEdit, saveEdit, toggleSettingsPanel, saveSettings, copyShareLink, selectSection, showNewSectionInput, handleNewSection, handleSectionDelete, toggleTagFilterMenu, clearTagFilter, closeTagEditor, handleTagAdd, addTagFromInput, clearTagsForCurrentItem, toggleMobileSearch, fetchTmdbTags, closeDescMenu });

init();
