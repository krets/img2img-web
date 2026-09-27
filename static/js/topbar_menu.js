// The topbar's ☰ menu, shared by the Image Library (/) and Review & Export
// (/manage). Each page has its own menu markup and wires its own items, since
// some only make sense on one page; the dialogs usable from either live here.

import { api } from "./api.js";
import { HOTKEY_GROUPS } from "./hotkeys.js";
import { escapeHtml, openModal, closeModal, isModalOpen, openConfirmModal, formatElapsed, refThumbUrl } from "./ui.js";

const menu = document.getElementById("topbarMenu");
const menuBtn = document.getElementById("topbarMenuBtn");
const menuPanel = document.getElementById("topbarMenuPanel");

// Hamburger menu: same open/close behavior as the library page's project
// panel. Opening one closes the other for free -- each button is "outside" the other's menu, so
// its mousedown trips the other's outside-click handler.
function isTopbarMenuOpen() {
  return menuPanel.style.display !== "none";
}
export function setTopbarMenuOpen(open) {
  menuPanel.style.display = open ? "flex" : "none";
  menuBtn.setAttribute("aria-expanded", String(open));
}
export function initTopbarMenu() {
  menuBtn.addEventListener("click", () => setTopbarMenuOpen(!isTopbarMenuOpen()));
  menuPanel.addEventListener("click", (e) => {
    if (e.target.closest(".topbar-menu-item")) setTopbarMenuOpen(false);
  });
  document.addEventListener("mousedown", (e) => {
    if (isTopbarMenuOpen() && !menu.contains(e.target)) setTopbarMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isTopbarMenuOpen()) return;
    setTopbarMenuOpen(false);
    menuBtn.focus();
  });
}

// Hotkeys help overlay -- content comes from HOTKEY_GROUPS in hotkeys.js.
function renderKeycaps(keys) {
  return keys
    .map((key) => key.split("+").map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join("+"))
    .join("<span>/</span>");
}
export function isHotkeysModalOpen() {
  return isModalOpen() && !!document.querySelector("#modalContent .hotkey-groups");
}
export function openHotkeysModal() {
  setTopbarMenuOpen(false);
  const groups = HOTKEY_GROUPS.map(
    (g) => `
      <div class="hotkey-group">
        <div class="hotkey-group-title">${escapeHtml(g.title)}</div>
        ${g.rows
          .map(
            (r) => `
          <div class="hotkey-row">
            <span class="hotkey-desc">${escapeHtml(r.desc)}</span>
            <span class="hotkey-keys">${r.keys ? renderKeycaps(r.keys) : escapeHtml(r.gesture)}</span>
          </div>`
          )
          .join("")}
      </div>`
  ).join("");
  const modal = openModal(`
    <h3>Hotkeys</h3>
    <div class="hotkey-groups">${groups}</div>
    <div class="modal-actions"><button id="mClose" class="btn-ghost" type="button">Close</button></div>
  `);
  modal.querySelector("#mClose").addEventListener("click", closeModal);
}

// ---------------------------------------------------------------------------
// Generation log
// ---------------------------------------------------------------------------

// Ring buffer of finished (done/error) jobs kept server-side -- see jobs.py.
// Unlike the queue overlay's per-image chits (which vanish ~10s after a job
// finishes), this survives long enough to review failures you weren't
// watching for live. It's still in-memory only, so it resets on server restart.
export async function openLogModal() {
  renderLogModal(await api.getQueueLog());
}

function formatLogTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

