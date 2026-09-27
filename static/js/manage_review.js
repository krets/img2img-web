// Review tab of the management page: a paged result gallery across the
// selected projects, driven by POST /api/manage/results (ManageFilterIn).

import { api } from "./api.js";
import { escapeHtml, formatRelativeTime, parseDbTime, openModal, closeModal, isModalOpen } from "./ui.js";
import { initABViewer } from "./viewer.js";

const FILTER_KEY = "grok_img2img.manage.reviewFilter";
const PAGE_SIZE = 120;
const EVALUATIONS = ["YES", "MAYBE", "NO", "UNRATED"];
const SORTS = { date_desc: "Newest first", date_asc: "Oldest first", project: "By library", evaluation: "By rating" };
const DEFAULT_FILTER = { evaluations: [...EVALUATIONS], active_only: false, dedupe_copies: true, sort: "date_desc" };

// Gallery display, saved separately from the filter. `compare` uses the names
// reports will store as display_json.compare.
const DISPLAY_KEY = "grok_img2img.manage.reviewDisplay";
const COMPARE_MODES = {
  result_only: "Result",
  side_by_side: "Side by side",
  reveal: "Hold to reveal source",
};
// Tile edge in px. S uses the stored 80px square thumbnails; M and L the
// aspect-preserving previews, which stay sharp at that size.
const TILE_SIZES = { S: 88, M: 180, L: 280 };
const HOLD_MS = 180; // press longer than this in reveal mode to show the source instead of opening

function loadFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
    const f = { ...DEFAULT_FILTER, ...saved };
    f.evaluations = EVALUATIONS.filter((e) => f.evaluations.includes(e));
    if (!SORTS[f.sort]) f.sort = DEFAULT_FILTER.sort;
    return f;
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

const view = {
  filter: loadFilter(),
  display: loadDisplay(),
  hoverIdx: null, // tile under the pointer, the target of Y/M/N in the gallery
  lightboxIdx: null, // item shown in the lightbox while it's open
  prompt: null, // { hash, label } set from the Prompts tab, or null for all prompts
  report: null, // { id, name } of the saved report this view was opened from
  // Filter fields a report can carry but this tab has no controls for
  // (engines, dates). Applied while the report is attached, dropped after.
  extra: {},
  opts: {}, // renderReviewTab options, kept for re-renders
  projectIds: [],
  items: [],
  total: 0,
  loading: false,
  error: null,
  seq: 0, // bumped on every reset so a slow response for an old filter is dropped
  host: null,
};

function loadDisplay() {
  try {
    const d = { compare: "result_only", size: "S", ...(JSON.parse(localStorage.getItem(DISPLAY_KEY)) || {}) };
    if (!COMPARE_MODES[d.compare]) d.compare = "result_only";
    if (!TILE_SIZES[d.size]) d.size = "S";
    return d;
  } catch {
    return { compare: "result_only", size: "S" };
  }
}

function saveFilter() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(view.filter));
  } catch {
    // storage full/unavailable -- the filter just won't persist
  }
}

function requestBody() {
  const body = { ...view.filter, ...view.extra, project_ids: view.projectIds };
  if (view.prompt) body.prompt_hashes = [view.prompt.hash];
  return body;
}

// The view as a saved report stores it. project_ids / include_archived come
// from the page's library selection (opts.selection): an empty list keeps
// meaning "every library" when the report is run later.
function reportPayload() {
  const sel = view.opts.selection?.() || { project_ids: [], include_archived: false };
  return {
    filter: {
      ...view.filter,
      ...view.extra,
      ...sel,
      prompt_hashes: view.prompt ? [view.prompt.hash] : [],
    },
    display: { ...view.display, ...(view.prompt ? { prompt_label: view.prompt.label } : {}) },
  };
}

// Loads a saved report into the tab (the caller sets the library selection).
export function applyReport(report) {
  const f = report.filter;
  view.filter = {
    evaluations: EVALUATIONS.filter((e) => (f.evaluations?.length ? f.evaluations : EVALUATIONS).includes(e)),
    active_only: !!f.active_only,
    dedupe_copies: f.dedupe_copies !== false,
    sort: SORTS[f.sort] ? f.sort : DEFAULT_FILTER.sort,
  };
  view.extra = {};
  for (const k of ["engines", "date_from", "date_to"]) if (f[k]?.length) view.extra[k] = f[k];
  const hashes = f.prompt_hashes || [];
  view.prompt = hashes.length === 1 ? { hash: hashes[0], label: report.display?.prompt_label || "saved prompt" } : null;
  if (hashes.length > 1) view.extra.prompt_hashes = hashes; // no chip for several; still applied
  if (COMPARE_MODES[report.display?.compare]) view.display.compare = report.display.compare;
  if (TILE_SIZES[report.display?.size]) view.display.size = report.display.size;
  view.report = { id: report.id, name: report.name };
  saveFilter();
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(view.display));
  } catch {
    // ignore
  }
}

