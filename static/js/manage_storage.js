// Storage tab of the management page: disk usage per library, and a bulk
// downscale of oversized source images (see storage_usage.py). The downscale
// replaces the source file in place, so it always goes through a preview of
// what it would touch and a confirmation.

import { api } from "./api.js";
import { escapeHtml, openConfirmModal } from "./ui.js";

const MAX_DIM_KEY = "grok_img2img.manage.downscaleMaxDim";
const DEFAULT_MAX_DIM = 2048;
const POLL_MS = 1000;
const COLUMNS = [
  ["sources", "Sources"],
  ["references", "References"],
  ["results", "Results"],
  ["thumbnails", "Thumbnails"],
  ["trash", "Trash"],
  ["total", "Total"],
];

const view = { host: null, projectIds: [], opts: {}, data: null, sort: "total", seq: 0, busy: false };

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
      <p class="manage-hint">Shrinks sources whose long edge is larger than the limit and <strong>replaces the file in place</strong>: the full-resolution original is not kept. Crops are scaled to match. Results already generated are not changed.</p>
      <div class="review-filters">
        <label>Longest edge <input type="number" id="storageMaxDim" min="256" max="16000" step="128" value="${loadMaxDim()}" style="width:90px" /> px</label>
        <button type="button" id="storagePreview" class="btn-ghost small">Preview…</button>
        <span id="storageStatus" class="manage-hint"></span>
      </div>
      <div class="export-progress" id="storageProgress" hidden><div class="export-progress-bar"></div></div>
    </div>
  `;
  host.querySelector("#storageRefresh").addEventListener("click", load);
  host.querySelector("#storagePreview").addEventListener("click", previewDownscale);
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
  view.host.querySelector("#storageDisk").textContent = `Drive: ${formatBytes(free)} free of ${formatBytes(total)}`;
  renderRows();
}

function renderRows() {
  const { projects, totals } = view.data;
  const rows = [...projects].sort((a, b) => b[view.sort] - a[view.sort]);
  view.host.querySelector("#storageBody").innerHTML = rows.length
    ? rows
        .map(
          (p) =>
            `<tr><td title="${escapeHtml(p.project_name)}">${escapeHtml(p.project_name)}</td>${COLUMNS.map(([k]) => `<td class="num">${formatBytes(p[k])}</td>`).join("")}</tr>`
        )
        .join("")
    : `<tr><td colspan="${COLUMNS.length + 1}" class="manage-hint">No libraries.</td></tr>`;
  view.host.querySelector("#storageFoot").innerHTML = `<tr><th>All shown (${projects.length})</th>${COLUMNS.map(([k]) => `<th class="num">${formatBytes(totals[k])}</th>`).join("")}</tr>`;
}

function maxDim() {
  const v = Math.round(Number(view.host.querySelector("#storageMaxDim").value));
  return v >= 256 && v <= 16000 ? v : null;
}

async function previewDownscale() {
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
  if (!preview.count) {
    status.textContent = `No source images are larger than ${dim}px.`;
    return;
  }
  status.textContent = "";
  const top = preview.projects
    .slice(0, 5)
    .map((p) => `${p.project_name}: ${p.count} (~${formatBytes(p.est_saved)})`)
    .join("; ");
  const ok = await openConfirmModal({
    title: "Downscale source images",
    message:
      `${preview.count} source image${preview.count === 1 ? "" : "s"} (${formatBytes(preview.bytes)}) are larger than ${dim}px and would be shrunk, saving roughly ${formatBytes(preview.est_saved)} (an estimate). ` +
      `The files are replaced in place and the originals cannot be recovered. Results already generated are not changed. ${top ? `Biggest: ${top}.` : ""}`,
    confirmLabel: `Downscale ${preview.count}`,
    danger: true,
  });
  if (ok) runDownscale(dim);
}

async function runDownscale(dim) {
  if (view.busy) return;
  view.busy = true;
  const status = view.host.querySelector("#storageStatus");
  const progress = view.host.querySelector("#storageProgress");
  const bar = progress.firstElementChild;
  progress.hidden = false;
  bar.style.width = "0%";
  try {
    let job = await api.manage.startDownscale({ ...scope(), max_dim: dim });
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
  } catch (err) {
    status.textContent = `Lost track of the downscale: ${err.message}`;
  } finally {
    view.busy = false;
    if (view.host.isConnected) progress.hidden = true;
  }
}