// Each entry is a native <details> so the list stays scannable -- only the
// one-line summary shows by default, collapsed until clicked.
function renderLogModal(entries) {
  const rowsHtml = entries.length
    ? entries
        .map((j) => {
          const failed = j.status === "error";
          return `
        <details class="log-item ${failed ? "error" : "done"}">
          <summary class="log-item-header">
            <span class="log-item-status ${failed ? "error" : "done"}">${failed ? "Failed" : "Done"}</span>
            <span class="log-item-name">${escapeHtml(j.image_name)}</span>
            <span class="log-item-engine">${escapeHtml(j.engine)}</span>
            <span class="log-item-duration">${j.finished_at ? formatElapsed(j.finished_at - j.created_at) : ""}</span>
            <span class="log-item-time">${formatLogTime(j.finished_at)}</span>
          </summary>
          ${j.prompt_text ? `<div class="log-item-prompt">${escapeHtml(j.prompt_text)}</div>` : ""}
          ${failed ? `<div class="log-item-error">${escapeHtml(j.error || "Unknown error")}</div>` : ""}
        </details>
      `;
        })
        .join("")
    : `<div class="empty-state">No generation activity yet.</div>`;

  const modal = openModal(`
    <h3>Generation Log</h3>
    <div class="log-list">${rowsHtml}</div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

function formatDeletedAt(ts) {
  if (!ts) return "";
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString();
}

function daysRemaining(deletedAt, retentionDays = 2) {
  if (!deletedAt) return 0;
  const expiresAt = new Date(deletedAt.replace(" ", "T") + "Z").getTime() + retentionDays * 86400000;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));
}

// projectId/projectName: the library whose trashed items to list, or null for
// just the trashed libraries. onChange(kind) runs after a restore or bulk trash
// so the page can refresh; kind is "images", "results", "references" or "projects".
let trashOpts = {};
export function openTrashModal(opts) {
  trashOpts = opts;
  return renderTrashModal();
}

async function renderTrashModal(statusMessage = "") {
  const { projectId, projectName, onChange = () => {} } = trashOpts;
  const [rawProjectTrash, trashedProjects] = await Promise.all([
    projectId ? api.getProjectTrash(projectId) : Promise.resolve({}),
    api.getTrashedProjects(),
  ]);
  // Defensive against a backend that hasn't been restarted since reference_images
  // was added to this response -- without this, an old server's response would
  // throw below and silently break the whole Trash button (no console-visible UI
  // error, since it's an unhandled rejection inside an async click handler).
  const projectTrash = {
    images: rawProjectTrash.images || [],
    results: rawProjectTrash.results || [],
    reference_images: rawProjectTrash.reference_images || [],
  };
  const currentProjectName = projectName || "this project";

  const imagesHtml = projectTrash.images.length
    ? projectTrash.images
        .map(
          (img) => `
      <div class="trash-item">
        <img src="/api/images/${img.id}/thumbnail" loading="lazy" />
        <span class="trash-name">${escapeHtml(img.display_name)}</span>
        <span class="trash-meta">Deleted ${formatDeletedAt(img.deleted_at)} · ${daysRemaining(img.deleted_at)}d left</span>
        <button class="btn-ghost small" data-restore-image="${img.id}">Restore</button>
        <button class="btn-danger small" data-purge-image="${img.id}">Delete Forever</button>
      </div>
    `
        )
        .join("")
    : `<div class="empty-state">No trashed images.</div>`;

  const resultsHtml = projectTrash.results.length
    ? projectTrash.results
        .map(
          (r) => `
      <div class="trash-item">
        <img src="/api/results/${r.id}/thumbnail" loading="lazy" />
        <span class="trash-name">${escapeHtml(r.image_display_name)} <span class="badge ${r.evaluation}">${r.evaluation}</span></span>
        <span class="trash-meta">Deleted ${formatDeletedAt(r.deleted_at)} · ${daysRemaining(r.deleted_at)}d left</span>
        <button class="btn-ghost small" data-restore-result="${r.id}">Restore</button>
        <button class="btn-danger small" data-purge-result="${r.id}">Delete Forever</button>
      </div>
    `
        )
        .join("")
    : `<div class="empty-state">No trashed results.</div>`;

  const referencesHtml = projectTrash.reference_images.length
    ? projectTrash.reference_images
        .map(
          (ref) => `
      <div class="trash-item">
        <img src="${refThumbUrl(ref)}" loading="lazy" />
        <span class="trash-name">${escapeHtml(ref.display_name)}</span>
        <span class="trash-meta">Deleted ${formatDeletedAt(ref.deleted_at)} · ${daysRemaining(ref.deleted_at)}d left</span>
        <button class="btn-ghost small" data-restore-reference="${ref.id}">Restore</button>
        <button class="btn-danger small" data-purge-reference="${ref.id}">Delete Forever</button>
      </div>
    `
        )
        .join("")
    : `<div class="empty-state">No trashed reference images.</div>`;

  const projectsHtml = trashedProjects.length
    ? trashedProjects
        .map(
          (p) => `
      <div class="trash-item">
        <span class="trash-name">${escapeHtml(p.name)}</span>
        <span class="trash-meta">Deleted ${formatDeletedAt(p.deleted_at)} · ${daysRemaining(p.deleted_at)}d left</span>
        <button class="btn-ghost small" data-restore-project="${p.id}">Restore</button>
        <button class="btn-danger small" data-purge-project="${p.id}">Delete Forever</button>
      </div>
    `
        )
        .join("")
    : `<div class="empty-state">No trashed projects.</div>`;

  const modal = openModal(`
    <h3>Trash</h3>
    <div class="trash-section">
      ${projectId ? `
      <div class="panel-header">
        <span>${escapeHtml(currentProjectName)} — Images</span>
        <button id="mTrashNo" class="btn-ghost small">Trash all NO results</button>
      </div>
      <div class="trash-list">${imagesHtml}</div>
      <div class="panel-header"><span>${escapeHtml(currentProjectName)} — Results</span></div>
      <div class="trash-list">${resultsHtml}</div>
      <div class="panel-header"><span>${escapeHtml(currentProjectName)} — References</span></div>
      <div class="trash-list">${referencesHtml}</div>` : ""}
      <div class="panel-header"><span>Trashed Projects</span></div>
      <div class="trash-list">${projectsHtml}</div>
    </div>
    <div id="mTrashStatus" class="status-line">${escapeHtml(statusMessage)}</div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);

  modal.querySelector("#mCancel").addEventListener("click", closeModal);

  modal.querySelector("#mTrashNo")?.addEventListener("click", async () => {
    const { trashed } = await api.trashNoResults(projectId);
    await onChange("images");
    await renderTrashModal(`Trashed ${trashed.length} NO-rated result(s).`);
  });

  modal.querySelectorAll("[data-restore-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.restoreImage(btn.dataset.restoreImage);
      await onChange("images");
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-purge-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await openConfirmModal({
        title: "Delete Forever",
        message: "Permanently delete this image and its results? This cannot be undone.",
        confirmLabel: "Delete Forever",
        danger: true,
      });
      if (!ok) return renderTrashModal(); // confirm modal replaced this one -- restore it
      await api.permanentlyDeleteImage(btn.dataset.purgeImage);
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-restore-result]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.restoreResult(btn.dataset.restoreResult);
      await onChange("results");
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-purge-result]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await openConfirmModal({
        title: "Delete Forever",
        message: "Permanently delete this result? This cannot be undone.",
        confirmLabel: "Delete Forever",
        danger: true,
      });
      if (!ok) return renderTrashModal(); // confirm modal replaced this one -- restore it
      await api.permanentlyDeleteResult(btn.dataset.purgeResult);
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-restore-reference]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.restoreReferenceImage(btn.dataset.restoreReference);
      await onChange("references");
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-purge-reference]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await openConfirmModal({
        title: "Delete Forever",
        message: "Permanently delete this reference image? This cannot be undone.",
        confirmLabel: "Delete Forever",
        danger: true,
      });
      if (!ok) return renderTrashModal(); // confirm modal replaced this one -- restore it
      await api.permanentlyDeleteReferenceImage(btn.dataset.purgeReference);
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-restore-project]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.restoreProject(btn.dataset.restoreProject);
      await onChange("projects");
      await renderTrashModal();
    });
  });
  modal.querySelectorAll("[data-purge-project]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await openConfirmModal({
        title: "Delete Forever",
        message: "Permanently delete this project and everything in it? This cannot be undone.",
        confirmLabel: "Delete Forever",
        danger: true,
      });
      if (!ok) return renderTrashModal(); // confirm modal replaced this one -- restore it
      await api.permanentlyDeleteProject(btn.dataset.purgeProject);
      await renderTrashModal();
    });
  });
}