function detachReport() {
  view.report = null;
  view.extra = {};
}

function saveReportModal() {
  const modal = openModal(`
    <h3>Save as report</h3>
    <p class="modal-note">Saves the libraries, filters and display. Opening it later re-runs the filter on the library as it is then.</p>
    <div class="field"><label for="mReportName">Name</label><input id="mReportName" type="text" maxlength="200" /></div>
    <div id="mStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost" type="button">Cancel</button>
      <button id="mSave" class="btn-primary" type="button">Save</button>
    </div>
  `);
  const name = modal.querySelector("#mReportName");
  name.value = view.prompt?.label ? view.prompt.label.slice(0, 80) : "";
  name.focus();
  name.select();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const save = async () => {
    const n = name.value.trim();
    if (!n) return;
    try {
      const report = await api.manage.createReport({ name: n, ...reportPayload() });
      view.report = { id: report.id, name: report.name };
      closeModal();
      renderReviewTab(view.host, view.projectIds, view.opts);
    } catch (err) {
      modal.querySelector("#mStatus").textContent = `Save failed: ${err.message}`;
    }
  };
  modal.querySelector("#mSave").addEventListener("click", save);
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

async function saveReportChanges(btn) {
  btn.disabled = true;
  try {
    await api.manage.updateReport(view.report.id, reportPayload());
    btn.textContent = "Saved";
    setTimeout(() => {
      btn.textContent = "Save changes";
      btn.disabled = false;
    }, 1200);
  } catch (err) {
    btn.textContent = "Save failed";
    btn.title = err.message;
    btn.disabled = false;
  }
}

// Narrows the gallery to one prompt group (hash null = results with no
// prompt), as opened from the Prompts tab. Rating and active-only filters are
// cleared so the gallery holds the whole group the report counted. Not
// persisted: a reload shows the unfiltered gallery again.
export function setReviewPrompt(hash, label) {
  detachReport();
  view.prompt = { hash, label };
  view.filter.evaluations = [...EVALUATIONS];
  view.filter.active_only = false;
  saveFilter();
}

// Mounts the tab into host for the given project ids (never empty: an empty
// list would mean "every project" to the endpoint). opts.selection() returns
// the page's library selection as a report stores it.
export function renderReviewTab(host, projectIds, opts = view.opts) {
  view.host = host;
  view.projectIds = projectIds;
  view.opts = opts;
  const f = view.filter;
  host.innerHTML = `
    <div class="review-filters">
      ${
        view.report
          ? `<span class="review-prompt-chip review-report-chip" title="Opened from a saved report">Report: <span class="review-prompt-chip-text">${escapeHtml(view.report.name)}</span><button type="button" id="reviewReportClear" aria-label="Detach report" title="Stop editing this report">×</button></span>
             <button type="button" id="reviewReportSave" class="btn-ghost small" title="Store the current libraries, filters and display in this report">Save changes</button>`
          : ""
      }
      <button type="button" id="reviewReportNew" class="btn-ghost small" title="Save the current view as a named report">${view.report ? "Save as new…" : "Save as report…"}</button>
      ${
        view.prompt
          ? `<span class="review-prompt-chip" title="${escapeHtml(view.prompt.label)}">Prompt: <span class="review-prompt-chip-text">${escapeHtml(view.prompt.label)}</span><button type="button" id="reviewPromptClear" aria-label="Clear prompt filter" title="Show all prompts">×</button></span>`
          : ""
      }
      <div class="review-filter-group" role="group" aria-label="Rating">
        ${EVALUATIONS.map(
          (e) => `<label class="review-eval-toggle ${e}"><input type="checkbox" data-eval="${e}" ${f.evaluations.includes(e) ? "checked" : ""} /> ${e}</label>`
        ).join("")}
      </div>
      <label class="review-filter-check" title="Only the result currently marked active for each source image">
        <input type="checkbox" id="reviewActiveOnly" ${f.active_only ? "checked" : ""} /> Active only
      </label>
      <label class="review-filter-check" title="Show a result copied into several libraries once, as its earliest copy">
        <input type="checkbox" id="reviewDedupe" ${f.dedupe_copies ? "checked" : ""} /> Collapse copies
      </label>
      <select id="reviewSort" aria-label="Sort">
        ${Object.entries(SORTS).map(([v, label]) => `<option value="${v}" ${v === f.sort ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      <span class="review-display">
        <select id="reviewCompare" aria-label="Display">
          ${Object.entries(COMPARE_MODES).map(([v, label]) => `<option value="${v}" ${v === view.display.compare ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <span class="review-size-group" role="group" aria-label="Tile size">
          ${Object.keys(TILE_SIZES).map((k) => `<button type="button" class="btn-ghost small ${k === view.display.size ? "active" : ""}" data-size="${k}" title="Tile size">${k}</button>`).join("")}
        </span>
      </span>
      <span id="reviewCount" class="manage-hint review-count"></span>
    </div>
    <div id="reviewGrid" class="review-grid"></div>
    <div class="review-more"><button id="reviewMoreBtn" class="btn-ghost" type="button" style="display:none">Load more</button></div>
  `;

  host.querySelectorAll("[data-eval]").forEach((cb) => {
    cb.addEventListener("change", () => {
      f.evaluations = EVALUATIONS.filter((e) => host.querySelector(`[data-eval="${e}"]`).checked);
      filterChanged();
    });
  });
  host.querySelector("#reviewActiveOnly").addEventListener("change", (e) => {
    f.active_only = e.target.checked;
    filterChanged();
  });
  host.querySelector("#reviewDedupe").addEventListener("change", (e) => {
    f.dedupe_copies = e.target.checked;
    filterChanged();
  });
  host.querySelector("#reviewSort").addEventListener("change", (e) => {
    f.sort = e.target.value;
    filterChanged();
  });
  host.querySelector("#reviewCompare").addEventListener("change", (e) => {
    view.display.compare = e.target.value;
    displayChanged();
  });
  host.querySelectorAll("[data-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      view.display.size = btn.dataset.size;
      host.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("active", b === btn));
      displayChanged();
    });
  });
  host.querySelector("#reviewMoreBtn").addEventListener("click", () => loadPage());
  host.querySelector("#reviewPromptClear")?.addEventListener("click", () => {
    view.prompt = null;
    renderReviewTab(host, view.projectIds);
  });
  host.querySelector("#reviewReportClear")?.addEventListener("click", () => {
    detachReport();
    renderReviewTab(host, view.projectIds);
  });
  host.querySelector("#reviewReportSave")?.addEventListener("click", (e) => saveReportChanges(e.currentTarget));
  host.querySelector("#reviewReportNew").addEventListener("click", saveReportModal);
  view.root = host.querySelector("#reviewGrid");
  bindGrid(host.querySelector("#reviewGrid"));
  applyGridDisplay();

  reset();
}

