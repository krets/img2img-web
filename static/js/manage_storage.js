// Storage tab of the management page: disk usage per library, and a bulk
// downscale of oversized source images (see storage_usage.py). The downscale
// replaces the source file in place, so it always goes through a preview of
// what it would touch and a confirmation.

import { api } from "./api.js";
import { escapeHtml, openConfirmModal } from "./ui.js";

const MAX_DIM_KEY = "grok_img2img.manage.downscaleMaxDim";
const DEFAULT_MAX_DIM = 4096;
const PRESETS = [2048, 3072, 4096, 6144, 8192];
const POLL_MS = 1000;
const COLUMNS = [
  ["sources", "Sources", "source_count"],
  ["references", "References", "reference_count"],
  ["results", "Results", "result_count"],
  ["thumbnails", "Thumbnails", "thumbnail_count"],
  ["trash", "Trash", "trash_count"],
  ["total", "Total", "total_count"],
];

function cell(p, key, countKey) {
  const n = p[countKey];
  return `${formatBytes(p[key])}${n ? `<span class="storage-count">${n}</span>` : ""}`;
}

const view = { host: null, projectIds: [], opts: {}, data: null, sort: "total", seq: 0, busy: false, candidates: [], picked: new Set() };

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function loadMaxDim() {
  try {
    const v = Number(localStorage.getItem(MAX_DIM_KEY));
    if (v >= 256) return v;
  } catch {
    // ignore
  }
  return DEFAULT_MAX_DIM;
}

// opts: { includeArchived: bool }
export function renderStorageTab(host, projectIds, opts = {}) {
  view.host = host;
  view.projectIds = projectIds;
  view.opts = opts;
  host.innerHTML = `
    <div class="review-filters">
      <span class="manage-hint" id="storageDisk"></span>
      <button type="button" id="storageRefresh" class="btn-ghost small">Refresh</button>
    </div>
    <div class="prompt-report-wrap">
      <table class="prompt-report">
        <thead><tr>
          <th>Library</th>
          ${COLUMNS.map(([k, label]) => `<th class="num sortable ${k === view.sort ? "sorted" : ""}" data-sort="${k}">${label}</th>`).join("")}
        </tr></thead>
        <tbody id="storageBody"></tbody>
        <tfoot id="storageFoot"></tfoot>
      </table>
    </div>
    <div class="storage-downscale">
      <h3>Downscale source images</h3>
      <p class="manage-hint">Find sources larger than a size, then choose which to shrink. This <strong>replaces the file in place</strong>: the full-resolution original is not kept. Crops are scaled to match, and results already generated are not changed. Images with a stored crop are left unticked, since they may be meant to be cropped in on. This is separate from the upload size in Settings, which is applied on the fly.</p>
      <div class="review-filters">
        <label>Only images with a long edge over
          <input type="number" id="storageMaxDim" list="storagePresets" min="256" max="16000" step="128" value="${loadMaxDim()}" style="width:90px" /> px
        </label>
        <datalist id="storagePresets">${PRESETS.map((v) => `<option value="${v}"></option>`).join("")}</datalist>
        <button type="button" id="storageFind" class="btn-ghost small">Find images</button>
        <span id="storageStatus" class="manage-hint"></span>
      </div>
      <div id="storageCandidates"></div>
      <div class="export-progress" id="storageProgress" hidden><div class="export-progress-bar"></div></div>
    </div>
  `;
  host.querySelector("#storageRefresh").addEventListener("click", load);
  host.querySelector("#storageFind").addEventListener("click", findCandidates);
  host.querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (!th) return;
    view.sort = th.dataset.sort;
    host.querySelectorAll("th[data-sort]").forEach((t) => t.classList.toggle("sorted", t === th));
    renderRows();
  });
  load();
}

function scope() {
  return { project_ids: view.projectIds, include_archived: !!view.opts.includeArchived };
}

function stale(seq) {
  return seq !== view.seq || !view.host?.isConnected;
}

