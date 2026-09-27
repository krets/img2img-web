// Review tab of the management page: a paged result gallery across the
// selected projects, driven by POST /api/manage/results (ManageFilterIn).

import { api } from "./api.js";
import { escapeHtml, formatRelativeTime, parseDbTime, openImageLightbox } from "./ui.js";

const FILTER_KEY = "grok_img2img.manage.reviewFilter";
const PAGE_SIZE = 120;
const EVALUATIONS = ["YES", "MAYBE", "NO", "UNRATED"];
const SORTS = { date_desc: "Newest first", date_asc: "Oldest first", project: "By library", evaluation: "By rating" };
const DEFAULT_FILTER = { evaluations: [...EVALUATIONS], active_only: false, dedupe_copies: true, sort: "date_desc" };

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
  projectIds: [],
  items: [],
  total: 0,
  loading: false,
  error: null,
  seq: 0, // bumped on every reset so a slow response for an old filter is dropped
  host: null,
};

function saveFilter() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(view.filter));
  } catch {
    // storage full/unavailable -- the filter just won't persist
  }
}

function requestBody() {
  return { ...view.filter, project_ids: view.projectIds };
}

// Mounts the tab into host for the given project ids (never empty: an empty
// list would mean "every project" to the endpoint).
export function renderReviewTab(host, projectIds) {
  view.host = host;
  view.projectIds = projectIds;
  const f = view.filter;
  host.innerHTML = `
    <div class="review-filters">
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
  host.querySelector("#reviewMoreBtn").addEventListener("click", () => loadPage());
  host.querySelector("#reviewGrid").addEventListener("click", (e) => {
    const tile = e.target.closest("[data-idx]");
    if (tile) openResult(Number(tile.dataset.idx));
  });

  reset();
}

function filterChanged() {
  saveFilter();
  reset();
}

function reset() {
  view.seq++;
  view.items = [];
  view.total = 0;
  view.loading = false;
  view.host.querySelector("#reviewGrid").innerHTML = "";
  // No rating ticked matches nothing; don't send [] (which means "any").
  if (!view.projectIds.length || !view.filter.evaluations.length) {
    renderStatus();
    return;
  }
  loadPage();
}

async function loadPage() {
  if (view.loading) return;
  const seq = view.seq;
  view.loading = true;
  renderStatus();
  try {
    const page = await api.manage.results(requestBody(), view.items.length, PAGE_SIZE);
    if (seq !== view.seq) return;
    const start = view.items.length;
    view.items.push(...page.items);
    view.total = page.total;
    appendTiles(start);
  } catch (err) {
    if (seq !== view.seq) return;
    view.error = err.message;
  } finally {
    if (seq === view.seq) {
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

function tileHtml(r, idx) {
  return `
    <div class="result-tile ${escapeHtml(r.evaluation || "UNRATED")} ${r.is_active_result ? "active" : ""}" data-idx="${idx}" title="${escapeHtml(tileTitle(r))}">
      <img src="/api/results/${r.id}/thumbnail" loading="lazy" alt="" />
      ${r.copy_count > 1 ? `<span class="review-copy-badge">×${r.copy_count}</span>` : ""}
    </div>
  `;
}

function appendTiles(start) {
  const grid = view.host.querySelector("#reviewGrid");
  grid.insertAdjacentHTML("beforeend", view.items.slice(start).map((r, i) => tileHtml(r, start + i)).join(""));
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

// Lightbox over the loaded results; stepping past the last loaded one pulls
// the next page in first.
function openResult(idx) {
  const r = view.items[idx];
  if (!r) return;
  const canNext = idx + 1 < view.total;
  openImageLightbox(`/api/results/${r.id}/file`, tileTitle(r), {
    position: `${idx + 1} / ${view.total} · ${tileTitle(r)}`,
    onPrev: idx > 0 ? () => openResult(idx - 1) : null,
    onNext: canNext
      ? async () => {
          if (idx + 1 >= view.items.length) await loadPage();
          openResult(idx + 1);
        }
      : null,
  });
}