function filterChanged() {
  saveFilter();
  reset();
}

// Display changes re-render the loaded tiles in place; no refetch.
function displayChanged() {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(view.display));
  } catch {
    // storage full/unavailable -- the display just won't persist
  }
  applyGridDisplay();
  view.host.querySelector("#reviewGrid").innerHTML = view.items.map(tileHtml).join("");
}

function reset() {
  view.seq++;
  view.items = [];
  view.total = 0;
  view.loading = false;
  view.hoverIdx = null;
  view.host.querySelector("#reviewGrid").innerHTML = "";
  // No rating ticked matches nothing; don't send [] (which means "any").
  if (!view.projectIds.length || !view.filter.evaluations.length) {
    renderStatus();
    return;
  }
  loadPage();
}

// True once a newer load has started or the tab has been swapped out of the
// shared panel (another tab rendered over it), so late responses are dropped.
function stale(seq) {
  return seq !== view.seq || !view.root?.isConnected;
}

async function loadPage() {
  if (view.loading) return;
  const seq = view.seq;
  view.loading = true;
  renderStatus();
  try {
    const page = await api.manage.results(requestBody(), view.items.length, PAGE_SIZE);
    if (stale(seq)) return;
    const start = view.items.length;
    view.items.push(...page.items);
    view.total = page.total;
    appendTiles(start);
  } catch (err) {
    if (stale(seq)) return;
    view.error = err.message;
  } finally {
    if (!stale(seq)) {
      view.loading = false;
      renderStatus();
    }
  }
}

