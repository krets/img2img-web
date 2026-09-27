// Review tab of the management page: a paged result gallery across the
// selected projects, driven by POST /api/manage/results (ManageFilterIn).

import { api } from "./api.js";
import { escapeHtml, formatRelativeTime, parseDbTime, openModal, closeModal, isModalOpen } from "./ui.js";
import { initABViewer } from "./viewer.js";
import { openExportModal } from "./manage_export.js";

const FILTER_KEY = "grok_img2img.manage.reviewFilter";
const PAGE_SIZE = 120;
const EVALUATIONS = ["YES", "MAYBE", "NO", "UNRATED"];
const SORTS = { date_desc: "Newest first", date_asc: "Oldest first", project: "By library", evaluation: "By rating" };
const DEFAULT_FILTER = { evaluations: [...EVALUATIONS], active_only: false, dedupe_copies: true, sort: "date_desc", engines: [] };
const ENGINE_LABELS = { grok: "Grok", comfyui: "Comfy", fal: "fal.ai" };
const NO_PROMPT_LABEL = "(no prompt)";

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
    if (!Array.isArray(f.engines)) f.engines = [];
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
  // [{ hash, label }] the gallery is narrowed to (hash null = no prompt text),
  // set from the Prompts tab, a report or the URL; empty for every prompt.
  prompts: [],
  report: null, // { id, name } of the saved report this view was opened from
  // Filter fields a report can carry but this tab has no controls for
  // (dates). Applied while the report is attached, dropped after.
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
  if (view.prompts.length) body.prompt_hashes = view.prompts.map((p) => p.hash);
  return body;
}

// Tells the page the view changed (it mirrors it into the URL).
function notifyChange() {
  view.opts.onChange?.();
}

function promptLabels() {
  return Object.fromEntries(view.prompts.map((p) => [p.hash ?? "", p.label]));
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
      prompt_hashes: view.prompts.map((p) => p.hash),
    },
    display: { ...view.display, ...(view.prompts.length ? { prompt_labels: promptLabels() } : {}) },
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
    engines: f.engines || [],
  };
  view.extra = {};
  for (const k of ["date_from", "date_to"]) if (f[k]) view.extra[k] = f[k];
  // Reports saved before several prompts were possible carry prompt_label.
  const labels = report.display?.prompt_labels || {};
  view.prompts = (f.prompt_hashes || []).map((hash) => ({
    hash,
    label: labels[hash ?? ""] || report.display?.prompt_label || (hash === null ? NO_PROMPT_LABEL : "saved prompt"),
  }));
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
  name.value = view.prompts.length === 1 ? view.prompts[0].label.slice(0, 80) : "";
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

// Narrows the gallery to a prompt group (hash null = results with no prompt),
// as opened from the Prompts tab; add keeps the prompts already chosen.
// Rating, active-only and engine filters are cleared so the gallery holds the
// whole group the report counted. The prompts live in the URL, not storage.
export function setReviewPrompt(hash, label, { add = false } = {}) {
  detachReport();
  if (!add) view.prompts = [];
  if (!view.prompts.some((p) => p.hash === hash)) view.prompts.push({ hash, label });
  view.filter.evaluations = [...EVALUATIONS];
  view.filter.active_only = false;
  view.filter.engines = [];
  saveFilter();
}

// URL state: the review parts of the page's hash (manage.js adds the tab and
// library selection). Defaults are left out to keep links short.
export function reviewHashParams() {
  const f = view.filter;
  const q = {};
  if (f.evaluations.length !== EVALUATIONS.length) q.ev = f.evaluations.join(",");
  if (f.active_only) q.act = "1";
  if (!f.dedupe_copies) q.dup = "0";
  if (f.sort !== DEFAULT_FILTER.sort) q.sort = f.sort;
  if (f.engines.length) q.eng = f.engines.join(",");
  if (view.prompts.length) q.ph = view.prompts.map((p) => p.hash ?? "none").join(",");
  if (view.display.compare !== "result_only") q.cmp = view.display.compare;
  if (view.display.size !== "S") q.size = view.display.size;
  return q;
}

// Applies review params from a URL, overriding what storage restored. Prompt
// labels aren't in the URL; they're looked up afterwards (resolvePromptLabels).
export function applyReviewHash(q) {
  detachReport();
  const list = (k) => (q.get(k) ? q.get(k).split(",").filter(Boolean) : null);
  view.filter = {
    evaluations: list("ev") ? EVALUATIONS.filter((e) => list("ev").includes(e)) : [...EVALUATIONS],
    active_only: q.get("act") === "1",
    dedupe_copies: q.get("dup") !== "0",
    sort: SORTS[q.get("sort")] ? q.get("sort") : DEFAULT_FILTER.sort,
    engines: list("eng") || [],
  };
  view.prompts = (list("ph") || []).map((h) => (h === "none" ? { hash: null, label: NO_PROMPT_LABEL } : { hash: h, label: "…" }));
  view.display.compare = COMPARE_MODES[q.get("cmp")] ? q.get("cmp") : "result_only";
  view.display.size = TILE_SIZES[q.get("size")] ? q.get("size") : "S";
  saveFilter();
  resolvePromptLabels();
}

