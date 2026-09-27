// Reports tab of the management page: saved Review views (filter + display).
// A report is re-run on open, so its count and results reflect the library
// as it is now. New reports are saved from the Review tab.

import { api } from "./api.js";
import { escapeHtml, formatRelativeTime, parseDbTime, plural, openModal, closeModal, openConfirmModal } from "./ui.js";
import { openExportModal } from "./manage_export.js";

const EVALUATIONS = ["YES", "MAYBE", "NO", "UNRATED"];
const SORT_LABELS = { date_desc: "newest first", date_asc: "oldest first", project: "by library", evaluation: "by rating" };

const view = { host: null, reports: [], projectNames: new Map(), onOpen: null, seq: 0 };

// opts: { projectNames: Map(id -> name), onOpen(report) }
export function renderReportsTab(host, { projectNames, onOpen }) {
  view.host = host;
  view.projectNames = projectNames;
  view.onOpen = onOpen;
  host.innerHTML = `
    <div class="review-filters">
      <span class="manage-hint">Save a view from the Review tab to add it here.</span>
      <span id="reportCount" class="manage-hint review-count"></span>
    </div>
    <div class="prompt-report-wrap">
      <table class="prompt-report report-list">
        <thead><tr><th>Name</th><th>Filter</th><th class="num">Results</th><th>Updated</th><th></th></tr></thead>
        <tbody id="reportBody"></tbody>
      </table>
    </div>
  `;
  view.root = host.querySelector("#reportBody");
  host.querySelector("#reportBody").addEventListener("click", onClick);
  load();
}

// True once a newer load has started or the tab has been swapped out of the
// shared panel (another tab rendered over it), so late responses are dropped.
function stale(seq) {
  return seq !== view.seq || !view.root?.isConnected;
}

async function load() {
  const seq = ++view.seq;
  const count = view.host.querySelector("#reportCount");
  count.textContent = "Loading…";
  try {
    const reports = await api.manage.listReports();
    if (stale(seq)) return;
    view.reports = reports;
  } catch (err) {
    if (!stale(seq)) count.textContent = `Failed to load: ${err.message}`;
    return;
  }
  render();
}

// One line describing what a report selects.
export function describeFilter(report, projectNames) {
  const f = report.filter;
  const parts = [];
  const live = (f.project_ids || []).filter((id) => !report.missing_project_ids.includes(id));
  if (!f.project_ids?.length) parts.push(f.include_archived ? "All libraries incl. archived" : "All libraries");
  else parts.push(live.map((id) => projectNames.get(id) || "?").join(", ") || "No libraries left");
  if (report.missing_project_ids.length) parts.push(`${report.missing_project_ids.length} deleted`);
  const evs = f.evaluations || [];
  if (evs.length && evs.length < EVALUATIONS.length) parts.push(evs.join("/"));
  if (f.prompt_hashes?.length) {
    const labels = report.display?.prompt_labels || {};
    const one = f.prompt_hashes.length === 1 && (labels[f.prompt_hashes[0] ?? ""] || report.display?.prompt_label);
    parts.push(one ? `prompt “${one}”` : plural(f.prompt_hashes.length, "prompt"));
  }
  if (f.engines?.length) parts.push(f.engines.join("/"));
  if (f.date_from || f.date_to) parts.push(`${f.date_from || "…"} to ${f.date_to || "…"}`);
  if (f.active_only) parts.push("active only");
  if (f.dedupe_copies === false) parts.push("copies shown");
  parts.push(SORT_LABELS[f.sort] || f.sort);
  return parts.join(" · ");
}

function render() {
  const body = view.host.querySelector("#reportBody");
  body.innerHTML = view.reports.length
    ? view.reports
        .map(
          (r, i) => `
      <tr data-idx="${i}" title="Open in Review">
        <td class="report-name">${escapeHtml(r.name)}</td>
        <td class="report-filter">${escapeHtml(describeFilter(r, view.projectNames))}</td>
        <td class="num">${r.result_count ?? ""}</td>
        <td class="nowrap" title="${escapeHtml(r.date_updated)} UTC">${formatRelativeTime(parseDbTime(r.date_updated))}</td>
        <td class="prompt-actions">
          <button type="button" class="btn-ghost small" data-act="export">Export</button>
          <button type="button" class="btn-ghost small" data-act="rename">Rename</button>
          <button type="button" class="btn-ghost small" data-act="duplicate">Duplicate</button>
          <button type="button" class="btn-ghost small" data-act="delete">Delete</button>
        </td>
      </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="5"><div class="empty-state">No saved reports yet.</div></td></tr>`;
  view.host.querySelector("#reportCount").textContent = plural(view.reports.length, "report");
}

async function onClick(e) {
  const tr = e.target.closest("tr[data-idx]");
  if (!tr) return;
  const r = view.reports[Number(tr.dataset.idx)];
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rename") return rename(r);
  if (act === "export") {
    return openExportModal({
      source: { report_id: r.id },
      name: r.name,
      summary: `Report “${r.name}”: ${describeFilter(r, view.projectNames)} (${plural(r.result_count ?? 0, "result")} now).`,
    });
  }
  if (act === "delete") return remove(r);
  if (act === "duplicate") {
    await api.manage.createReport({ name: `${r.name} (copy)`.slice(0, 200), filter: r.filter, display: r.display });
    return load();
  }
  view.onOpen?.(r);
}

function rename(r) {
  const modal = openModal(`
    <h3>Rename report</h3>
    <div class="field"><label for="mReportName">Name</label><input id="mReportName" type="text" maxlength="200" /></div>
    <div id="mStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost" type="button">Cancel</button>
      <button id="mSave" class="btn-primary" type="button">Rename</button>
    </div>
  `);
  const input = modal.querySelector("#mReportName");
  input.value = r.name;
  input.focus();
  input.select();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const save = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await api.manage.updateReport(r.id, { name });
      closeModal();
      load();
    } catch (err) {
      modal.querySelector("#mStatus").textContent = `Rename failed: ${err.message}`;
    }
  };
  modal.querySelector("#mSave").addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

async function remove(r) {
  const ok = await openConfirmModal({
    title: "Delete report",
    message: `Delete the report “${r.name}”? Only the saved view goes; no images or results are touched.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await api.manage.deleteReport(r.id);
  load();
}