function tileTitle(r) {
  const when = formatRelativeTime(parseDbTime(r.date_generated));
  const copies = r.copy_count > 1 ? ` · ${r.copy_count} copies` : "";
  return `${r.project_name} / ${r.image_display_name} · ${r.evaluation || "UNRATED"} · ${when}${copies}`;
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

function applyGridDisplay() {
  const grid = view.host.querySelector("#reviewGrid");
  grid.style.setProperty("--review-tile", `${TILE_SIZES[view.display.size]}px`);
  grid.dataset.compare = view.display.compare;
  grid.dataset.size = view.display.size;
}

function tileImageUrl(r) {
  if (view.display.compare === "side_by_side") return `/api/results/${r.id}/side-by-side`;
  return view.display.size === "S" ? `/api/results/${r.id}/thumbnail` : `/api/results/${r.id}/preview`;
}

function tileClass(r) {
  return `result-tile review-tile ${r.evaluation || "UNRATED"} ${r.is_active_result ? "active" : ""}`;
}

function tileHtml(r, idx) {
  // In reveal mode the source <img> gets its src on first hover (data-src),
  // so a page of tiles doesn't pull every full-size source up front.
  const reveal =
    view.display.compare === "reveal"
      ? `<img class="review-tile-source" data-src="/api/results/${r.id}/source" alt="" draggable="false" />`
      : "";
  return `
    <div class="${tileClass(r)}" data-idx="${idx}" title="${escapeHtml(tileTitle(r))}">
      <img class="review-tile-result" src="${tileImageUrl(r)}" loading="lazy" alt="" draggable="false" />
      ${reveal}
      ${r.copy_count > 1 ? `<span class="review-copy-badge">×${r.copy_count}</span>` : ""}
    </div>
  `;
}

function appendTiles(start) {
  const grid = view.host.querySelector("#reviewGrid");
  grid.insertAdjacentHTML("beforeend", view.items.slice(start).map((r, i) => tileHtml(r, start + i)).join(""));
}

function refreshTile(idx) {
  const tile = view.host?.querySelector(`#reviewGrid [data-idx="${idx}"]`);
  if (!tile) return;
  const r = view.items[idx];
  tile.className = tileClass(r);
  tile.title = tileTitle(r);
}

// Click opens the lightbox. In reveal mode a press held past HOLD_MS shows
// the source instead, until release, and the click that follows is swallowed.
function bindGrid(grid) {
  let holdTimer = null;
  let heldTile = null;
  let swallowClick = false;
  const release = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (heldTile) heldTile.classList.remove("revealing");
    heldTile = null;
  };

  grid.addEventListener("pointerover", (e) => {
    const tile = e.target.closest("[data-idx]");
    view.hoverIdx = tile ? Number(tile.dataset.idx) : null;
    const src = tile?.querySelector(".review-tile-source:not([src])");
    if (src) src.src = src.dataset.src; // warm it before the press
  });
  grid.addEventListener("pointerleave", () => {
    view.hoverIdx = null;
    release();
  });
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || view.display.compare !== "reveal") return;
    const tile = e.target.closest("[data-idx]");
    if (!tile) return;
    swallowClick = false;
    holdTimer = setTimeout(() => {
      const src = tile.querySelector(".review-tile-source");
      if (!src.getAttribute("src")) src.src = src.dataset.src;
      tile.classList.add("revealing");
      heldTile = tile;
      swallowClick = true;
    }, HOLD_MS);
  });
  grid.addEventListener("pointerup", release);
  grid.addEventListener("pointercancel", release);
  grid.addEventListener("click", (e) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const tile = e.target.closest("[data-idx]");
    if (tile) openLightbox(Number(tile.dataset.idx));
  });
}

function renderStatus() {
  const count = view.host.querySelector("#reviewCount");
  const more = view.host.querySelector("#reviewMoreBtn");
  if (!view.projectIds.length) count.textContent = "No libraries selected.";
  else if (!view.filter.evaluations.length) count.textContent = "Tick at least one rating.";
  else if (view.error) count.textContent = `Failed to load: ${view.error}`;
  else if (view.loading && !view.items.length) count.textContent = "Loading…";
  else count.textContent = view.total ? `${view.items.length} of ${view.total} results` : "No results match.";
  view.error = null;
  const hasMore = view.items.length < view.total;
  more.style.display = hasMore ? "" : "none";
  more.disabled = view.loading;
}

// ---------------------------------------------------------------------------
// Rating. The tile keeps its place even when the new rating falls outside the
// filter, so the grid doesn't reflow under the pointer; it drops out on the
// next reload.
// ---------------------------------------------------------------------------