async function load() {
  const seq = ++view.seq;
  const body = view.host.querySelector("#storageBody");
  body.innerHTML = `<tr><td colspan="${COLUMNS.length + 1}" class="manage-hint">Measuring…</td></tr>`;
  try {
    const data = await api.manage.storage(scope());
    if (stale(seq)) return;
    view.data = data;
  } catch (err) {
    if (!stale(seq)) body.innerHTML = `<tr><td colspan="${COLUMNS.length + 1}">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  const { free, total } = view.data.disk;
  const { total: used, total_count: items } = view.data.totals;
  view.host.querySelector("#storageDisk").textContent =
    `Drive: ${formatBytes(free)} free of ${formatBytes(total)} — library data: ${formatBytes(used)}, ${items} item${items === 1 ? "" : "s"}`;
  renderRows();
}

function renderRows() {
  const { projects, totals } = view.data;
  const rows = [...projects].sort((a, b) => b[view.sort] - a[view.sort]);
  view.host.querySelector("#storageBody").innerHTML = rows.length
    ? rows
        .map(
          (p) =>
            `<tr><td title="${escapeHtml(p.project_name)}">${escapeHtml(p.project_name)}</td>${COLUMNS.map(([k, , ck]) => `<td class="num">${cell(p, k, ck)}</td>`).join("")}</tr>`
        )
        .join("")
    : `<tr><td colspan="${COLUMNS.length + 1}" class="manage-hint">No libraries.</td></tr>`;
  view.host.querySelector("#storageFoot").innerHTML = `<tr><th>All shown (${projects.length})</th>${COLUMNS.map(([k, , ck]) => `<th class="num">${cell(totals, k, ck)}</th>`).join("")}</tr>`;
}

function maxDim() {
  const v = Math.round(Number(view.host.querySelector("#storageMaxDim").value));
  return v >= 256 && v <= 16000 ? v : null;
}

async function findCandidates() {
  const dim = maxDim();
  const status = view.host.querySelector("#storageStatus");
  if (!dim) {
    status.textContent = "Enter a size between 256 and 16000.";
    return;
  }
  try {
    localStorage.setItem(MAX_DIM_KEY, String(dim));
  } catch {
    // ignore
  }
  status.textContent = "Checking…";
  let preview;
  try {
    preview = await api.manage.downscalePreview({ ...scope(), max_dim: dim });
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    return;
  }
  if (!view.host.isConnected) return;
  view.dim = dim;
  view.candidates = preview.items;
  view.picked = new Set(preview.items.filter((i) => !i.has_crop).map((i) => i.image_id));
  status.textContent = preview.count ? "" : `No source images have a long edge over ${dim}px.`;
  renderCandidates();
}

function pickedTotals() {
  const chosen = view.candidates.filter((i) => view.picked.has(i.image_id));
  return { count: chosen.length, saved: chosen.reduce((a, i) => a + i.est_saved, 0) };
}

function renderCandidates() {
  const box = view.host.querySelector("#storageCandidates");
  if (!view.candidates.length) {
    box.innerHTML = "";
    return;
  }
  const cropped = view.candidates.filter((i) => i.has_crop).length;
  box.innerHTML = `
    <div class="review-filters">
      <button type="button" class="btn-ghost small" data-pick="all">All</button>
      <button type="button" class="btn-ghost small" data-pick="none">None</button>
      <button type="button" class="btn-ghost small" data-pick="uncropped">Without a crop</button>
      <span class="manage-hint">${view.candidates.length} found${cropped ? `, ${cropped} with a crop` : ""}; biggest saving first</span>
      <span class="review-count" style="margin-left:auto">
        <span id="storagePicked" class="manage-hint"></span>
        <button type="button" id="storageGo" class="btn-danger small">Downscale selected…</button>
      </span>
    </div>
    <div class="prompt-report-wrap storage-candidate-wrap">
      <table class="prompt-report storage-candidates">
        <thead><tr><th></th><th></th><th>Library / image</th><th class="num">Size</th><th class="num">Becomes</th><th class="num">File</th><th class="num">Saves ~</th></tr></thead>
        <tbody>
          ${view.candidates
            .map(
              (i) => `<tr data-id="${i.image_id}">
                <td><input type="checkbox" ${view.picked.has(i.image_id) ? "checked" : ""} /></td>
                <td><img src="/api/images/${i.image_id}/thumbnail" loading="lazy" alt="" width="40" height="40" /></td>
                <td title="${escapeHtml(i.project_name)} / ${escapeHtml(i.display_name)}">${escapeHtml(i.project_name)} / ${escapeHtml(i.display_name)}${i.has_crop ? ` <span class="storage-badge" title="Has a stored crop or rotation">crop</span>` : ""}${i.result_count ? ` <span class="manage-hint">${i.result_count} result${i.result_count === 1 ? "" : "s"}</span>` : ""}</td>
                <td class="num">${i.width}×${i.height}</td>
                <td class="num">${i.new_width}×${i.new_height}</td>
                <td class="num">${formatBytes(i.bytes)}</td>
                <td class="num">${formatBytes(i.est_saved)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  updatePicked();
  box.onchange = (e) => {
    const id = e.target.closest("tr")?.dataset.id;
    if (!id) return;
    if (e.target.checked) view.picked.add(id);
    else view.picked.delete(id);
    updatePicked();
  };
  box.onclick = (e) => {
    const mode = e.target.dataset.pick;
    if (!mode) return;
    view.picked = new Set(
      view.candidates.filter((i) => mode === "all" || (mode === "uncropped" && !i.has_crop)).map((i) => i.image_id)
    );
    box.querySelectorAll("tbody tr").forEach((tr) => {
      tr.querySelector("input").checked = view.picked.has(tr.dataset.id);
    });
    updatePicked();
  };
  box.querySelector("#storageGo").addEventListener("click", confirmDownscale);
}

function updatePicked() {
  const { count, saved } = pickedTotals();
  view.host.querySelector("#storagePicked").textContent = count ? `${count} selected, saves ~${formatBytes(saved)}` : "None selected";
  view.host.querySelector("#storageGo").disabled = !count;
}

async function confirmDownscale() {
  const { count, saved } = pickedTotals();
  if (!count) return;
  const croppedPicked = view.candidates.filter((i) => i.has_crop && view.picked.has(i.image_id)).length;
  const ok = await openConfirmModal({
    title: "Downscale source images",
    message:
      `Shrink ${count} source image${count === 1 ? "" : "s"} to ${view.dim}px on the long edge, saving roughly ${formatBytes(saved)} (an estimate). ` +
      `The files are replaced in place and the originals cannot be recovered.` +
      (croppedPicked ? ` ${croppedPicked} of them have a stored crop, which is scaled along with the image; fine detail for cropping in is lost.` : ""),
    confirmLabel: `Downscale ${count}`,
    danger: true,
  });
  if (ok) runDownscale(view.dim, [...view.picked]);
}

async function runDownscale(dim, imageIds) {
  if (view.busy) return;
  view.busy = true;
  const status = view.host.querySelector("#storageStatus");
  const progress = view.host.querySelector("#storageProgress");
  const bar = progress.firstElementChild;
  progress.hidden = false;
  bar.style.width = "0%";
  try {
    let job = await api.manage.startDownscale({ ...scope(), max_dim: dim, image_ids: imageIds });
    for (;;) {
      if (!view.host.isConnected) return;
      const pct = job.total ? Math.round((100 * job.done) / job.total) : 0;
      bar.style.width = `${pct}%`;
      status.textContent = `Downscaling ${job.done} of ${job.total}…`;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, POLL_MS));
      job = await api.manage.downscaleStatus(job.id);
    }
    if (job.status === "error") {
      status.textContent = `Downscale failed: ${job.error}`;
    } else {
      const failed = job.failed ? `, ${job.failed} failed` : "";
      status.textContent = `Done: ${job.done - job.failed} downscaled, ${formatBytes(job.saved)} saved${failed}.`;
    }
    load();
    view.candidates = [];
    renderCandidates();
  } catch (err) {
    status.textContent = `Lost track of the downscale: ${err.message}`;
  } finally {
    view.busy = false;
    if (view.host.isConnected) progress.hidden = true;
  }
}