async function resolvePromptLabels() {
  for (const p of view.prompts.filter((x) => x.label === "…")) {
    try {
      const page = await api.manage.results({ prompt_hashes: [p.hash], evaluations: [], include_archived: true }, 0, 1);
      p.label = page.items[0]?.adhoc_prompt_text?.trim() || "unknown prompt";
    } catch {
      p.label = "unknown prompt";
    }
    view.host?.querySelectorAll(`[data-prompt-chip="${CSS.escape(p.hash ?? "")}"]`).forEach((chip) => {
      chip.title = p.label;
      chip.querySelector(".review-prompt-chip-text").textContent = p.label;
    });
  }
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
      <button type="button" id="reviewExport" class="btn-ghost small" title="Download the results in this view as a zip">Export…</button>
      ${view.prompts
        .map(
          (p, i) => `<span class="review-prompt-chip" data-prompt-chip="${escapeHtml(p.hash ?? "")}" title="${escapeHtml(p.label)}">Prompt: <span class="review-prompt-chip-text">${escapeHtml(p.label)}</span><button type="button" data-prompt-remove="${i}" aria-label="Remove this prompt from the filter" title="Remove this prompt">×</button></span>`
        )
        .join("")}
      <div class="review-filter-group" role="group" aria-label="Rating">
        ${EVALUATIONS.map(
          (e) => `<label class="review-eval-toggle ${e}"><input type="checkbox" data-eval="${e}" ${f.evaluations.includes(e) ? "checked" : ""} /> ${e}</label>`
        ).join("")}
      </div>
      <div class="review-filter-group" id="reviewEngines" role="group" aria-label="Engine" hidden></div>
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
  host.querySelectorAll("[data-prompt-remove]").forEach((btn) =>
    btn.addEventListener("click", () => {
      view.prompts.splice(Number(btn.dataset.promptRemove), 1);
      renderReviewTab(host, view.projectIds);
      notifyChange();
    })
  );
  host.querySelector("#reviewEngines").addEventListener("change", (e) => {
    const boxes = [...host.querySelectorAll("[data-engine]")];
    const ticked = boxes.filter((b) => b.checked).map((b) => b.dataset.engine);
    if (!ticked.length) {
      e.target.checked = true; // keep one: none ticked would mean "any engine" to the server
      return;
    }
    f.engines = ticked.length === boxes.length ? [] : ticked;
    filterChanged();
  });
  host.querySelector("#reviewReportClear")?.addEventListener("click", () => {
    detachReport();
    renderReviewTab(host, view.projectIds);
  });
  host.querySelector("#reviewReportSave")?.addEventListener("click", (e) => saveReportChanges(e.currentTarget));
  host.querySelector("#reviewReportNew").addEventListener("click", saveReportModal);
  host.querySelector("#reviewExport").addEventListener("click", () =>
    openExportModal({
      source: { filter: requestBody() },
      name: view.report?.name || (view.prompts.length === 1 ? view.prompts[0].label.slice(0, 60) : "") || "export",
      summary: view.total ? `The ${view.total} results in this view, across ${view.projectIds.length === 1 ? "1 library" : `${view.projectIds.length} libraries`}.` : "The results in this view.",
    })
  );
  view.root = host.querySelector("#reviewGrid");
  bindGrid(host.querySelector("#reviewGrid"));
  applyGridDisplay();

  reset();
}

function filterChanged() {
  saveFilter();
  reset();
  notifyChange();
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
  notifyChange();
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
  loadEngines(view.seq);
}

// Fills the engine picker with the engines present under the other filters.
// Hidden while there's only one and it isn't narrowing anything.
async function loadEngines(seq) {
  let engines;
  try {
    engines = await api.manage.engines(requestBody());
  } catch {
    return;
  }
  if (stale(seq)) return;
  const chosen = view.filter.engines;
  for (const e of chosen) if (!engines.some((x) => x.engine === e)) engines.push({ engine: e, n: 0 });
  const box = view.host.querySelector("#reviewEngines");
  box.hidden = engines.length < 2 && !chosen.length;
  box.innerHTML = engines
    .map(
      ({ engine, n }) =>
        `<label class="review-eval-toggle engine" title="${n} results"><input type="checkbox" data-engine="${escapeHtml(engine)}" ${!chosen.length || chosen.includes(engine) ? "checked" : ""} /> ${escapeHtml(ENGINE_LABELS[engine] || engine)}</label>`
    )
    .join("");
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
      ${r.reference_image_ids?.length ? `<span class="review-ref-badge" title="Generated with ${r.reference_image_ids.length} reference image${r.reference_image_ids.length === 1 ? "" : "s"}">⧉${r.reference_image_ids.length}</span>` : ""}
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

// Thumbnails of the references a result was generated with, each opening the
// full reference in a new tab.
function referenceStrip(r) {
  const ids = r.reference_image_ids || [];
  if (!ids.length) return "";
  return `<span class="review-ref-strip" title="Reference images used">Refs ${ids
    .map(
      (id) =>
        `<a class="review-ref-thumb" href="/api/reference-images/${id}/original" target="_blank" rel="noopener"><img src="/api/reference-images/${id}/thumbnail" alt="Reference image" /></a>`
    )
    .join("")}</span>`;
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
    ${referenceStrip(r)}
    <span class="review-lightbox-msg">${escapeHtml(message)}</span>
    <a class="btn-ghost small" href="${editorUrl}" target="_blank" rel="noopener" title="Open this image in the library, in a new tab">Open in editor ↗</a>
  `;
  bar.querySelectorAll("[data-rate]").forEach((btn) => btn.addEventListener("click", () => rate(idx, btn.dataset.rate)));
  // A reference hard-deleted by the trash pruner leaves only its id behind.
  bar.querySelectorAll(".review-ref-thumb img").forEach((img) =>
    img.addEventListener("error", () => {
      const a = img.closest("a");
      a.replaceWith(Object.assign(document.createElement("span"), {
        className: "review-ref-thumb gone",
        title: "This reference image has been deleted",
        textContent: "deleted",
      }));
    })
  );
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