async function rate(idx, evaluation) {
  const r = view.items[idx];
  if (!r || r.evaluation === evaluation) return;
  const previous = r.evaluation;
  r.evaluation = evaluation;
  refreshTile(idx);
  if (view.lightboxIdx === idx) renderLightboxHeader();
  try {
    await api.setEvaluation(r.id, evaluation);
  } catch (err) {
    r.evaluation = previous;
    refreshTile(idx);
    if (view.lightboxIdx === idx) renderLightboxHeader(`Rating failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lightbox: the main page's A/B viewer (all its comparison modes) on the
// result's generation-time source vs. the result. One viewer instance is
// created on first use and re-parented into each modal, since the modal
// clears its content on close.
// ---------------------------------------------------------------------------

let viewerHost = null;
let viewer = null;

function lightboxOpen() {
  return view.lightboxIdx !== null && !!viewerHost?.isConnected;
}

function openLightbox(idx) {
  if (!view.items[idx]) return;
  if (!lightboxOpen()) {
    if (!viewerHost) {
      viewerHost = document.createElement("div");
      viewerHost.className = "review-viewer";
      viewer = initABViewer(viewerHost);
    }
    const modal = openModal(`
      <div class="review-lightbox">
        <div class="review-lightbox-bar" id="rlBar"></div>
        <div class="review-lightbox-body" id="rlBody">
          <button class="lightbox-nav-btn lightbox-nav-prev" id="rlPrev" title="Previous (←)">‹</button>
          <button class="lightbox-nav-btn lightbox-nav-next" id="rlNext" title="Next (→)">›</button>
        </div>
      </div>
    `);
    modal.querySelector("#rlBody").prepend(viewerHost);
    modal.querySelector("#rlPrev").addEventListener("click", () => stepLightbox(-1));
    modal.querySelector("#rlNext").addEventListener("click", () => stepLightbox(1));
  }
  view.lightboxIdx = idx;
  const r = view.items[idx];
  viewer.setImages(`/api/results/${r.id}/source`, `/api/results/${r.id}/file`, { baseProcessed: !!r.source_preprocess });
  renderLightboxHeader();
}

async function stepLightbox(delta) {
  const idx = view.lightboxIdx + delta;
  if (idx < 0 || idx >= view.total) return;
  if (idx >= view.items.length) await loadPage();
  if (lightboxOpen()) openLightbox(idx);
}

function renderLightboxHeader(message = "") {
  const bar = document.getElementById("rlBar");
  if (!bar) return;
  const idx = view.lightboxIdx;
  const r = view.items[idx];
  const current = r.evaluation || "UNRATED";
  const editorUrl = `/?project=${encodeURIComponent(r.project_id)}&image=${encodeURIComponent(r.image_id)}`;
  bar.innerHTML = `
    <span class="review-lightbox-pos">${idx + 1} / ${view.total}</span>
    <span class="review-lightbox-title" title="${escapeHtml(tileTitle(r))}">${escapeHtml(r.project_name)} / ${escapeHtml(r.image_display_name)}</span>
    <span class="review-rate-group" role="group" aria-label="Rating">
      ${[["YES", "Y"], ["MAYBE", "M"], ["NO", "N"]]
        .map(([ev, key]) => `<button type="button" class="btn-ghost small review-rate ${ev} ${current === ev ? "active" : ""}" data-rate="${ev}" title="Rate ${ev} (${key})">${ev}</button>`)
        .join("")}
    </span>
    <span class="review-lightbox-msg">${escapeHtml(message)}</span>
    <a class="btn-ghost small" href="${editorUrl}" target="_blank" rel="noopener" title="Open this image in the library, in a new tab">Open in editor ↗</a>
  `;
  bar.querySelectorAll("[data-rate]").forEach((btn) => btn.addEventListener("click", () => rate(idx, btn.dataset.rate)));
  document.getElementById("rlPrev").disabled = idx <= 0;
  document.getElementById("rlNext").disabled = idx + 1 >= view.total;
}

// ---------------------------------------------------------------------------
// Keys: Y/M/N rate the lightbox item, or the hovered tile when no dialog is
// open; ←/→ step the lightbox. Escape is the modal stack's (ui.js).
// ---------------------------------------------------------------------------

const RATE_KEYS = { y: "YES", m: "MAYBE", n: "NO" };

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
  if (t.closest?.(".viewer-mode-menu-wrap")) return; // the viewer's own mode menu uses the arrows
  const key = e.key.toLowerCase();
  if (lightboxOpen()) {
    if (RATE_KEYS[key]) rate(view.lightboxIdx, RATE_KEYS[key]);
    else if (key === "arrowleft") stepLightbox(-1);
    else if (key === "arrowright") stepLightbox(1);
    else return;
    e.preventDefault();
  } else if (!isModalOpen() && view.hoverIdx !== null && view.host?.isConnected && RATE_KEYS[key]) {
    rate(view.hoverIdx, RATE_KEYS[key]);
    e.preventDefault();
  }
});
