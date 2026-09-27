// Export dialog for the management page: choose what goes into the zip, run
// the export in the background (POST /api/manage/export) and download it.

import { api } from "./api.js";
import { escapeHtml, openModal, closeModal } from "./ui.js";

const OPTIONS_KEY = "grok_img2img.manage.exportOptions";
const POLL_MS = 500;

const CHOICES = [
  ["images", "Result images", "The generated PNGs"],
  ["side_by_side", "Side-by-side", "Source and result next to each other, one PNG each"],
  ["include_sources", "Sources", "The image each result was made from, as the engine saw it (cropped if it was)"],
  ["include_originals", "Uncropped originals", "Also the stored source when a crop was applied"],
  ["include_references", "References", "The reference images each result was generated with"],
  ["sidecar", "Manifest", "manifest.json and manifest.csv: prompt, rating, engine, files, lineage per result"],
  ["html_report", "HTML report", "report.html to browse or print (to PDF) straight from the unzipped folder"],
];
const DEFAULTS = { images: true, side_by_side: false, include_sources: false, include_originals: false,
  include_references: false, sidecar: true, html_report: true, group_by: "prompt" };

function loadOptions() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

// source: { filter } for the current view or { report_id } for a saved report.
// summary: one line saying what's being exported.
export function openExportModal({ source, name, summary }) {
  const o = loadOptions();
  const modal = openModal(`
    <h3>Export</h3>
    <p class="modal-note">${escapeHtml(summary)}</p>
    <div class="field"><label for="mExportName">Name</label><input id="mExportName" type="text" maxlength="120" /></div>
    <div class="export-choices">
      ${CHOICES.map(([k, label, hint]) => `
        <label class="export-choice" title="${escapeHtml(hint)}">
          <input type="checkbox" data-opt="${k}" ${o[k] ? "checked" : ""} /> ${label}
          <span class="export-choice-hint">${escapeHtml(hint)}</span>
        </label>`).join("")}
    </div>
    <div class="field export-group">
      <label for="mExportGroup">Group the HTML report by</label>
      <select id="mExportGroup">
        <option value="prompt" ${o.group_by === "prompt" ? "selected" : ""}>Prompt</option>
        <option value="project" ${o.group_by === "project" ? "selected" : ""}>Library</option>
      </select>
    </div>
    <div id="mExportProgress" class="export-progress" hidden><div class="export-progress-bar"></div></div>
    <div id="mExportStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost" type="button">Close</button>
      <a id="mDownload" class="btn-primary" hidden>Download</a>
      <button id="mGo" class="btn-primary" type="button">Export</button>
    </div>
  `);
  modal.querySelector("#mExportName").value = name || "export";
  const status = modal.querySelector("#mExportStatus");
  const go = modal.querySelector("#mGo");
  const originals = modal.querySelector('[data-opt="include_originals"]');
  const sources = modal.querySelector('[data-opt="include_sources"]');
  const syncOriginals = () => {
    originals.disabled = !sources.checked;
    originals.closest("label").classList.toggle("disabled", !sources.checked);
  };
  sources.addEventListener("change", syncOriginals);
  syncOriginals();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);

  go.addEventListener("click", async () => {
    const options = { group_by: modal.querySelector("#mExportGroup").value };
    for (const [k] of CHOICES) options[k] = modal.querySelector(`[data-opt="${k}"]`).checked;
    options.include_originals = options.include_originals && options.include_sources;
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // ignore
    }
    go.disabled = true;
    status.textContent = "Starting…";
    let job;
    try {
      job = await api.manage.startExport({ ...source, name: modal.querySelector("#mExportName").value.trim() || undefined, options });
    } catch (err) {
      status.textContent = `Export failed: ${err.message}`;
      go.disabled = false;
      return;
    }
    poll(modal, job.id);
  });
}

async function poll(modal, jobId) {
  const status = modal.querySelector("#mExportStatus");
  const bar = modal.querySelector("#mExportProgress");
  bar.hidden = false;
  for (;;) {
    if (!modal.isConnected || !modal.querySelector("#mExportProgress")) return; // dialog closed; the job carries on
    let job;
    try {
      job = await api.manage.exportStatus(jobId);
    } catch (err) {
      status.textContent = `Lost track of the export: ${err.message}`;
      return;
    }
    const pct = job.total ? Math.round((100 * job.done) / job.total) : 0;
    bar.firstElementChild.style.width = `${pct}%`;
    if (job.status === "running") {
      status.textContent = job.total ? `Adding ${job.done} of ${job.total} results…` : "Collecting results…";
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (job.status === "error") {
      status.textContent = `Export failed: ${job.error}`;
      modal.querySelector("#mGo").disabled = false;
      return;
    }
    status.textContent = `Ready: ${job.file_name} (${job.total} results).`;
    const link = modal.querySelector("#mDownload");
    link.href = `/api/manage/export/${jobId}/download`;
    link.download = job.file_name;
    link.hidden = false;
    modal.querySelector("#mGo").hidden = true;
    link.click();
    return;
  }
}
