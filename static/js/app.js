import { api } from "./api.js";
import { initABViewer } from "./viewer.js";
import { initHotkeys, HOTKEY_GROUPS } from "./hotkeys.js";
import { initPanels } from "./panels.js";
import {
  escapeHtml,
  escapeAttr,
  debounce,
  plural,
  parseDbTime,
  formatRelativeTime,
  openModal,
  closeModal,
  modalBack,
  pushModalBack,
  setModalOnClose,
  openConfirmModal,
  openImageLightbox,
  openItemMenu,
  formatElapsed,
  refThumbUrl,
} from "./ui.js";
import { initTopbarMenu, openHotkeysModal, isHotkeysModalOpen, openLogModal, openTrashModal } from "./topbar_menu.js";
import { openSettingsModal } from "./settings.js";
import { prefetchImages } from "./prefetch.js";

const state = {
  projects: [],
  currentProjectId: null,
  images: [],
  currentImageId: null,
  currentImage: null, // full detail incl. results
  prompts: [],
  selectedPromptId: null, // saved prompt last picked from the dropdown; null = ad-hoc
  sort: "recent_result",
  filter: "all",
  search: "",
  queue: [], // background generation jobs, global across projects
  // Failed jobs, keyed by job id, kept until dismissed from their results-
  // panel tile. The server drops finished jobs from /api/queue after a few
  // seconds, which made a failure easy to miss; this keeps it visible (as an
  // error chit and a failed tile) for the rest of the page session.
  failedJobs: new Map(),
  queueExpanded: false,
  multiSelectMode: false,
  selectedImageIds: new Set(),
  referenceImages: [], // this project's reference-image library (separate pool from images/source)
  referenceImageIds: [], // ids picked from referenceImages for the current generation, persists like engine/aspect ratio
  sidebarTab: "images", // "images" | "references"
  // Lineage: images promoted from a result carry parent_image_id; when
  // grouping is on they're nested under that parent in the sidebar.
  groupByLineage: localStorage.getItem("grok_img2img.groupByLineage") !== "0",
  collapsedImageIds: loadCollapsedImageIds(), // parents whose children are hidden
  compareAgainstId: null, // ancestor image id shown as the viewer's base instead of the current image's own source
  // The "Derived from a result of..." line and its lineage trail are useful
  // detail but noisy to have open by default (the trail especially, since it
  // grows one crumb per generation) -- collapsed behind a toggle until asked
  // for, remembered across images/sessions like groupByLineage above.
  provenanceExpanded: localStorage.getItem("grok_img2img.provenanceExpanded") === "1",
  config: null, // server config (incl. default_max_dim), loaded once at startup
};

function loadCollapsedImageIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("grok_img2img.collapsedImageIds")) || []);
  } catch {
    return new Set();
  }
}
function saveCollapsedImageIds() {
  try {
    localStorage.setItem("grok_img2img.collapsedImageIds", JSON.stringify([...state.collapsedImageIds]));
  } catch {
    // storage full/unavailable -- collapse state just won't persist
  }
}

// job ids we've already reacted to a done/error transition for, so the
// finished-job grace window (server keeps them ~10s) doesn't retrigger a reload.
const handledTerminalJobIds = new Set();

const els = {
  projectMenu: document.getElementById("projectMenu"),
  projectMenuBtn: document.getElementById("projectMenuBtn"),
  projectMenuName: document.getElementById("projectMenuName"),
  projectPanel: document.getElementById("projectPanel"),
  comfyStatsBtn: document.getElementById("comfyStatsBtn"),
  comfyStatsBarFill: document.getElementById("comfyStatsBarFill"),
  comfyStatsLabel: document.getElementById("comfyStatsLabel"),
  topbarMenu: document.getElementById("topbarMenu"),
  topbarMenuBtn: document.getElementById("topbarMenuBtn"),
  topbarMenuPanel: document.getElementById("topbarMenuPanel"),
  hotkeysBtn: document.getElementById("hotkeysBtn"),
  trashBtn: document.getElementById("trashBtn"),
  exportLink: document.getElementById("exportLink"),
  settingsBtn: document.getElementById("settingsBtn"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  filterSelect: document.getElementById("filterSelect"),
  uploadDrop: document.getElementById("uploadDrop"),
  uploadInput: document.getElementById("uploadInput"),
  uploadClickPasteToggle: document.getElementById("uploadClickPasteToggle"),
  autoGenOnUploadToggle: document.getElementById("autoGenOnUploadToggle"),
  uploadStatus: document.getElementById("uploadStatus"),
  libraryMenuBtn: document.getElementById("libraryMenuBtn"),
  imagesTabBtn: document.getElementById("imagesTabBtn"),
  referencesTabBtn: document.getElementById("referencesTabBtn"),
  imagesTabPanel: document.getElementById("imagesTabPanel"),
  referencesTabPanel: document.getElementById("referencesTabPanel"),
  referenceUploadDrop: document.getElementById("referenceUploadDrop"),
  referenceUploadInput: document.getElementById("referenceUploadInput"),
  referenceUploadClickPasteToggle: document.getElementById("referenceUploadClickPasteToggle"),
  referenceUploadStatus: document.getElementById("referenceUploadStatus"),
  referenceLibraryGrid: document.getElementById("referenceLibraryGrid"),
  duplicatesBtn: document.getElementById("duplicatesBtn"),
  logsBtn: document.getElementById("logsBtn"),
  multiSelectBar: document.getElementById("multiSelectBar"),
  multiSelectCount: document.getElementById("multiSelectCount"),
  multiSelectMoveBtn: document.getElementById("multiSelectMoveBtn"),
  multiSelectDoneBtn: document.getElementById("multiSelectDoneBtn"),
  imageList: document.getElementById("imageList"),
  viewer: document.getElementById("viewer"),
  detailsEmpty: document.getElementById("detailsEmpty"),
  detailsContent: document.getElementById("detailsContent"),
  displayNameInput: document.getElementById("displayNameInput"),
  provenanceLine: document.getElementById("provenanceLine"),
  commentInput: document.getElementById("commentInput"),
  promptMenu: document.getElementById("promptMenu"),
  promptMenuBtn: document.getElementById("promptMenuBtn"),
  promptMenuName: document.getElementById("promptMenuName"),
  promptPanel: document.getElementById("promptPanel"),
  promptTextarea: document.getElementById("promptTextarea"),
  engineSelect: document.getElementById("engineSelect"),
  aspectRatioSelect: document.getElementById("aspectRatioSelect"),
  comfyWorkflowRow: document.getElementById("comfyWorkflowRow"),
  comfyWorkflowSelect: document.getElementById("comfyWorkflowSelect"),
  sam3Fields: document.getElementById("sam3Fields"),
  sam3PromptInput: document.getElementById("sam3PromptInput"),
  sam3PromptHistoryList: document.getElementById("sam3PromptHistoryList"),
  sam3ScaleByField: document.getElementById("sam3ScaleByField"),
  sam3ScaleByInput: document.getElementById("sam3ScaleByInput"),
  sam3ScaleXField: document.getElementById("sam3ScaleXField"),
  sam3ScaleXInput: document.getElementById("sam3ScaleXInput"),
  sam3ScaleYField: document.getElementById("sam3ScaleYField"),
  sam3ScaleYInput: document.getElementById("sam3ScaleYInput"),
  sam3LrPinInput: document.getElementById("sam3LrPinInput"),
  sam3TbPinInput: document.getElementById("sam3TbPinInput"),
  preprocessNote: document.getElementById("preprocessNote"),
  preprocessNoteText: document.getElementById("preprocessNoteText"),
  preprocessClearBtn: document.getElementById("preprocessClearBtn"),
  referenceImagesField: document.getElementById("referenceImagesField"),
  referenceImagesHint: document.getElementById("referenceImagesHint"),
  referenceImageList: document.getElementById("referenceImageList"),
  addReferenceImageBtn: document.getElementById("addReferenceImageBtn"),
  sam3PlaceBtn: document.getElementById("sam3PlaceBtn"),
  generateBtn: document.getElementById("generateBtn"),
  uploadResultInput: document.getElementById("uploadResultInput"),
  generateStatus: document.getElementById("generateStatus"),
  resultCount: document.getElementById("resultCount"),
  resultGrid: document.getElementById("resultGrid"),
  deleteImageBtn: document.getElementById("deleteImageBtn"),
  revisedPrompt: document.getElementById("revisedPrompt"),
  modalOverlay: document.getElementById("modalOverlay"),
  modalContent: document.getElementById("modalContent"),
  queueOverlay: document.getElementById("queueOverlay"),
  queueOverlayBar: document.getElementById("queueOverlayBar"),
  queueOverlayHeader: document.getElementById("queueOverlayHeader"),
  queueOverlayCount: document.getElementById("queueOverlayCount"),
  queueOverlayElapsed: document.getElementById("queueOverlayElapsed"),
  queueOverlayList: document.getElementById("queueOverlayList"),
};

const abViewer = initABViewer(els.viewer);
initPanels();

// navigator.clipboard is only exposed in secure contexts (localhost/HTTPS) --
// unavailable over plain LAN HTTP. Prompt copy falls back to a "show prompt"
// modal the user can Ctrl+A/Ctrl+C from manually instead of silently failing.
const clipboardAvailable = !!(navigator.clipboard && window.isSecureContext);

// Fallback for prompt-copy when navigator.clipboard is unavailable (insecure
// context, e.g. plain LAN HTTP): show the text in a selectable readonly box
// instead of failing silently, so Ctrl+A / Ctrl+C still works manually.
function showPromptModal(text) {
  const modal = openModal(`
    <h3>Prompt text</h3>
    <p class="modal-note">Clipboard access isn't available on this connection — select all and copy manually.</p>
    <div class="field"><textarea id="mPromptText" class="prompt-edit-textarea" rows="8" readonly></textarea></div>
    <div class="modal-actions"><button id="mClose" class="btn-ghost">Close</button></div>
  `);
  const ta = modal.querySelector("#mPromptText");
  ta.value = text;
  modal.querySelector("#mClose").addEventListener("click", closeModal);
  ta.focus();
  ta.select();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const RECENT_PROJECT_COUNT = 4;
const PROJECT_OPENED_KEY = "grok_img2img.projectOpenedAt";
const PROJECT_SORT_KEY = "grok_img2img.projectSort";
const PROJECT_PINNED_KEY = "grok_img2img.pinnedProjects";

// Starred projects, shown above Recent. Client-side like projectOpenedAt.
const pinnedProjects = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PROJECT_PINNED_KEY)) || []);
  } catch {
    return new Set();
  }
})();
function toggleProjectPinned(id) {
  if (!pinnedProjects.delete(id)) pinnedProjects.add(id);
  try {
    localStorage.setItem(PROJECT_PINNED_KEY, JSON.stringify([...pinnedProjects]));
  } catch {
    // storage full/unavailable -- pins just won't persist
  }
}

// When each project was last opened *in this browser* ({ id: epoch ms }) --
// drives the panel's Recent list. Client-side like lastProjectId; a project
// never opened here ranks by its last generation, then its creation date.
const projectOpenedAt = (() => {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_OPENED_KEY)) || {};
  } catch {
    return {};
  }
})();
function markProjectOpened(id) {
  projectOpenedAt[id] = Date.now();
  try {
    localStorage.setItem(PROJECT_OPENED_KEY, JSON.stringify(projectOpenedAt));
  } catch {
    // storage full/unavailable -- recents just won't persist
  }
}

// 0 for a project with no results yet, so those sort below any generated one.
function projectGeneratedTime(p) {
  return parseDbTime(p.last_generated);
}
const PROJECT_SORTS = {
  recent: {
    label: "Recently opened",
    cmp: (a, b) =>
      (projectOpenedAt[b.id] || 0) - (projectOpenedAt[a.id] || 0) ||
      projectGeneratedTime(b) - projectGeneratedTime(a) ||
      parseDbTime(b.date_created) - parseDbTime(a.date_created),
  },
  generated: {
    label: "Last generated",
    cmp: (a, b) => projectGeneratedTime(b) - projectGeneratedTime(a) || parseDbTime(b.date_created) - parseDbTime(a.date_created),
  },
  name: { label: "Name (A–Z)", cmp: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) },
  created: { label: "Newest created", cmp: (a, b) => parseDbTime(b.date_created) - parseDbTime(a.date_created) },
  images: { label: "Most sources", cmp: (a, b) => b.image_count - a.image_count },
  results: { label: "Most results", cmp: (a, b) => b.result_count - a.result_count },
};

// UI state of the project manager panel (the dropdown under the topbar's
// project button).
const projectPanel = {
  open: false,
  sort: PROJECT_SORTS[localStorage.getItem(PROJECT_SORT_KEY)] ? localStorage.getItem(PROJECT_SORT_KEY) : "recent",
  filter: "",
  renamingId: null,
  confirmDeleteId: null,
};

async function refreshProjects() {
  state.projects = await api.listProjects();
  renderProjectMenuButton();
}

async function loadProjects() {
  await refreshProjects();

  const lastId = localStorage.getItem("lastProjectId");
  const match = state.projects.find((p) => p.id === lastId);
  const fallback = [...state.projects].sort(PROJECT_SORTS.recent.cmp)[0];
  state.currentProjectId = match ? match.id : fallback?.id || null;
  if (state.currentProjectId) {
    localStorage.setItem("lastProjectId", state.currentProjectId);
    // Seeds the recent list for whatever was already open before it existed.
    if (!projectOpenedAt[state.currentProjectId]) markProjectOpened(state.currentProjectId);
  }
  renderProjectMenuButton();

  if (state.currentProjectId) {
    await Promise.all([loadImages(), loadReferenceImages()]);
  } else {
    // Last project was just trashed -- don't leave its images on screen.
    state.images = [];
    state.referenceImages = [];
    renderImageList();
    renderReferenceLibrary();
  }
}

function resetProjectSelection() {
  state.currentImageId = null;
  state.currentImage = null;
  state.referenceImageIds = [];
  renderReferenceImages();
  renderDetails();
}

// Reference images picked for generation, per project ({ projectId: [ids] }).
// Reference images belong to one project's library, so the strip can only show
// the open project's picks; stashing them here lets a detour through another
// project leave the working set intact for when you come back.
const referencePicksByProject = new Map();

// Makes `id` the open project and bumps it to the top of the recent list.
async function switchProject(id) {
  closeProjectPanel();
  markProjectOpened(id);
  if (id === state.currentProjectId) return;
  referencePicksByProject.set(state.currentProjectId, state.referenceImageIds);
  state.currentProjectId = id;
  localStorage.setItem("lastProjectId", id);
  renderProjectMenuButton();
  resetProjectSelection();
  // Set before the load so loadReferenceImages prunes any that were deleted meanwhile.
  state.referenceImageIds = [...(referencePicksByProject.get(id) || [])];
  await Promise.all([loadImages(), loadReferenceImages()]);
}

function renderProjectMenuButton() {
  const current = state.projects.find((p) => p.id === state.currentProjectId);
  const name = current ? current.name : state.projects.length ? "Select a project" : "No projects";
  els.projectMenuName.textContent = name;
  els.projectMenuBtn.title = current ? `${name} — switch, rename or delete projects` : "Switch, rename or delete projects";
}

function openProjectPanel() {
  projectPanel.open = true;
  projectPanel.filter = "";
  projectPanel.renamingId = null;
  projectPanel.confirmDeleteId = null;
  els.projectMenuBtn.setAttribute("aria-expanded", "true");
  els.projectPanel.style.display = "flex";
  els.projectPanel.innerHTML = `
    <div class="project-panel-head">
      <input id="projectFilterInput" class="project-panel-search" type="text" placeholder="Search projects..." autocomplete="off" />
      <button id="projectNewBtn" class="btn-ghost small" type="button">+ New Project</button>
    </div>
    <div id="projectPanelRecent" class="project-panel-recent"></div>
    <div class="project-panel-subhead">
      <span id="projectAllTitle" class="project-section-title"></span>
      <select id="projectSortSelect" title="Sort the project list">
        ${Object.entries(PROJECT_SORTS)
          .map(([key, s]) => `<option value="${key}"${key === projectPanel.sort ? " selected" : ""}>${s.label}</option>`)
          .join("")}
      </select>
    </div>
    <div id="projectPanelList" class="project-panel-list"></div>
    <div id="projectPanelStatus" class="project-panel-status"></div>
  `;
  renderProjectPanelRows();
  els.projectPanel.querySelector("#projectFilterInput").focus();
  // The cached list may be stale on counts (uploads, generations, trashing
  // since it was loaded); refresh it in the background and redraw.
  api
    .listProjects()
    .then((projects) => {
      if (!projectPanel.open) return;
      const changed = JSON.stringify(projects) !== JSON.stringify(state.projects);
      state.projects = projects;
      renderProjectMenuButton();
      // Skipped when nothing moved so rows aren't swapped out from under the cursor.
      if (changed && !projectPanel.renamingId && !projectPanel.confirmDeleteId) renderProjectPanelRows();
    })
    .catch(() => {});
}

function closeProjectPanel() {
  if (!projectPanel.open) return;
  projectPanel.open = false;
  projectPanel.renamingId = null;
  projectPanel.confirmDeleteId = null;
  els.projectMenuBtn.setAttribute("aria-expanded", "false");
  els.projectPanel.style.display = "none";
  els.projectPanel.innerHTML = "";
}

function setProjectPanelStatus(message) {
  const el = els.projectPanel.querySelector("#projectPanelStatus");
  if (el) el.textContent = message || "";
}

// timeMode: which timestamp to show on the right -- "recent" (last opened),
// "generated" or "created".
function renderProjectRow(p, timeMode) {
  const cls = `project-row${p.id === state.currentProjectId ? " current" : ""}`;

  if (projectPanel.confirmDeleteId === p.id) {
    return `
      <div class="${cls} confirming" data-project-id="${p.id}">
        <div class="project-row-main">
          <div class="project-row-name">Move “${escapeHtml(p.name)}” to Trash?</div>
          <div class="project-row-desc">Its ${plural(p.image_count, "source")} and ${plural(p.result_count, "result")} can be restored from Trash for 2 days.</div>
        </div>
        <div class="project-row-actions visible">
          <button class="btn-ghost small" type="button" data-action="cancel-delete">Cancel</button>
          <button class="btn-danger small" type="button" data-action="confirm-delete">Move to Trash</button>
        </div>
      </div>`;
  }

  const nameHtml =
    projectPanel.renamingId === p.id
      ? `<input class="project-row-rename" type="text" data-project-id="${p.id}" />`
      : `<div class="project-row-name">${escapeHtml(p.name)}</div>`;

  let timeLabel;
  if (timeMode === "created") timeLabel = `created ${formatRelativeTime(parseDbTime(p.date_created))}`;
  else if (timeMode === "generated")
    timeLabel = p.last_generated ? `generated ${formatRelativeTime(projectGeneratedTime(p))}` : "no results yet";
  else timeLabel = projectOpenedAt[p.id] ? `opened ${formatRelativeTime(projectOpenedAt[p.id])}` : "not opened yet";

  return `
    <div class="${cls}" data-project-id="${p.id}">
      <div class="project-row-main">
        ${nameHtml}
        ${p.description ? `<div class="project-row-desc">${escapeHtml(p.description)}</div>` : ""}
        <div class="project-row-stats">
          <span>${plural(p.image_count, "source")}</span>
          <span>${plural(p.result_count, "result")}</span>
          <span>${plural(p.reference_count, "reference")}</span>
          <span class="project-row-time">${timeLabel}</span>
        </div>
      </div>
      <button class="project-row-btn project-row-pin${pinnedProjects.has(p.id) ? " on" : ""}" type="button" data-action="pin" title="${pinnedProjects.has(p.id) ? "Unpin project" : "Pin project to the top"}">${pinnedProjects.has(p.id) ? "★" : "☆"}</button>
      <div class="project-row-actions">
        <button class="project-row-btn" type="button" data-action="rename" title="Rename project">✎</button>
        <button class="project-row-btn danger" type="button" data-action="delete" title="Move project to Trash">✕</button>
      </div>
    </div>`;
}

// Redraws just the row lists (not the search box / sort select), so typing in
// the filter keeps its focus.
function renderProjectPanelRows() {
  const recentEl = els.projectPanel.querySelector("#projectPanelRecent");
  const listEl = els.projectPanel.querySelector("#projectPanelList");
  if (!recentEl || !listEl) return;

  const needle = projectPanel.filter.trim().toLowerCase();
  const matches = state.projects.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || (p.description || "").toLowerCase().includes(needle),
  );
  const timeMode = projectPanel.sort === "generated" || projectPanel.sort === "created" ? projectPanel.sort : "recent";

  // Pinned and Recent sit above the main list, which then leaves out whatever
  // they show so no project appears twice. While searching they're skipped, as
  // they'd hide matches behind unrelated rows.
  let pinned = [];
  let recent = [];
  if (!needle) {
    pinned = state.projects
      .filter((p) => pinnedProjects.has(p.id))
      .sort(PROJECT_SORTS.name.cmp);
    const unpinned = state.projects.filter((p) => !pinnedProjects.has(p.id));
    // With RECENT_PROJECT_COUNT unpinned projects or fewer, Recent would just
    // repeat the whole rest of the list.
    if (unpinned.length > RECENT_PROJECT_COUNT) {
      recent = unpinned.sort(PROJECT_SORTS.recent.cmp).slice(0, RECENT_PROJECT_COUNT);
    }
  }
  const above = new Set([...pinned, ...recent].map((p) => p.id));
  const sorted = matches.filter((p) => !above.has(p.id)).sort(PROJECT_SORTS[projectPanel.sort].cmp);

  const section = (title, rows) =>
    rows.length ? `<div class="project-section-title">${title}</div>${rows.map((p) => renderProjectRow(p, "recent")).join("")}` : "";
  recentEl.innerHTML = section("Pinned", pinned) + section("Recent", recent);
  recentEl.style.display = recentEl.innerHTML ? "" : "none";

  els.projectPanel.querySelector("#projectAllTitle").textContent = needle
    ? `${matches.length} of ${plural(state.projects.length, "project")}`
    : above.size
      ? `Other projects (${sorted.length})`
      : `All projects (${state.projects.length})`;
  listEl.innerHTML = sorted.length
    ? sorted.map((p) => renderProjectRow(p, timeMode)).join("")
    : `<div class="empty-state">${state.projects.length ? "No projects match." : "No projects yet."}</div>`;

  // Rename swaps the name for an input; fill and focus it after the redraw.
  const renameInput = els.projectPanel.querySelector(".project-row-rename");
  if (renameInput) startRenameInput(renameInput);
}

function startRenameInput(input) {
  const project = state.projects.find((p) => p.id === input.dataset.projectId);
  input.value = project?.name || "";
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const value = input.value;
    projectPanel.renamingId = null;
    if (save) renameProject(project.id, value);
    else renderProjectPanelRows();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // rename only -- keep the panel open
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function renameProject(id, newName) {
  const project = state.projects.find((p) => p.id === id);
  const name = newName.trim();
  if (project && name && name !== project.name) {
    try {
      const updated = await api.updateProject(id, { name });
      project.name = updated.name;
      renderProjectMenuButton();
      setProjectPanelStatus("");
    } catch (e) {
      setProjectPanelStatus(`Rename failed: ${e.message}`);
    }
  }
  renderProjectPanelRows();
}

async function deleteProject(id) {
  projectPanel.confirmDeleteId = null;
  try {
    await api.deleteProject(id);
  } catch (e) {
    setProjectPanelStatus(`Delete failed: ${e.message}`);
    renderProjectPanelRows();
    return;
  }
  setProjectPanelStatus("");
  if (id === state.currentProjectId) {
    resetProjectSelection();
    await loadProjects(); // falls back to the most recent remaining project
  } else {
    await refreshProjects();
  }
  renderProjectPanelRows();
}

els.projectMenuBtn.addEventListener("click", () => {
  if (projectPanel.open) closeProjectPanel();
  else openProjectPanel();
});

els.projectPanel.addEventListener("input", (e) => {
  if (e.target.id !== "projectFilterInput") return;
  projectPanel.filter = e.target.value;
  renderProjectPanelRows();
});

els.projectPanel.addEventListener("change", (e) => {
  if (e.target.id !== "projectSortSelect") return;
  projectPanel.sort = e.target.value;
  try {
    localStorage.setItem(PROJECT_SORT_KEY, projectPanel.sort);
  } catch {
    // sort choice just won't persist
  }
  renderProjectPanelRows();
});

els.projectPanel.addEventListener("keydown", (e) => {
  // Enter in the search box opens the top match.
  if (e.key !== "Enter" || e.target.id !== "projectFilterInput") return;
  const first = els.projectPanel.querySelector("#projectPanelList .project-row");
  if (first) switchProject(first.dataset.projectId);
});

els.projectPanel.addEventListener("click", (e) => {
  if (e.target.id === "projectNewBtn") {
    closeProjectPanel();
    openNewProjectModal();
    return;
  }
  const row = e.target.closest(".project-row");
  if (!row) return;
  const id = row.dataset.projectId;
  const action = e.target.closest("[data-action]")?.dataset.action;

  if (action === "pin") {
    toggleProjectPinned(id);
    renderProjectPanelRows();
  } else if (action === "rename") {
    projectPanel.confirmDeleteId = null;
    projectPanel.renamingId = id;
    renderProjectPanelRows();
  } else if (action === "delete") {
    projectPanel.renamingId = null;
    projectPanel.confirmDeleteId = id;
    renderProjectPanelRows();
  } else if (action === "cancel-delete") {
    projectPanel.confirmDeleteId = null;
    renderProjectPanelRows();
  } else if (action === "confirm-delete") {
    deleteProject(id);
  } else if (!row.classList.contains("confirming") && !e.target.closest(".project-row-rename")) {
    switchProject(id);
  }
});

document.addEventListener("mousedown", (e) => {
  if (projectPanel.open && !els.projectMenu.contains(e.target)) closeProjectPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !projectPanel.open) return;
  if (projectPanel.confirmDeleteId) {
    projectPanel.confirmDeleteId = null;
    renderProjectPanelRows();
  } else {
    closeProjectPanel();
    els.projectMenuBtn.focus();
  }
});

initTopbarMenu();

function showHotkeys() {
  closeProjectPanel();
  openHotkeysModal();
}
els.hotkeysBtn.addEventListener("click", showHotkeys);
// "?" toggles the overlay, but never opens over some other dialog.
function toggleHotkeysModal() {
  if (isHotkeysModalOpen()) closeModal();
  else if (els.modalOverlay.style.display === "none") showHotkeys();
}

function openNewProjectModal() {
  const modal = openModal(`
    <h3>New Project</h3>
    <div class="field"><label>Name</label><input id="mName" type="text" /></div>
    <div class="field"><label>Description (optional)</label><textarea id="mDesc" rows="2"></textarea></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Cancel</button>
      <button id="mCreate" class="btn-primary">Create</button>
    </div>
  `);
  const nameInput = modal.querySelector("#mName");
  nameInput.focus();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const createProject = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const description = modal.querySelector("#mDesc").value.trim();
    const project = await api.createProject(name, description);
    closeModal();
    await refreshProjects();
    await switchProject(project.id);
  };
  modal.querySelector("#mCreate").addEventListener("click", createProject);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
  });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// Two things can race a loadImages() fetch: a newer loadImages() call, and a
// local patch (a rating / active-result change applied straight to
// state.images, see below).
//  - A newer load carries fresher data than an older one, so an older response
//    that resolves after it must not overwrite it. A superseded load just waits
//    for the newest one, so callers (upload, job-finished refresh) still only
//    return once the list actually reflects their change.
//  - A local patch is applied only after its PUT resolved, so a load that
//    *started* before the patch may have read the pre-PUT value. Such a load
//    must not discard the patch (or vice versa) -- it replays the patches made
//    since it started onto its fresh data. Discarding the whole response
//    instead is what made newly uploaded images and just-finished generations
//    intermittently fail to appear: whatever that load was fetching was thrown
//    away, and nothing retried it.
let latestImagesLoad = 0; // id of the most recently started loadImages()
let latestImagesLoadPromise = null;
let loadsInFlight = 0;
let patchSeq = 0;
const localPatches = []; // { seq, apply(images) } made while any load was in flight

function loadImages() {
  if (!state.currentProjectId) return Promise.resolve();
  const loadId = ++latestImagesLoad;
  const patchesBefore = patchSeq;
  loadsInFlight++;
  latestImagesLoadPromise = (async () => {
    try {
      const images = await api.listImages(state.currentProjectId, {
        sort: state.sort,
        filter: state.filter,
        search: state.search,
      });
      if (loadId !== latestImagesLoad) return latestImagesLoadPromise.catch(() => {});
      for (const p of localPatches) if (p.seq > patchesBefore) p.apply(images);
      state.images = images;
      applyQueueOrdering();
      renderImageList();
    } finally {
      if (--loadsInFlight === 0) localPatches.length = 0;
    }
  })();
  return latestImagesLoadPromise;
}

// Applies `apply(images)` to the current list now, and remembers it so any
// loadImages() fetch already in flight replays it onto its (possibly stale)
// response instead of clobbering it.
function patchImagesLocally(apply) {
  apply(state.images);
  patchSeq++;
  if (loadsInFlight) localPatches.push({ seq: patchSeq, apply });
  renderImageList();
}

// True when the sidebar's current sort/filter depends on which evaluation is
// "active" for an image (sort by evaluation reads eval_rank; the YES/NO/MAYBE/
// UNRATED filters match on the active result's evaluation). Only in that case
// can rating or re-activating a result actually move/hide a row -- otherwise
// it's purely cosmetic (a chit color) and a local patch is safe.
function sidebarOrderDependsOnEvaluation() {
  return state.sort === "evaluation" || ["YES", "NO", "MAYBE", "UNRATED"].includes(state.filter);
}

// Rating a result changes only that one result's evaluation. Refetching and
// re-rendering the whole sidebar list for that (as loadImages() does) costs a
// query with per-image correlated subqueries and a full DOM patch pass, so it
// scales with total library size instead of with what actually changed. Most
// ratings don't need any of that: the sort/filter order in the sidebar is
// only affected when the *active* result of an image is re-rated under a
// sort/filter that depends on evaluation. Everywhere else, patch the chit's
// evaluation in local state and re-render the list from memory.
async function applyRatingToSidebar(imageId, resultId, value) {
  const img = state.images.find((i) => i.id === imageId);
  if (img && img.active_result_id === resultId && sidebarOrderDependsOnEvaluation()) {
    await loadImages();
    return;
  }
  if (img) {
    patchImagesLocally((images) => {
      const target = images.find((i) => i.id === imageId);
      if (!target) return;
      const entry = (target.result_evaluations || []).find((r) => r.id === resultId);
      if (entry) entry.evaluation = value;
      if (target.active_result_id === resultId) target.active_evaluation = value;
    });
  }
}

// Switching which result is "active" (clicking a tile, or a chit in the
// sidebar) is the same story as rating: cheap locally, but loadImages() pays
// for the whole library every time. Here *any* switch can change which
// evaluation counts as active, so (unlike rating) it's not narrowed to "only
// if resultId was already active".
async function applyActivateResultToSidebar(imageId, resultId) {
  const img = state.images.find((i) => i.id === imageId);
  if (!img || sidebarOrderDependsOnEvaluation()) {
    await loadImages();
    return;
  }
  patchImagesLocally((images) => {
    const target = images.find((i) => i.id === imageId);
    if (!target) return;
    target.active_result_id = resultId;
    const entry = (target.result_evaluations || []).find((r) => r.id === resultId);
    if (entry) target.active_evaluation = entry.evaluation;
  });
}

async function loadReferenceImages() {
  if (!state.currentProjectId) return;
  state.referenceImages = await api.listReferenceImages(state.currentProjectId);
  // Drop any picked-for-generation ids that no longer exist (e.g. deleted from another tab).
  const validIds = new Set(state.referenceImages.map((r) => r.id));
  state.referenceImageIds = state.referenceImageIds.filter((id) => validIds.has(id));
  renderReferenceLibrary();
  renderReferenceImages();
}

// The backend's "Latest Result" sort already treats a fresh upload as recent
// activity (falls back to date_added when there's no result yet), but it has
// no idea a generation is currently in flight. Bump images with an active job
// to the top too, so watching a batch process feels the same as reviewing one.
function applyQueueOrdering() {
  if (state.sort !== "recent_result") return;
  const activeJobCreatedAt = new Map();
  for (const job of state.queue) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const prev = activeJobCreatedAt.get(job.image_id);
    if (prev === undefined || job.created_at > prev) activeJobCreatedAt.set(job.image_id, job.created_at);
  }
  if (!activeJobCreatedAt.size) return;

  const active = [];
  const rest = [];
  for (const img of state.images) {
    (activeJobCreatedAt.has(img.id) ? active : rest).push(img);
  }
  active.sort((a, b) => activeJobCreatedAt.get(b.id) - activeJobCreatedAt.get(a.id));
  state.images = [...active, ...rest];
}

// Flattens state.images into the rows the sidebar actually shows, as
// { img, depth, childCount, collapsed }. With lineage grouping on, each image
// derived from a result is nested (any depth) under its parent -- but only
// when the parent is itself in the current list; a child whose parent is
// filtered out, searched away, trashed or in another project just appears as
// a top-level row. Families are positioned where their best-ranked member
// sits in the server's sort order, so "Latest Result" still surfaces a family
// whose newest child was just generated.
function buildImageDisplayList() {
  if (!state.groupByLineage) {
    return state.images.map((img) => ({ img, depth: 0, childCount: 0, collapsed: false }));
  }
  const order = new Map(state.images.map((img, i) => [img.id, i]));
  const children = new Map();
  const roots = [];
  for (const img of state.images) {
    const pid = img.parent_image_id;
    if (pid && pid !== img.id && order.has(pid)) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(img);
    } else {
      roots.push(img);
    }
  }

  const rankOf = (img, seen = new Set()) => {
    seen.add(img.id);
    let best = order.get(img.id);
    for (const c of children.get(img.id) || []) {
      if (!seen.has(c.id)) best = Math.min(best, rankOf(c, seen));
    }
    return best;
  };
  const rank = new Map(roots.map((r) => [r.id, rankOf(r)]));
  roots.sort((a, b) => rank.get(a.id) - rank.get(b.id));

  const countDescendants = (img, seen = new Set()) => {
    seen.add(img.id);
    let n = 0;
    for (const c of children.get(img.id) || []) {
      if (!seen.has(c.id)) n += 1 + countDescendants(c, seen);
    }
    return n;
  };

  const out = [];
  const visited = new Set();
  const emit = (img, depth, hidden) => {
    if (visited.has(img.id)) return;
    visited.add(img.id);
    const childCount = countDescendants(img);
    const collapsed = childCount > 0 && state.collapsedImageIds.has(img.id);
    if (!hidden) out.push({ img, depth, childCount, collapsed });
    for (const c of children.get(img.id) || []) emit(c, depth + 1, hidden || collapsed);
  };
  for (const r of roots) emit(r, 0, false);
  // merge_images can in principle leave a parent loop with no root; never drop rows.
  for (const img of state.images) emit(img, 0, false);
  return out;
}

// Un-collapses every ancestor of an image so it's visible in the list
// (e.g. right after promoting a result, or jumping via a lineage link).
function revealImageInList(imageId) {
  if (!state.groupByLineage) return;
  const byId = new Map(state.images.map((i) => [i.id, i]));
  let changed = false;
  const seen = new Set();
  let cur = byId.get(imageId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.parent_image_id && byId.get(cur.parent_image_id);
    if (parent && state.collapsedImageIds.delete(parent.id)) changed = true;
    cur = parent;
  }
  if (changed) saveCollapsedImageIds();
}

function renderImageItemHtml({ img, depth, childCount, collapsed }) {
  const selected = img.id === state.currentImageId ? "selected" : "";
  const checked = state.selectedImageIds.has(img.id) ? "checked" : "";
  const checkbox = state.multiSelectMode
    ? `<input type="checkbox" class="image-item-check" data-id="${img.id}" ${checked} />`
    : "";
  // A derived image shown at the top level means its parent isn't in this list.
  const orphanBadge =
    depth === 0 && state.groupByLineage && img.parent_image_id
      ? `<span class="lineage-orphan" title="Derived from another image that isn't in this list">↳</span>`
      : "";
  return `
    <div class="image-item ${selected}" data-id="${img.id}" data-depth="${depth}" style="--depth:${depth}">
      ${checkbox}
      <img src="/api/images/${img.id}/thumbnail" loading="lazy" />
      <div class="meta">
        <div class="name">${escapeHtml(img.display_name)}${orphanBadge}</div>
      </div>
      <span class="chits-slot">${renderChits(img)}</span>
      <button class="item-menu-btn" data-menu-image="${img.id}" title="More actions">⋮</button>
    </div>
  `;
}

// The expand/collapse control for a parent: a text-free strip of lines drawn
// directly under the parent's row, inside the parent's group (see
// renderImageListHtml). Collapsed = 1-3 solid lines (one per hidden image,
// capped at 3) hinting that entries are tucked away; expanded = a single
// dashed line, in the same spot, that collapses the group again. The hidden
// count lives in the tooltip rather than in visible text.
function renderLineageHandle({ img, depth, childCount, collapsed }) {
  const noun = `derived image${childCount === 1 ? "" : "s"}`;
  const title = collapsed
    ? `${childCount} hidden ${noun} — click to expand`
    : `Click to collapse ${childCount} ${noun}`;
  const lineCount = collapsed ? Math.min(childCount, 3) : 1;
  const lines = `<span class="lineage-line"></span>`.repeat(lineCount);
  return `<button class="lineage-handle ${collapsed ? "collapsed" : "expanded"}" data-toggle-lineage="${img.id}" aria-expanded="${!collapsed}" aria-label="${title}" title="${title}" style="--depth:${depth}">${lines}</button>`;
}

// Turns the flat display list into markup. Every image that has derived
// images becomes a tinted, top/bottom-bordered "lineage group" wrapping the
// parent row, its handle and (when expanded) its descendants -- which may
// themselves be groups -- so ownership reads at a glance. A group closes when
// the next row is at the same or a shallower depth.
function renderImageListHtml(rows) {
  const open = []; // depth of each currently open group
  let html = "";
  for (const row of rows) {
    while (open.length && open[open.length - 1] >= row.depth) {
      html += "</div>";
      open.pop();
    }
    if (row.childCount) {
      html += `<div class="lineage-group">`;
      open.push(row.depth);
    }
    html += renderImageItemHtml(row);
    if (row.childCount) html += renderLineageHandle(row);
  }
  return html + "</div>".repeat(open.length);
}

// Applies a lineage change's returned image detail: refreshes the details panel
// if that image is the one on screen, and the sidebar grouping either way.
async function applyParentChange(imageId, detail) {
  if (state.currentImageId === imageId) {
    state.currentImage = detail;
    renderDetails();
  }
  await loadImages();
}

async function detachImageParent(imageId, displayName) {
  const ok = await openConfirmModal({
    title: "Detach from parent",
    message: `Detach "${displayName || "this image"}" from its parent? It becomes the root of its own lineage; you can link it to a parent again later.`,
    confirmLabel: "Detach",
  });
  if (!ok) return;
  try {
    await applyParentChange(imageId, await api.clearImageParent(imageId));
  } catch (e) {
    els.generateStatus.textContent = `Error: ${e.message}`;
  }
}

// Ids of every image below `imageId` in the sidebar list's parent links -- the
// ones that can't be picked as its new parent (that would be a cycle). The
// server re-checks against the full chain, so this only needs to be a filter.
function descendantImageIds(imageId) {
  const childrenOf = new Map();
  for (const img of state.images) {
    if (!img.parent_image_id) continue;
    if (!childrenOf.has(img.parent_image_id)) childrenOf.set(img.parent_image_id, []);
    childrenOf.get(img.parent_image_id).push(img.id);
  }
  const found = new Set();
  const stack = [imageId];
  while (stack.length) {
    for (const childId of childrenOf.get(stack.pop()) || []) {
      if (!found.has(childId)) {
        found.add(childId);
        stack.push(childId);
      }
    }
  }
  return found;
}

// Pick the parent image and the child links to its active result in one click.
// Lineage points at a specific result (so "Compare with parent" can show the
// crop that result was generated with), so a parent with several results also
// offers "Choose result…", which opens a grid of them.
function openSetParentModal(imageId) {
  const img = state.images.find((i) => i.id === imageId);
  if (!img) return;
  const excluded = descendantImageIds(imageId);
  excluded.add(imageId);
  const candidates = state.images.filter((i) => !excluded.has(i.id) && i.result_evaluations.length);
  let search = "";

  const modal = openModal(`
    <div class="parent-picker">
      <h3>Set parent for "${escapeHtml(img.display_name)}"</h3>
      <div id="mParentBody"></div>
      <div id="mParentStatus" class="status-line"></div>
      <div class="modal-actions">
        ${img.derived_from_result_id ? `<button id="mDetach" class="btn-danger" type="button" style="margin-right:auto">✕ Detach from parent</button>` : ""}
        <button id="mCancel" class="btn-ghost" type="button">Cancel</button>
      </div>
    </div>
  `);
  const body = modal.querySelector("#mParentBody");
  const statusEl = modal.querySelector("#mParentStatus");
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mDetach")?.addEventListener("click", () => {
    closeModal();
    detachImageParent(imageId, img.display_name);
  });

  const choose = async (resultId) => {
    statusEl.textContent = "Linking...";
    try {
      const detail = await api.setImageParent(imageId, resultId);
      closeModal();
      await applyParentChange(imageId, detail);
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  };

  // The result a one-click link uses: the parent's active one, else its newest.
  const defaultResultId = (parent) => {
    const results = parent.result_evaluations;
    return results.some((r) => r.id === parent.active_result_id) ? parent.active_result_id : results[results.length - 1].id;
  };

  const showResults = (parent) => {
    statusEl.textContent = "";
    // Marks what's linked now when changing within the same parent, otherwise
    // what a one-click link would pick.
    const isCurrentParent = parent.id === img.parent_image_id;
    const markedId = isCurrentParent ? img.derived_from_result_id : defaultResultId(parent);
    const markedTitle = isCurrentParent ? "Currently linked result" : "Active result (used by a one-click link)";
    const tiles = [...parent.result_evaluations].reverse().map(
      (r) => `<button type="button" class="parent-result-tile ${r.evaluation} ${r.id === markedId ? "active" : ""}" data-result-id="${r.id}" title="${r.id === markedId ? markedTitle : "Use this result as the parent"}">
        <img src="/api/results/${r.id}/thumbnail" loading="lazy" alt="" />
      </button>`
    );
    body.innerHTML = `
      <p class="modal-note">Which result of "${escapeHtml(parent.display_name)}" is this image derived from? This sets what "compare with parent" and the lineage slider show; it doesn't change where the image sits in the list.</p>
      <div class="parent-result-grid">${tiles.join("")}</div>
      <div class="dup-group-actions" style="text-align:left"><button id="mParentBack" class="btn-ghost small" type="button">← Back</button></div>
    `;
    body.querySelector("#mParentBack").addEventListener("click", showImages);
    body.querySelectorAll(".parent-result-tile").forEach((tile) => {
      tile.addEventListener("click", () => choose(tile.dataset.resultId));
    });
  };

  const renderRows = () => {
    const q = search.trim().toLowerCase();
    const rows = candidates.filter((c) => !q || c.display_name.toLowerCase().includes(q));
    const list = body.querySelector("#mParentList");
    list.innerHTML = rows.length
      ? rows
          .map(
            (c) => `<div class="parent-pick-row ${c.id === img.parent_image_id ? "current" : ""}" data-image-id="${c.id}">
              <button type="button" class="parent-pick-main" title="Link to this image's active result">
                <img src="/api/images/${c.id}/thumbnail" loading="lazy" alt="" />
                <span class="dup-name">${escapeHtml(c.display_name)}</span>
                <span class="dup-result-summary">${c.id === img.parent_image_id ? "current parent · " : ""}${c.result_evaluations.length} result${c.result_evaluations.length === 1 ? "" : "s"}</span>
              </button>
              ${c.result_evaluations.length > 1 ? `<button type="button" class="btn-ghost small" data-choose-result>Choose result…</button>` : ""}
            </div>`
          )
          .join("")
      : `<p class="modal-note">No images with results to choose from.</p>`;
    list.querySelectorAll(".parent-pick-row").forEach((row) => {
      const parent = candidates.find((c) => c.id === row.dataset.imageId);
      // Clicking the current parent again can only mean picking another of its
      // results, so it opens the grid rather than re-linking to the same image.
      row.querySelector(".parent-pick-main").addEventListener("click", () => {
        if (parent.id === img.parent_image_id && parent.result_evaluations.length > 1) showResults(parent);
        else choose(defaultResultId(parent));
      });
      row.querySelector("[data-choose-result]")?.addEventListener("click", () => showResults(parent));
    });
  };

  function showImages() {
    statusEl.textContent = "";
    body.innerHTML = `
      <p class="modal-note">Pick the image this one was derived from; it links to that image's active result. Only images with results are listed.</p>
      <div class="field"><input id="mParentSearch" type="text" placeholder="Search images..." value="${escapeHtml(search)}" /></div>
      <div id="mParentList" class="parent-pick-list"></div>
    `;
    const input = body.querySelector("#mParentSearch");
    input.addEventListener("input", () => {
      search = input.value;
      renderRows();
    });
    renderRows();
    input.focus();
  }

  showImages();
}

function openImageItemMenu(anchorBtn, imageId) {
  const img = state.images.find((i) => i.id === imageId);
  if (!img) return;
  const lineageItems = [
    { icon: "↳", label: img.derived_from_result_id ? "Change parent…" : "Set parent…", onClick: () => openSetParentModal(imageId) },
  ];
  if (img.derived_from_result_id) {
    lineageItems.push({ icon: "✕", label: "Detach from parent", onClick: () => detachImageParent(imageId, img.display_name) });
  }
  openItemMenu(anchorBtn, [
    ...lineageItems,
    { icon: "📎", label: "Copy as reference image", onClick: () => useAsReferenceFromUrl(`/api/images/${imageId}/file`, img.display_name) },
    { icon: "✂", label: "Move to reference library", onClick: () => moveImageToReference(imageId) },
    { icon: "➜", label: "Move to other library…", onClick: () => openMoveOrCopyImagesModal([imageId], "move") },
    { icon: "⧉", label: "Copy to other library…", onClick: () => openMoveOrCopyImagesModal([imageId], "copy") },
    { icon: "🗑", label: "Delete (and its results)", danger: true, onClick: () => deleteImageWithConfirm(imageId, img.display_name) },
  ]);
}

// Single delegated listener, bound once -- lets renderImageList() patch
// existing rows in place (see below) without having to re-attach handlers
// on every poll tick.
let imageListHandlersBound = false;
function bindImageListDelegation() {
  if (imageListHandlersBound) return;
  imageListHandlersBound = true;
  els.imageList.addEventListener("click", (e) => {
    const menuBtn = e.target.closest("[data-menu-image]");
    if (menuBtn) {
      e.stopPropagation();
      openImageItemMenu(menuBtn, menuBtn.dataset.menuImage);
      return;
    }
    const lineageBtn = e.target.closest("[data-toggle-lineage]");
    if (lineageBtn) {
      e.stopPropagation();
      const id = lineageBtn.dataset.toggleLineage;
      if (!state.collapsedImageIds.delete(id)) state.collapsedImageIds.add(id);
      saveCollapsedImageIds();
      renderImageList();
      return;
    }
    const itemEl = e.target.closest(".image-item");
    if (!itemEl) return;
    const imageId = itemEl.dataset.id;
    if (state.multiSelectMode) {
      toggleImageSelection(imageId);
      return;
    }
    const chitEl = e.target.closest(".chit[data-result-id]");
    if (chitEl) {
      selectImageResult(imageId, chitEl.dataset.resultId);
      return;
    }
    selectImage(imageId);
  });
}

// Tracks what the list's DOM currently reflects (image id order + multi-select
// mode) so unchanged renders can patch existing rows instead of rebuilding.
let lastImageListSignature = null;

function renderImageList() {
  bindImageListDelegation();
  const rows = buildImageDisplayList();
  const signature = `${state.multiSelectMode}|${rows
    .map((r) => `${r.img.id}:${r.depth}:${r.childCount}:${r.collapsed ? 1 : 0}:${r.img.parent_image_id || ""}`)
    .join(",")}`;

  if (signature !== lastImageListSignature) {
    els.imageList.innerHTML = renderImageListHtml(rows);
    lastImageListSignature = signature;
    return;
  }

  // Same set/order of images as last render (e.g. a routine queue poll with
  // no completions) -- patch the mutable bits in place rather than
  // recreating every row's DOM. Recreating <img> nodes on a ~1.2s timer was
  // destroying the browser's already-decoded thumbnail bitmaps, which showed
  // up as thumbnails visibly flickering/breaking while browsing the list.
  const elById = new Map();
  els.imageList.querySelectorAll(".image-item").forEach((el) => elById.set(el.dataset.id, el));
  for (const img of state.images) {
    const el = elById.get(img.id);
    if (!el) continue;
    el.classList.toggle("selected", img.id === state.currentImageId);
    const checkbox = el.querySelector(".image-item-check");
    if (checkbox) checkbox.checked = state.selectedImageIds.has(img.id);
    const nameEl = el.querySelector(".name");
    if (nameEl) nameEl.textContent = img.display_name;
    const chitsEl = el.querySelector(".chits-slot");
    if (chitsEl) {
      // Rewriting innerHTML replaces the chit nodes, which restarts their CSS
      // animations (the pulses looked like a sawtooth, snapping back every
      // poll tick) and dismisses any open tooltip. Skip it unless something
      // other than the elapsed-time tooltip text changed, so a tick with no
      // real change leaves the DOM alone.
      const html = renderChits(img);
      const sig = html.replace(/ title="[^"]*"/g, "");
      if (chitsEl.dataset.sig !== sig) {
        chitsEl.innerHTML = html;
        chitsEl.dataset.sig = sig;
      }
    }
  }
}

// Jumps to a specific generation from its chit in the sidebar grid: selects
// the image (if not already current) and makes that particular result the
// active one, same as clicking its tile in the results grid.
async function selectImageResult(imageId, resultId) {
  if (state.currentImageId !== imageId) {
    await selectImage(imageId);
    if (state.currentImageId !== imageId) return; // navigated away before this resolved
  }
  els.detailsContent.classList.add("loading");
  try {
    await api.activateResult(resultId);
    await applyActivateResultToSidebar(imageId, resultId);
    if (state.currentImageId === imageId) {
      state.currentImage = await api.getImage(imageId);
      renderDetails();
    }
  } finally {
    if (state.currentImageId === imageId) els.detailsContent.classList.remove("loading");
  }
}

// ---------------------------------------------------------------------------
// Multi-select & project migration
// ---------------------------------------------------------------------------

function toggleImageSelection(id) {
  if (state.selectedImageIds.has(id)) state.selectedImageIds.delete(id);
  else state.selectedImageIds.add(id);
  renderImageList();
  updateMultiSelectBar();
}

// The bar is the only on-screen sign of select mode besides the row checkboxes,
// so it stays up (with Move disabled) until the mode is left, not just while
// something is ticked.
function updateMultiSelectBar() {
  const count = state.selectedImageIds.size;
  els.multiSelectBar.style.display = state.multiSelectMode ? "flex" : "none";
  els.multiSelectCount.textContent = `${count} selected`;
  els.multiSelectMoveBtn.disabled = !count;
}

function setMultiSelectMode(on) {
  state.multiSelectMode = on;
  state.selectedImageIds.clear();
  updateMultiSelectBar();
  renderImageList();
}
els.multiSelectDoneBtn.addEventListener("click", () => setMultiSelectMode(false));

// Shared by the multi-select "Move" bar button and each image row's menu
// ("Move to other library" / "Copy to other library") -- lets the user send
// one or more images to an existing project or a fresh one. mode is "move"
// (relocates, including all of the image's results) or "copy" (duplicates
// into the target project, leaving the originals untouched).
function openMoveOrCopyImagesModal(imageIds, mode) {
  const verb = mode === "move" ? "Move" : "Copy";
  const otherProjects = state.projects.filter((p) => p.id !== state.currentProjectId);
  const modal = openModal(`
    <h3>${verb} ${imageIds.length} image(s)</h3>
    <div class="field">
      <label>Destination</label>
      <select id="mDestMode">
        <option value="existing">Existing project</option>
        <option value="new">New project</option>
      </select>
    </div>
    <div class="field" id="mExistingField">
      <label>Project</label>
      <select id="mDestProject">
        ${otherProjects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field" id="mNewField" style="display:none">
      <label>New Project Name</label>
      <input id="mNewName" type="text" />
    </div>
    <div id="mMoveStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Cancel</button>
      <button id="mGo" class="btn-primary">${verb}</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mDestMode").addEventListener("change", (e) => {
    const isNew = e.target.value === "new";
    modal.querySelector("#mExistingField").style.display = isNew ? "none" : "block";
    modal.querySelector("#mNewField").style.display = isNew ? "block" : "none";
  });
  modal.querySelector("#mGo").addEventListener("click", async () => {
    const isNew = modal.querySelector("#mDestMode").value === "new";
    const statusEl = modal.querySelector("#mMoveStatus");
    let targetProjectId;
    if (isNew) {
      const name = modal.querySelector("#mNewName").value.trim();
      if (!name) return;
      const project = await api.createProject(name);
      targetProjectId = project.id;
    } else {
      targetProjectId = modal.querySelector("#mDestProject").value;
      if (!targetProjectId) return;
    }
    statusEl.textContent = mode === "move" ? "Moving..." : "Copying...";
    try {
      if (mode === "move") {
        await api.moveImages(imageIds, targetProjectId);
      } else {
        await api.copyImages(imageIds, targetProjectId);
      }
      closeModal();
      if (mode === "move" && state.currentImage && imageIds.includes(state.currentImageId)) {
        state.currentImageId = null;
        state.currentImage = null;
        renderDetails();
      }
      if (state.multiSelectMode) setMultiSelectMode(false);
      await loadProjects();
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  });
}

els.multiSelectMoveBtn.addEventListener("click", () => {
  openMoveOrCopyImagesModal(Array.from(state.selectedImageIds), "move");
});

// Chit grid: one chit per completed result (colored by evaluation), plus a
// chit for each in-flight job (a SAM3 detection included, so it's visible
// queued/running too, not just once it's done) -- dim/static while queued,
// pulsing while running, a distinct color once cancellation's been requested
// -- and an error chit for recently-failed *generation* jobs specifically
// (failedJobsFor excludes SAM3 detections, same as the results panel's tiles
// they're otherwise shown alongside -- a failed detection just disappears
// for now rather than getting its own error indicator). A cancelled job gets
// no chit of its own: once the server confirms it's actually gone, it should
// just disappear rather than linger as a separate "cancelled" indicator.
// A dashed amber chit flags a SAM3 detection that finished successfully in
// the background and is sitting in the reference library unpositioned
// (needs_composite) -- durable (from the DB, via list_images'
// unfinished_sam3_reference_id), unlike the others here, which all come from
// the in-memory job queue and disappear once resolved -- this is what the
// in-flight pending chit above hands off to once the job completes.
// Still-running (queued/running) sam3_cutout jobs for one image -- used to
// hold off the "ready to position" signals (banner/chit/button label) until
// every layer in a batch has actually finished, not just the first one. A
// batch's jobs are all added to state.queue together at submit time (see
// renderSam3PromptStep), so this reflects the whole batch's progress, not
// just whichever layer happens to be running right now.
function sam3PendingLayerJobs(imageId) {
  return state.queue.filter((j) => j.image_id === imageId && j.kind === "sam3_cutout" && (j.status === "queued" || j.status === "running"));
}

function renderChits(img) {
  const completedChits = (img.result_evaluations || []).map(
    (r) => `<span class="chit ${r.evaluation}" data-result-id="${r.id}" title="${r.evaluation}"></span>`
  );
  const jobsForImage = state.queue.filter((j) => j.image_id === img.id);
  const pendingChits = jobsForImage
    .filter((j) => j.status === "queued" || j.status === "running")
    .map((j) => `<span class="chit pending ${jobDisplayState(j)}" title="${escapeHtml(formatJobStatus(j))}"></span>`);
  const errorChits = failedJobsFor(img.id)
    .map((j) => `<span class="chit error" title="${escapeHtml(j.error || "Generation failed")}"></span>`);
  // Withheld while any layer in the batch is still detecting (its own
  // pending chit above already shows that) -- otherwise this would pop up
  // as soon as the first of several layers finishes, inviting the user to
  // position a placement that isn't fully ready yet.
  const sam3PendingChits = img.unfinished_sam3_reference_id && !sam3PendingLayerJobs(img.id).length
    ? [`<span class="chit sam3-pending" title="SAM3 placement ready -- needs positioning"></span>`]
    : [];

  const chits = [...completedChits, ...pendingChits, ...errorChits, ...sam3PendingChits];
  if (!chits.length) return `<span class="badge NONE">NEW</span>`;
  return `<div class="chit-grid">${chits.join("")}</div>`;
}

els.searchInput.addEventListener("input", debounce(() => {
  state.search = els.searchInput.value.trim();
  loadImages();
}, 250));
// Groups images under the image they were derived from (via "use as new
// source" on a result).
function toggleLineageGrouping() {
  state.groupByLineage = !state.groupByLineage;
  try {
    localStorage.setItem("grok_img2img.groupByLineage", state.groupByLineage ? "1" : "0");
  } catch {
    // preference just won't persist
  }
  renderImageList();
}
els.sortSelect.addEventListener("change", () => {
  state.sort = els.sortSelect.value;
  loadImages();
});
els.filterSelect.addEventListener("change", () => {
  state.filter = els.filterSelect.value;
  loadImages();
});

async function clearNoResults() {
  if (!state.currentProjectId) return;
  const ok = await openConfirmModal({
    title: "Clear NO Results",
    message: "Move all NO-rated results in this project to Trash? You can restore them within 2 days.",
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  const { trashed } = await api.trashNoResults(state.currentProjectId);
  await loadImages();
  if (state.currentImageId) {
    state.currentImage = await api.getImage(state.currentImageId);
    renderDetails();
  }
  els.uploadStatus.textContent = `Trashed ${trashed.length} NO-rated result(s).`;
}

// Kebab next to the Images/References tabs, for actions on the source library
// as a whole. Only shown on the Images tab (see setSidebarTab). The two view
// toggles show a check while on, like the topbar menu's.
els.libraryMenuBtn.addEventListener("click", () => {
  const checked = (on) => (on ? " ✓" : "");
  openItemMenu(els.libraryMenuBtn, [
    { icon: "☑", label: `Select images${checked(state.multiSelectMode)}`, onClick: () => setMultiSelectMode(!state.multiSelectMode) },
    { icon: "⑂", label: `Group by lineage${checked(state.groupByLineage)}`, onClick: toggleLineageGrouping },
    { icon: "⟳", label: "Force full refresh", onClick: forceRefreshImages },
    { icon: "🗑", label: "Clear NO results…", danger: true, onClick: clearNoResults },
  ]);
});

function reportUploadResult({ created, skipped }) {
  if (!skipped.length) {
    els.uploadStatus.textContent = `Uploaded ${created.length} image(s).`;
    return;
  }
  const names = skipped.map((s) => `"${s.filename}" (duplicate of "${s.duplicate_of}")`).join(", ");
  els.uploadStatus.textContent =
    `Uploaded ${created.length}, skipped ${skipped.length} duplicate(s): ${names}`;
}

async function handleUploadedFiles(files) {
  if (!files.length) return;
  const { created, skipped } = await api.uploadImages(state.currentProjectId, files);
  await afterImagesIngested({ created, skipped });
}

// Shared by file upload, drag-drop, clipboard-image paste, and URL paste: reports
// what happened, refreshes the list, and jumps to the new (or matching duplicate) image.
async function afterImagesIngested({ created, skipped }) {
  reportUploadResult({ created, skipped });
  await loadImages();

  if (created.length) {
    if (els.autoGenOnUploadToggle.classList.contains("active") && els.promptTextarea.value.trim()) {
      await autoGenerateForImages(created);
    }
    // Accepted: jump to the newly added image.
    await selectImage(created[created.length - 1].id);
  } else if (skipped.length && skipped[0].duplicate_of_id) {
    // Rejected as a duplicate: jump to the existing image it matches instead.
    await selectImage(skipped[0].duplicate_of_id);
  }
}

const IMAGE_URL_RE = /^https?:\/\/\S+$/i;
function isEditableElement(el) {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

// Pastes a bare image URL (e.g. "copy image address" from a browser) as a new
// source image, fetched server-side so the browser's CORS restrictions don't
// apply. The URL itself is kept as the image's comment for provenance.
async function handleImageUrlPaste(url) {
  els.uploadStatus.innerHTML = `<span class="spinner"></span><span>Fetching image from URL...</span>`;
  try {
    const { created, skipped } = await api.importImageFromUrl(state.currentProjectId, url);
    await afterImagesIngested({ created, skipped });
  } catch (e) {
    els.uploadStatus.textContent = `Error: ${e.message}`;
  }
}

// Queues a generation job for each newly-uploaded image using whatever
// prompt/engine/aspect-ratio is currently set up in the details panel, so a
// batch upload can go straight to generating without per-image clicks.
async function autoGenerateForImages(images) {
  for (const img of images) {
    try {
      await enqueueGeneration(img.id);
    } catch (e) {
      console.error(`Auto-generate failed for ${img.id}:`, e);
    }
  }
  applyQueueOrdering();
  renderImageList();
  renderQueueOverlay();
}

// Small ⚡ icon toggle next to Generate (was a labeled checkbox in the
// sidebar): when on, a freshly uploaded image immediately queues a
// generation using the prompt currently in the details panel (see
// afterImagesIngested above). Off by default each session, same as before.
function setAutoGenOnUpload(active) {
  els.autoGenOnUploadToggle.classList.toggle("active", active);
  els.autoGenOnUploadToggle.setAttribute("aria-pressed", String(active));
  els.autoGenOnUploadToggle.title = `Auto-generate on upload: ${active ? "ON" : "off"} — click to turn ${
    active ? "off" : "on"
  }. When on, a newly uploaded image immediately queues a generation using the prompt above.`;
}
els.autoGenOnUploadToggle.addEventListener("click", () => {
  setAutoGenOnUpload(!els.autoGenOnUploadToggle.classList.contains("active"));
});
setAutoGenOnUpload(false);

els.uploadInput.addEventListener("change", async () => {
  const files = els.uploadInput.files;
  els.uploadInput.value = "";
  await handleUploadedFiles(files);
});
["dragover", "dragleave", "drop"].forEach((evtName) => {
  els.uploadDrop.addEventListener(evtName, (e) => {
    e.preventDefault();
    els.uploadDrop.classList.toggle("dragover", evtName === "dragover");
  });
});
els.uploadDrop.addEventListener("drop", async (e) => {
  await handleUploadedFiles(e.dataTransfer.files);
});

// "Click pastes clipboard" preference for an upload drop-zone: when on,
// clicking the (or paste) label reads an image straight from the clipboard
// instead of opening the file picker, for people who copy screenshots more
// often than they browse files. Off by default; persisted per drop-zone
// since the images and reference zones are independent.
function setupClickToPasteUpload({ dropEl, toggleEl, statusEl, storageKey, onFiles }) {
  const isActive = () => localStorage.getItem(storageKey) === "1";
  function applyState(active) {
    toggleEl.classList.toggle("active", active);
    toggleEl.setAttribute("aria-pressed", String(active));
    toggleEl.title = `Click pastes from clipboard: ${active ? "ON" : "off"} — click to turn ${
      active ? "off" : "on"
    }. When on, clicking this button pastes an image from the clipboard instead of opening the file picker.`;
  }
  applyState(isActive());
  toggleEl.addEventListener("click", () => {
    const active = !isActive();
    localStorage.setItem(storageKey, active ? "1" : "0");
    applyState(active);
  });

  dropEl.addEventListener("click", async (e) => {
    if (!isActive()) return;
    e.preventDefault();
    if (!clipboardAvailable) {
      statusEl.textContent = "Clipboard access isn't available on this connection.";
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files = [];
      for (const item of clipboardItems) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext = imageType.split("/")[1] || "png";
        files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type: imageType }));
      }
      if (!files.length) {
        statusEl.textContent = "No image found on the clipboard.";
        return;
      }
      await onFiles(files);
    } catch (err) {
      statusEl.textContent = `Clipboard read failed: ${err.message}`;
    }
  });
}
setupClickToPasteUpload({
  dropEl: els.uploadDrop,
  toggleEl: els.uploadClickPasteToggle,
  statusEl: els.uploadStatus,
  storageKey: "grok_img2img.uploadClickPastes",
  onFiles: handleUploadedFiles,
});
setupClickToPasteUpload({
  dropEl: els.referenceUploadDrop,
  toggleEl: els.referenceUploadClickPasteToggle,
  statusEl: els.referenceUploadStatus,
  storageKey: "grok_img2img.referenceUploadClickPastes",
  onFiles: uploadReferenceFilesWithCrop,
});

// Paste an image (e.g. copied from a screenshot tool or browser) straight
// into the library as a new source image, anywhere except inside an open
// modal -- clipboard image data never affects a focused text field, so this
// can safely listen globally without stepping on normal text pasting.
// A bare image URL (e.g. "copy image address") is handled too, but only when
// no text field is focused, since a URL there is normal text the user is
// pasting on purpose (e.g. into the comment box).
document.addEventListener("paste", async (e) => {
  if (!state.currentProjectId) return;
  if (els.modalOverlay.style.display !== "none") return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length) {
    e.preventDefault();
    if (state.sidebarTab === "references") {
      await uploadReferenceFilesWithCrop(imageFiles);
    } else {
      await handleUploadedFiles(imageFiles);
    }
    return;
  }

  if (isEditableElement(document.activeElement)) return;
  const text = e.clipboardData.getData("text/plain")?.trim();
  if (!text || !IMAGE_URL_RE.test(text)) return;
  e.preventDefault();
  await handleImageUrlPaste(text);
});

async function selectImage(id) {
  // compareAgainstId is left as-is here -- it's sticky across navigation and
  // only cleared once we know the new image's ancestors (see syncViewer),
  // so switching between images that share a chosen ancestor keeps it selected.
  state.currentImageId = id;
  revealImageInList(id);
  // Give instant feedback that the switch was initiated, rather than leaving
  // the sidebar/details panel looking unchanged until the metadata fetch
  // below resolves: highlight the new row right away, and dim the (still
  // stale) details panel with a spinner until fresh data replaces it.
  renderImageList();
  els.generateStatus.innerHTML = `<span class="spinner"></span><span>Loading...</span>`;
  updateGenerateStatusForCurrentImage(); // overwrites with real job status, if any, from local queue state
  els.detailsContent.classList.add("loading");
  // The source image only depends on `id`, not on the metadata fetch below --
  // kick off its (progressive) load right away instead of making the viewer
  // wait on a network round-trip it doesn't need. renderDetails() below will
  // fill in the result image once metadata resolves.
  abViewer.setCompareOptions([], null);
  abViewer.setPreprocess(null); // re-enabled by syncViewer() once the details load
  abViewer.setLineage([]); // re-enabled by syncViewer() once the details load
  // The sidebar list already knows whether this image has pre-process settings,
  // so show the right base straight away instead of flashing the original.
  const listed = state.images.find((i) => i.id === id);
  const base = listed ? sourceUrlFor(listed) : { url: `/api/images/${id}/file`, processed: false };
  abViewer.setImages(base.url, null, { baseProcessed: base.processed });
  const image = await api.getImage(id);
  if (state.currentImageId !== id) return; // user navigated away before this resolved
  state.currentImage = image;
  els.detailsContent.classList.remove("loading");
  els.generateStatus.textContent = "";
  updateGenerateStatusForCurrentImage();
  renderImageList();
  renderDetails();
  prefetchNeighbors(id);
}

// Warms the cache for the images on either side of `id` in the sidebar's
// visible order, so stepping with the arrow keys shows them straight away.
// Small previews for both neighbours come first so either direction shows
// something at once, then the full-size files, next before previous.
function prefetchNeighbors(id) {
  const list = buildImageDisplayList().map((r) => r.img);
  const idx = list.findIndex((i) => i.id === id);
  if (idx === -1 || list.length < 2) return;
  const next = list[(idx + 1) % list.length];
  const prev = list[(idx - 1 + list.length) % list.length];
  const previews = (img) => {
    const base = sourceUrlFor(img);
    return [
      base.processed ? null : `/api/images/${img.id}/preview`,
      img.active_result_id ? `/api/results/${img.active_result_id}/preview` : null,
    ];
  };
  const fulls = (img) => [
    sourceUrlFor(img).url,
    img.active_result_id ? `/api/results/${img.active_result_id}/file` : null,
  ];
  prefetchImages([...previews(next), ...previews(prev), ...fulls(next), ...fulls(prev)]);
}

function stepImage(direction) {
  const ids = buildImageDisplayList().map((r) => r.img.id); // visible order, so collapsed children are skipped
  const idx = ids.indexOf(state.currentImageId);
  if (idx === -1) {
    if (ids.length) selectImage(ids[0]);
    return;
  }
  const nextIdx = (idx + direction + ids.length) % ids.length;
  selectImage(ids[nextIdx]);
}

// Shared by the details panel's "Delete Image" button and each image row's
// menu -- moves an image (and all its results) to Trash, restorable for 2 days.
async function deleteImageWithConfirm(imageId, displayName) {
  const name = displayName || "this image";
  const ok = await openConfirmModal({
    title: "Move to Trash",
    message: `Move "${name}" and all of its results to Trash? You can restore it within 2 days.`,
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  await api.deleteImage(imageId);
  if (state.currentImageId === imageId) {
    state.currentImageId = null;
    state.currentImage = null;
    renderDetails();
  }
  await loadImages();
}

els.deleteImageBtn.addEventListener("click", async () => {
  const targetImageId = state.currentImageId;
  if (!targetImageId) return;
  await deleteImageWithConfirm(targetImageId, state.currentImage?.display_name);
});

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

function renderDetails() {
  const img = state.currentImage;
  const hasImage = !!img;
  els.detailsContent.querySelectorAll(".image-only-section").forEach((el) => {
    if (el === els.detailsEmpty) return; // handled separately below
    el.style.display = hasImage ? "" : "none";
  });
  els.detailsEmpty.style.display = hasImage ? "none" : "block";
  if (!img) {
    abViewer.setPreprocess(null);
    abViewer.setImages(null, null);
    return;
  }
  renderPreprocessNote();
  reconcileSam3ReferenceSelection(img);

  els.displayNameInput.value = img.display_name;
  els.commentInput.value = img.comment || "";
  renderProvenanceLine(img.derived_from);

  const results = img.results || [];
  els.resultCount.textContent = results.length;
  const active = results.find((r) => r.is_active_result) || results[0] || null;

  renderResultGrid(results, active?.id, img.id);

  syncViewer();

  const revisedPromptText = active?.revised_prompt ? `Grok revised prompt: "${active.revised_prompt}"` : "";
  const durationText = active?.duration_seconds ? `Generated in ${formatElapsed(active.duration_seconds)}` : "";
  els.revisedPrompt.textContent = [revisedPromptText, durationText].filter(Boolean).join(" — ");
}

// Pushes the current image into the A/B viewer. The left/base image is the
// image's own source unless the user picked an ancestor in the "Compare with"
// dropdown -- for a chain of incremental edits that shows the cumulative
// change rather than just the last step.
function syncViewer() {
  const img = state.currentImage;
  if (!img) return;
  const results = img.results || [];
  const active = results.find((r) => r.is_active_result) || results[0] || null;
  const ancestors = img.derived_from?.ancestors || [];
  if (state.compareAgainstId && !ancestors.some((a) => a.id === state.compareAgainstId)) {
    state.compareAgainstId = null;
  }
  const options = ancestors.map((a, i) => ({
    id: a.id,
    label: `${ancestorRelation(i, ancestors.length)}: ${a.display_name}${a.is_deleted ? " (in trash)" : ""}`,
  }));
  abViewer.setCompareOptions(options, state.compareAgainstId, setCompareAgainst);
  // The base is what was actually fed into the engine: the crop/expand render
  // recorded with the result being viewed (or, for an ancestor, with the result
  // its child was promoted from), not whatever the image's settings are now.
  const compareAncestor = state.compareAgainstId ? ancestors.find((a) => a.id === state.compareAgainstId) : null;
  const base = compareAncestor
    ? sourceUrlFor(compareAncestor, generatedWithAncestor(compareAncestor))
    : sourceUrlFor(img, generatedWithResult(active));
  const resultUrl = active ? `/api/results/${active.id}/file` : null;
  abViewer.setImages(base.url, resultUrl, { baseProcessed: base.processed });
  abViewer.setPreprocess({
    imageId: img.id,
    // The editor only needs to show the picture -- the server does the render
    // -- so it gets the small preview, and works in the full-size coordinates
    // given by `size` (the preview is just scaled up to match them).
    imageUrl: `/api/images/${img.id}/preview`,
    size: { width: img.width, height: img.height },
    params: img.preprocess,
    onApply: (params) => savePreprocess(img.id, params),
    onError: (message) => {
      els.generateStatus.textContent = `Error: ${message}`;
    },
  });
  // A lone parent isn't a lineage worth stepping through (that's just the
  // "Compare with" dropdown), so lineage mode needs at least a grandparent.
  abViewer.setLineage(ancestors.length >= 2 ? buildLineageSteps(img, ancestors, active) : []);
}

// Walks the same ancestor chain as the "Compare with" dropdown, just oldest
// first and ending with the image itself, for the lineage slider. Doesn't
// gather anything beyond that existing parent chain (no sibling branches or
// intermediate results) -- except for one extra step at the very end: the
// current image's own active result (the same "latest" image the other
// comparison modes show), when it has one. Without that, the newest thing
// the slider could show was the current image's pre-generation source --
// one step behind what's actually selected/on screen everywhere else.
function buildLineageSteps(img, ancestors, active) {
  const steps = ancestors.map((a, i) => {
    const { url, processed } = sourceUrlFor(a, generatedWithAncestor(a));
    return {
      id: a.id,
      label: ancestorRelation(i, ancestors.length),
      url,
      thumbUrl: `/api/images/${a.id}/thumbnail`,
      processed,
      isDeleted: a.is_deleted,
    };
  });
  steps.reverse();
  const { url, processed } = sourceUrlFor(img, generatedWithResult(active));
  steps.push({ id: img.id, label: "Current", url, thumbUrl: `/api/images/${img.id}/thumbnail`, processed, isDeleted: false });
  if (active) {
    steps.push({
      id: `result-${active.id}`,
      label: "Latest",
      url: `/api/results/${active.id}/file`,
      thumbUrl: `/api/results/${active.id}/thumbnail`,
      processed: false,
      isDeleted: false,
    });
  }
  return steps;
}

function ancestorRelation(index, total) {
  if (index === 0) return "Parent";
  if (index === 1) return "Grandparent";
  return index === total - 1 ? `Root (${index + 1} back)` : `${index + 1} back`;
}

function setCompareAgainst(id) {
  state.compareAgainstId = id || null;
  syncViewer();
  renderProvenanceLine(state.currentImage?.derived_from);
}

// Shows the "chain of custody" for an image promoted from a result (via the
// 🔗 button on result tiles) -- which source image and prompt produced it,
// with a link back to that source. Hidden entirely for ordinary uploads.
function renderProvenanceLine(derivedFrom) {
  if (!derivedFrom) {
    els.provenanceLine.style.display = "none";
    els.provenanceLine.innerHTML = "";
    return;
  }
  const toggleHtml = `<a href="#" class="provenance-toggle" data-toggle-provenance>${
    state.provenanceExpanded ? "▾" : "▸"
  } Derived from a result</a>`;

  if (!state.provenanceExpanded) {
    els.provenanceLine.innerHTML = toggleHtml;
    els.provenanceLine.style.display = "block";
    els.provenanceLine.querySelector("[data-toggle-provenance]").addEventListener("click", (e) => {
      e.preventDefault();
      setProvenanceExpanded(true);
    });
    return;
  }

  const promptText = derivedFrom.prompt_text ? ` — prompt: "${escapeHtml(derivedFrom.prompt_text)}"` : "";
  const sourceName = derivedFrom.source_image_display_name;
  const sourceLink = sourceName
    ? `<a href="#" data-jump-to-image="${derivedFrom.source_image_id}">${escapeHtml(sourceName)}</a>`
    : "a since-deleted image";

  // Full lineage, root first, ending at this image -- only worth a second line
  // when there's more than the immediate parent (which the line above names).
  const ancestors = derivedFrom.ancestors || [];
  let lineageHtml = "";
  if (ancestors.length > 1) {
    const crumbs = [...ancestors].reverse().map(
      (a) => `<a href="#" data-jump-to-image="${a.id}">${escapeHtml(a.display_name)}</a>`
    );
    crumbs.push(`<strong>${escapeHtml(state.currentImage?.display_name || "this image")}</strong>`);
    lineageHtml = `<div class="lineage-trail">Lineage: ${crumbs.join(" › ")}</div>`;
  }

  // Shortcut into the viewer's "Compare with" dropdown, so the option is
  // discoverable from where the parent is already mentioned.
  const parentId = ancestors[0]?.id;
  const comparing = parentId && state.compareAgainstId === parentId;
  const compareHtml = parentId
    ? ` <a href="#" class="lineage-compare" data-compare-parent="${comparing ? "" : parentId}">${
        comparing ? "✕ stop comparing" : "⇄ compare with parent"
      }</a>`
    : "";

  const editHtml = ` <a href="#" class="lineage-compare" data-change-parent>✎ change</a> <a href="#" class="lineage-compare" data-detach-parent>✕ detach</a>`;

  els.provenanceLine.innerHTML = `<a href="#" class="provenance-toggle" data-toggle-provenance>▾</a> ↳ Derived from a result of ${sourceLink}${promptText}${compareHtml}${editHtml}${lineageHtml}`;
  els.provenanceLine.style.display = "block";
  els.provenanceLine.querySelector("[data-toggle-provenance]").addEventListener("click", (e) => {
    e.preventDefault();
    setProvenanceExpanded(false);
  });
  els.provenanceLine.querySelector("[data-change-parent]").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.currentImage) openSetParentModal(state.currentImage.id);
  });
  els.provenanceLine.querySelector("[data-detach-parent]").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.currentImage) detachImageParent(state.currentImage.id, state.currentImage.display_name);
  });
  els.provenanceLine.querySelectorAll("[data-jump-to-image]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      selectImage(link.dataset.jumpToImage);
    });
  });
  const compareLink = els.provenanceLine.querySelector("[data-compare-parent]");
  if (compareLink) {
    compareLink.addEventListener("click", (e) => {
      e.preventDefault();
      setCompareAgainst(compareLink.dataset.compareParent);
    });
  }
}

function setProvenanceExpanded(expanded) {
  state.provenanceExpanded = expanded;
  localStorage.setItem("grok_img2img.provenanceExpanded", expanded ? "1" : "0");
  renderProvenanceLine(state.currentImage?.derived_from);
}

// Renders the results grid, followed by a dashed upload-dropzone card pinned
// as the last item (secondary to the actual results, which stay newest-first).
// Each result tile carries a copy-prompt icon (top-left, when there's a
// prompt to copy), a "more actions" kebab (top-right, for use-as-reference/
// use-as-new-source/delete), and thumbs-down/neutral/thumbs-up rating
// controls (bottom-right; the tile's border color already shows the current
// rating) -- so rating results no longer needs the old dedicated sidebar buttons.
//
// Pending jobs for `imageId`, keyed the same way both the full render and
// the lightweight poll-tick patch (below) build their markup and decide
// whether anything actually changed.
// A "sam3_cutout" job (the object-placement tool's detection step) never
// turns into a result -- it's excluded here and from failedJobsFor/renderChits
// so it doesn't show as a misleading "pending/failed result" for the image.
// It's still visible (and cancellable) in the main queue overlay, same as
// any other ComfyUI job -- see renderQueueOverlay/formatJobStatus.
function pendingJobsFor(imageId) {
  return state.queue.filter(
    (j) => j.image_id === imageId && j.kind !== "sam3_cutout" && (j.status === "queued" || j.status === "running")
  );
}

function failedJobsFor(imageId) {
  return [...state.failedJobs.values()].filter((j) => j.image_id === imageId);
}

function pendingTilesSignature(jobs, failed) {
  return [...jobs.map((j) => `${j.id}:${jobDisplayState(j)}`), ...failed.map((j) => `${j.id}:error`)].join(",");
}

function renderPendingTilesHtml(jobs, failed) {
  return jobs.map(renderPendingTileHtml).join("") + failed.map(renderFailedTileHtml).join("");
}

const PENDING_TILE_LABELS = { queued: "Queued…", running: "Generating…", cancelling: "Cancelling…" };

function renderPendingTileHtml(j) {
  const displayState = jobDisplayState(j);
  // No point offering to cancel something already cancelling.
  const cancelBtn =
    j.engine === "comfyui" && displayState !== "cancelling"
      ? `<button class="pending-tile-cancel" data-cancel-standby-job="${j.id}" title="Cancel this ComfyUI job">✕</button>`
      : "";
  return `
    <div class="result-tile pending-tile ${displayState}" title="${escapeHtml(formatJobStatus(j))}">
      <span class="spinner"></span>
      <span class="pending-tile-label">${PENDING_TILE_LABELS[displayState]}</span>
      ${cancelBtn}
    </div>
  `;
}

const ENGINE_LABELS = { grok: "Grok", comfyui: "Comfy", fal: "fal.ai" };

function renderFailedTileHtml(j) {
  const message = j.error || "Generation failed";
  return `
    <div class="result-tile pending-tile failed" title="${escapeHtml(message)}">
      <span class="failed-tile-icon">!</span>
      <span class="pending-tile-label">${escapeHtml(ENGINE_LABELS[j.engine] || j.engine)} failed</span>
      <span class="failed-tile-message">${escapeHtml(message)}</span>
      <button class="pending-tile-cancel" data-dismiss-failed-job="${j.id}" title="Dismiss">✕</button>
    </div>
  `;
}

// Marks the job cancelling in local state and re-renders its chit/tile
// immediately (unique color, no more cancel button) instead of leaving the
// click looking like it did nothing until the next ~1.2s poll happens to
// notice. Server confirmation (or a failure, which reverts the flag) still
// arrives the normal way through polling.
function wirePendingTileCancelButtons(container) {
  container.querySelectorAll("[data-dismiss-failed-job]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const job = state.failedJobs.get(btn.dataset.dismissFailedJob);
      state.failedJobs.delete(btn.dataset.dismissFailedJob);
      if (job) updatePendingTiles(job.image_id);
      renderImageList();
    });
  });
  container.querySelectorAll("[data-cancel-standby-job]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const jobId = btn.dataset.cancelStandbyJob;
      const job = state.queue.find((j) => j.id === jobId);
      if (job) job.cancel_requested = true;
      updatePendingTiles(job?.image_id);
      renderImageList();
      try {
        await api.cancelJob(jobId);
      } catch (err) {
        if (job) job.cancel_requested = false;
        updatePendingTiles(job?.image_id);
        renderImageList();
      }
    });
  });
}

// Tracks what the #pendingTiles container currently shows, so a routine poll
// tick with no actual change to the job set can skip touching the DOM there
// (see updatePendingTiles below).
let lastPendingTilesImageId = null;
let lastPendingTilesSignature = null;

// Also renders a standby tile (matching the sidebar's "pending" chit) for
// each queued/running job targeting `imageId`, pinned before the actual
// results -- so a job that's still in flight shows up here as visibly busy
// instead of the panel looking unchanged until it completes. Dim/static
// while queued, pulsing once actually running; ComfyUI jobs (the only engine
// that can be pulled back once submitted) get a cancel button.
function renderResultGrid(results, activeId, imageId) {
  const uploadCardHtml = `
    <div class="result-upload-card" id="resultUploadCard" title="Upload a result image">
      <span class="result-upload-card-icon">+</span>
      <span class="result-upload-card-label">Upload</span>
    </div>
  `;

  const pendingJobs = pendingJobsFor(imageId);
  const failedJobs = failedJobsFor(imageId);
  const pendingTilesHtml = `<div id="pendingTiles">${renderPendingTilesHtml(pendingJobs, failedJobs)}</div>`;
  lastPendingTilesImageId = imageId;
  lastPendingTilesSignature = pendingTilesSignature(pendingJobs, failedJobs);

  const tilesHtml = results
    .map((r) => {
      const activeClass = r.id === activeId ? "active" : "";
      const durationLabel = r.duration_seconds ? ` — generated in ${formatElapsed(r.duration_seconds)}` : "";
      const label = `${r.evaluation} — ${new Date(r.date_generated).toLocaleString()}${durationLabel}`;
      const promptText = r.adhoc_prompt_text || "";
      const promptAttr = escapeHtml(promptText);
      const copyBtn = promptText
        ? `<button class="result-tile-copy" data-copy-prompt="${promptAttr}" title="${promptAttr}">📋</button>`
        : "";
      const engineLabel = { grok: "Grok", comfyui: "Comfy", fal: "fal.ai", imported: "Imported" }[r.engine] || r.engine;
      const engineBadge = `<span class="result-tile-engine engine-${r.engine}">${escapeHtml(engineLabel)}</span>`;
      return `
        <div class="result-tile ${r.evaluation} ${activeClass}" data-id="${r.id}" title="${escapeHtml(label)}">
          <img src="/api/results/${r.id}/thumbnail" loading="lazy" />
          ${engineBadge}
          ${copyBtn}
          <button class="tile-menu-btn" data-menu-result="${r.id}" title="More actions">⋮</button>
          <div class="result-tile-rating">
            <div class="rating-controls">
              <button class="rating-btn no ${r.evaluation === "NO" ? "active" : ""}" data-rate="${r.id}" data-value="NO" title="No">👎</button>
              <button class="rating-btn maybe ${r.evaluation === "MAYBE" ? "active" : ""}" data-rate="${r.id}" data-value="MAYBE" title="Maybe">😐</button>
              <button class="rating-btn yes ${r.evaluation === "YES" ? "active" : ""}" data-rate="${r.id}" data-value="YES" title="Yes">👍</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  els.resultGrid.innerHTML = pendingTilesHtml + tilesHtml + uploadCardHtml;
  wirePendingTileCancelButtons(els.resultGrid);

  const uploadCardEl = document.getElementById("resultUploadCard");
  uploadCardEl.addEventListener("click", () => els.uploadResultInput.click());
  ["dragover", "dragleave", "drop"].forEach((evtName) => {
    uploadCardEl.addEventListener(evtName, (e) => {
      e.preventDefault();
      uploadCardEl.classList.toggle("dragover", evtName === "dragover");
    });
  });
  uploadCardEl.addEventListener("drop", async (e) => {
    const file = e.dataTransfer.files[0];
    await attachResultFile(file);
  });

  // Standby tiles also carry .result-tile but have no result to activate.
  els.resultGrid.querySelectorAll(".result-tile:not(.pending-tile)").forEach((el) => {
    el.addEventListener("click", async () => {
      const targetImageId = state.currentImageId;
      const resultId = el.dataset.id;
      // Instant feedback: highlight the clicked tile and dim the panel right
      // away, rather than leaving the click looking like it did nothing while
      // activate/reload/refetch run in sequence below.
      els.resultGrid.querySelectorAll(".result-tile.active").forEach((t) => t.classList.remove("active"));
      el.classList.add("active");
      els.detailsContent.classList.add("loading");
      try {
        await api.activateResult(resultId);
        await applyActivateResultToSidebar(targetImageId, resultId);
        if (state.currentImageId === targetImageId) {
          state.currentImage = await api.getImage(targetImageId);
          renderDetails();
        }
      } finally {
        // Never leave the panel dimmed and unclickable if a request fails
        // (unless another selectImage has taken over the loading state).
        if (state.currentImageId === targetImageId) els.detailsContent.classList.remove("loading");
      }
    });
  });
  els.resultGrid.querySelectorAll("[data-menu-result]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const resultId = btn.dataset.menuResult;
      const result = (state.currentImage?.results || []).find((r) => r.id === resultId);
      const promptText = result?.adhoc_prompt_text || "";
      openItemMenu(btn, [
        {
          icon: "📎",
          label: "Use as reference image",
          onClick: () => {
            const name = state.currentImage ? `${state.currentImage.display_name} result` : "result";
            useAsReferenceFromUrl(`/api/results/${resultId}/file`, name);
          },
        },
        {
          icon: "🔗",
          label: "Use as new source image",
          onClick: () => promoteResultToSource(resultId),
        },
        ...(promptText
          ? [
              {
                icon: "📝",
                label: "Use as current prompt",
                onClick: () => useResultPromptAsCurrent(promptText),
              },
            ]
          : []),
        {
          icon: "🗑",
          label: "Delete result",
          danger: true,
          onClick: async () => {
            const targetImageId = state.currentImageId;
            const ok = await openConfirmModal({
              title: "Move to Trash",
              message: "Move this result to Trash? You can restore it within 2 days.",
              confirmLabel: "Move to Trash",
              danger: true,
            });
            if (!ok) return;
            await api.deleteResult(resultId);
            if (state.currentImageId === targetImageId) {
              state.currentImage = await api.getImage(targetImageId);
              renderDetails();
            }
            await loadImages();
          },
        },
      ]);
    });
  });
  els.resultGrid.querySelectorAll("[data-copy-prompt]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = btn.dataset.copyPrompt;
      if (!text) return;
      if (!clipboardAvailable) {
        showPromptModal(text);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "✓";
      } catch (err) {
        btn.textContent = "✕";
      } finally {
        setTimeout(() => {
          btn.textContent = "📋";
        }, 1000);
      }
    });
  });
  els.resultGrid.querySelectorAll("[data-rate]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetImageId = state.currentImageId;
      const resultId = btn.dataset.rate;
      const value = btn.dataset.value;
      await api.setEvaluation(resultId, value);
      await applyRatingToSidebar(targetImageId, resultId, value);
      if (state.currentImageId === targetImageId) {
        state.currentImage = await api.getImage(targetImageId);
        renderDetails();
      }
    });
  });
}

// Per-image debounce timers, keyed by image id, so editing one image never cancels
// a pending save for another image you've since switched away from.
const saveTimers = new Map();
function scheduleSave() {
  const targetImageId = state.currentImageId;
  if (!targetImageId) return;
  const displayName = els.displayNameInput.value.trim();
  const comment = els.commentInput.value;
  clearTimeout(saveTimers.get(targetImageId));
  saveTimers.set(
    targetImageId,
    setTimeout(async () => {
      saveTimers.delete(targetImageId);
      await api.updateImage(targetImageId, { display_name: displayName, comment });
      await loadImages();
      if (state.currentImageId === targetImageId) {
        state.currentImage = await api.getImage(targetImageId);
        renderDetails();
      }
    }, 500)
  );
}
els.displayNameInput.addEventListener("input", scheduleSave);
els.commentInput.addEventListener("input", scheduleSave);

// The "current prompt" textarea isn't tied to any one image or project --
// it deliberately survives switching between them (see the top-level Prompt
// field) -- so it's persisted globally in localStorage too, restored on
// load, and kept in sync on every edit, whether typed or set programmatically
// (selecting a saved prompt, picking one from the palette, or pulling a past
// result's prompt back in below) so a page refresh never silently loses
// whatever was being drafted.
const PROMPT_TEXT_STORAGE_KEY = "grok_img2img.currentPromptText";

function setPromptText(text) {
  els.promptTextarea.value = text;
  localStorage.setItem(PROMPT_TEXT_STORAGE_KEY, text);
}

els.promptTextarea.addEventListener("input", () => {
  localStorage.setItem(PROMPT_TEXT_STORAGE_KEY, els.promptTextarea.value);
  // Editing away from the picked saved prompt makes the title stale, so drop
  // the pick and fall back to ad-hoc.
  const selected = state.prompts.find((p) => p.id === state.selectedPromptId);
  if (selected && els.promptTextarea.value.trim() !== selected.prompt_text.trim()) {
    state.selectedPromptId = null;
    renderPromptMenuButton();
  }
});

const savedPromptText = localStorage.getItem(PROMPT_TEXT_STORAGE_KEY);
if (savedPromptText) els.promptTextarea.value = savedPromptText;

// "Use as current prompt" (result tile menu): pulls a past result's actual
// prompt back into the draft textarea for re-running/tweaking. Resets the
// saved-prompt dropdown to ad-hoc, since the result's prompt text may not
// match that prompt's current saved text (or may not have come from a saved
// prompt at all).
function useResultPromptAsCurrent(promptText) {
  state.selectedPromptId = null;
  renderPromptMenuButton();
  setPromptText(promptText);
}

// ---------------------------------------------------------------------------
// Reference images -- up to MAX_REFERENCE_IMAGES images picked from this
// project's reference-image library (the References sidebar tab, a separate
// pool from source images) and sent alongside the source image on generate.
// Supported by all engines (ComfyUI, Grok, and fal.ai models whose request
// shape takes an image array -- an unsupported fal model errors out at
// generate time with a message naming the model). Selection persists across
// image switches, same as the engine/aspect-ratio selects, and is remembered
// per project across project switches (see referencePicksByProject).
// ---------------------------------------------------------------------------
// Both SAM3 ComfyUI workflows only have one free manual reference-image slot
// (the other is occupied by the auto-generated SAM3 crop), vs. 2 for every
// other engine/workflow.
function isSam3Workflow() {
  return els.engineSelect.value === "comfyui" && els.comfyWorkflowSelect.value.startsWith("sam3");
}
function maxReferenceImages() {
  return isSam3Workflow() ? 1 : 2;
}

function updateReferenceImagesVisibility() {
  els.referenceImagesField.style.display = "flex";
  const max = maxReferenceImages();
  els.referenceImagesHint.textContent = `(up to ${max}; not all fal.ai models support these)`;
  if (state.referenceImageIds.length > max) {
    state.referenceImageIds = state.referenceImageIds.slice(0, max);
    renderReferenceImages();
  }
}

// A SAM3 placement's reference image is scoped to one image (see db's
// source_image_id) and deliberately excluded from state.referenceImages
// (the project-wide library) -- resolve it from the current image detail
// instead when it shows up in the selected ids.
function resolveReferenceForDisplay(id) {
  const ref = state.referenceImages.find((r) => r.id === id);
  if (ref) return ref;
  const sam3Ref = state.currentImage?.sam3_reference;
  return sam3Ref && sam3Ref.id === id ? sam3Ref : null;
}

// A finished SAM3 detection sits in the reference library "needing
// attention" (needs_composite) until it's positioned -- surfaced here as a
// dedicated banner (the "special icon" next to the ordinary reference
// chips), separate from and in addition to the sidebar's smaller chit on
// the image list (see renderChits), since this is the place to actually act
// on it. It's never in referenceImageIds (see reconcileSam3ReferenceSelection),
// so it wouldn't otherwise appear in this row at all.
function renderSam3PendingBannerHtml() {
  const image = state.currentImage;
  if (!image) return "";
  const ref = image.sam3_reference;
  const pending = sam3PendingLayerJobs(image.id);
  // While any layer is still detecting, say so instead of either staying
  // silent or claiming the whole placement is ready -- the latter used to
  // fire as soon as the *first* of several queued layers finished.
  if (pending.length) {
    return `
      <div class="reference-pending-banner reference-pending-banner-waiting" id="sam3PendingBanner">
        <span class="spinner"></span>
        <span>Detecting ${pending.length} more SAM3 layer${pending.length > 1 ? "s" : ""}...</span>
      </div>
    `;
  }
  if (!ref || !ref.needs_composite) return "";
  return `
    <button type="button" class="reference-pending-banner" id="sam3PendingBanner" title="Click to position this object on the image">
      <span class="reference-pending-icon">✨</span>
      <span>SAM3 placement ready — click to position</span>
    </button>
  `;
}

// The button's wording reflects what clicking it will actually do, which
// changed once detection became fire-and-forget (see openSam3PlacementModal):
// most of the time it starts a fresh background detection, but once one has
// finished and is sitting unpositioned (the banner above), clicking it jumps
// straight to positioning instead, skipping the prompt step entirely -- so
// "Position object" was misleading as the one label for both. While a batch
// is still detecting, it instead jumps to the wait-then-position flow (see
// openSam3PlacementModal), so the label says that's what's happening.
function updateSam3PlaceBtn() {
  const image = state.currentImage;
  if (!image) return;
  const ref = image.sam3_reference;
  const pending = sam3PendingLayerJobs(image.id);
  if (pending.length) {
    els.sam3PlaceBtn.textContent = `⏳ Detecting ${pending.length} more layer${pending.length > 1 ? "s" : ""}...`;
    els.sam3PlaceBtn.title = "SAM3 is still detecting the rest of this batch's layers";
  } else if (ref && ref.needs_composite) {
    els.sam3PlaceBtn.textContent = "📍 Position object (SAM3)";
    els.sam3PlaceBtn.title = "Drag and resize the already-detected object onto this image";
  } else {
    els.sam3PlaceBtn.textContent = "✨ Detect object (SAM3)";
    els.sam3PlaceBtn.title = "Detect an object with SAM3 in the background, then position it onto this image";
  }
}

function renderReferenceImages() {
  updateSam3PlaceBtn();
  const chipsHtml = state.referenceImageIds
    .map((id) => {
      const ref = resolveReferenceForDisplay(id);
      const label = escapeHtml(ref ? ref.display_name : "");
      return `
        <div class="reference-image-thumb" title="${label}">
          <img src="${ref ? refThumbUrl(ref) : `/api/reference-images/${id}/thumbnail`}" loading="lazy" data-view-ref="${id}" />
          <span class="reference-image-thumb-remove" data-remove-ref="${id}" title="Remove">✕</span>
        </div>
      `;
    })
    .join("");
  els.referenceImageList.innerHTML = renderSam3PendingBannerHtml() + chipsHtml;
  els.referenceImageList.querySelectorAll("[data-remove-ref]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.referenceImageIds = state.referenceImageIds.filter((id) => id !== btn.dataset.removeRef);
      renderReferenceImages();
    });
  });
  els.referenceImageList.querySelectorAll("[data-view-ref]").forEach((img) => {
    img.addEventListener("click", () => {
      const id = img.dataset.viewRef;
      openReferenceLightbox(resolveReferenceForDisplay(id), id);
    });
  });
  // Only the "ready" banner (a <button>) is clickable -- the "still
  // detecting" one (a plain <div>, see renderSam3PendingBannerHtml) is
  // informational only, since there's nothing to position yet.
  const banner = els.referenceImageList.querySelector("button#sam3PendingBanner");
  if (banner) banner.addEventListener("click", openSam3PlacementModal);
}

// A SAM3 placement reference belongs to exactly one image, but
// referenceImageIds otherwise persists across image switches within a
// project (see referencePicksByProject) -- so a stale one from whatever
// image was open before needs dropping. This image's own placement stays
// selected only if it already was (e.g. just saved); it's never added here.
function reconcileSam3ReferenceSelection(img) {
  // An unfinished placement (needs_composite -- still just the raw SAM3
  // cutout, transparent background) isn't something to feed a generation
  // with; it's not selectable at all until positioned. See the "needs
  // positioning" banner in renderReferenceImages for how it's surfaced
  // instead.
  const ref = img.sam3_reference;
  const ownSam3RefId = ref && !ref.needs_composite ? ref.id : null;
  state.referenceImageIds = state.referenceImageIds.filter(
    (id) => id === ownSam3RefId || state.referenceImages.some((r) => r.id === id)
  );
  // Deliberately not auto-selecting the image's own placement here: doing so
  // re-added a stale SAM3 edit every time an old source was reopened (and
  // undid any deselection on the next re-render). A fresh placement is
  // selected when it's saved (see the setSam3Reference call site); after
  // that it's opt-in via the picker, which still offers it.
  renderReferenceImages();
}

// The open image's own SAM3 placement (when positioned) is offered ahead of
// the project library -- it's excluded from state.referenceImages, so without
// this a deselected one could never be re-picked.
function referencePickerEntries() {
  const ref = state.currentImage?.sam3_reference;
  const own = ref && !ref.needs_composite ? [ref] : [];
  return [...own, ...state.referenceImages];
}

function openReferenceImagePicker() {
  const entries = referencePickerEntries();
  if (!entries.length) {
    const modal = openModal(`
      <h3>Add reference image</h3>
      <p class="dup-section-hint">This project has no reference images yet. Add some in the References tab first.</p>
      <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
    `);
    modal.querySelector("#mCancel").addEventListener("click", closeModal);
    return;
  }
  const max = maxReferenceImages();
  const modal = openModal(`
    <h3>Add reference image</h3>
    <p class="dup-section-hint">Select up to ${max} images from this project's reference library.</p>
    <div class="picker-grid" id="refPickerGrid"></div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const grid = modal.querySelector("#refPickerGrid");
  grid.innerHTML = entries
    .map((ref) => {
      const selected = state.referenceImageIds.includes(ref.id);
      const disabled = !selected && state.referenceImageIds.length >= max;
      const title = escapeHtml(ref.source_image_id ? `${ref.display_name} (this image's SAM3 placement)` : ref.display_name);
      return `
        <div class="picker-item ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}" data-picker-id="${ref.id}" title="${title}">
          <img src="${refThumbUrl(ref)}" loading="lazy" />
          <div class="reference-library-item-actions">
            <button class="reference-library-item-btn" data-view-picker-ref="${ref.id}" title="View full size">🔍</button>
          </div>
        </div>
      `;
    })
    .join("");
  grid.querySelectorAll("[data-picker-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.pickerId;
      const idx = state.referenceImageIds.indexOf(id);
      if (idx !== -1) {
        state.referenceImageIds.splice(idx, 1);
      } else if (state.referenceImageIds.length < max) {
        state.referenceImageIds.push(id);
      } else {
        return;
      }
      renderReferenceImages();
      openReferenceImagePicker(); // re-render the grid with updated selection state
    });
  });
  grid.querySelectorAll("[data-view-picker-ref]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.viewPickerRef;
      openReferenceLightbox(resolveReferenceForDisplay(id), id);
    });
  });
}

// Interactive rectangular crop: shows imageUrl at a size that fits the modal,
// with a draggable/resizable selection box. initialBox and the box passed to
// onSave are both in the *natural* pixel coordinates of the full image, so
// callers never have to think about the display scale factor.
function openCropModal({ title, imageUrl, naturalWidth, naturalHeight, initialBox, onSave, onCancel }) {
  const maxW = 540;
  const maxH = 440;
  const scale = Math.min(maxW / naturalWidth, maxH / naturalHeight, 1);
  const dispW = Math.round(naturalWidth * scale);
  const dispH = Math.round(naturalHeight * scale);
  const minSize = 16;

  const modal = openModal(`
    <h3>${escapeHtml(title)}</h3>
    <div class="crop-stage-wrap">
      <div class="crop-stage" id="cropStage" style="width:${dispW}px;height:${dispH}px">
        <img id="cropImg" src="${imageUrl}" draggable="false" style="width:${dispW}px;height:${dispH}px" />
        <div class="crop-box" id="cropBox">
          <div class="crop-handle crop-handle-nw" data-handle="nw"></div>
          <div class="crop-handle crop-handle-ne" data-handle="ne"></div>
          <div class="crop-handle crop-handle-sw" data-handle="sw"></div>
          <div class="crop-handle crop-handle-se" data-handle="se"></div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button id="cropResetBtn" class="btn-ghost" type="button">Reset to full image</button>
      <button id="cropCancelBtn" class="btn-ghost" type="button">Cancel</button>
      <button id="cropSaveBtn" class="btn-primary" type="button">Save</button>
    </div>
  `);

  let settled = false;
  function settleCancel() {
    if (settled) return;
    settled = true;
    if (onCancel) onCancel();
  }
  setModalOnClose(settleCancel);

  const stage = modal.querySelector("#cropStage");
  const boxEl = modal.querySelector("#cropBox");
  let box; // current selection in DISPLAY pixel coords, relative to the stage

  function setBox(next) {
    let { x, y, w, h } = next;
    w = Math.max(minSize, Math.min(w, dispW));
    h = Math.max(minSize, Math.min(h, dispH));
    x = Math.max(0, Math.min(x, dispW - w));
    y = Math.max(0, Math.min(y, dispH - h));
    box = { x, y, w, h };
    boxEl.style.left = `${x}px`;
    boxEl.style.top = `${y}px`;
    boxEl.style.width = `${w}px`;
    boxEl.style.height = `${h}px`;
  }

  if (initialBox) {
    setBox({ x: initialBox.x * scale, y: initialBox.y * scale, w: initialBox.w * scale, h: initialBox.h * scale });
  } else {
    setBox({ x: 0, y: 0, w: dispW, h: dispH });
  }

  modal.querySelector("#cropResetBtn").addEventListener("click", () => setBox({ x: 0, y: 0, w: dispW, h: dispH }));

  function pointerPos(evt) {
    const rect = stage.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  let drag = null; // { mode: "move" | "resize", handle, start: {x,y}, startBox }
  boxEl.addEventListener("pointerdown", (evt) => {
    const handle = evt.target.dataset.handle;
    drag = { mode: handle ? "resize" : "move", handle, start: pointerPos(evt), startBox: { ...box } };
    boxEl.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });
  boxEl.addEventListener("pointermove", (evt) => {
    if (!drag) return;
    const p = pointerPos(evt);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.mode === "move") {
      setBox({ x: drag.startBox.x + dx, y: drag.startBox.y + dy, w: drag.startBox.w, h: drag.startBox.h });
      return;
    }
    let { x, y, w, h } = drag.startBox;
    if (drag.handle.includes("n")) {
      y = drag.startBox.y + dy;
      h = drag.startBox.h - dy;
    }
    if (drag.handle.includes("s")) h = drag.startBox.h + dy;
    if (drag.handle.includes("w")) {
      x = drag.startBox.x + dx;
      w = drag.startBox.w - dx;
    }
    if (drag.handle.includes("e")) w = drag.startBox.w + dx;
    setBox({ x, y, w, h });
  });
  boxEl.addEventListener("pointerup", () => {
    drag = null;
  });
  boxEl.addEventListener("pointercancel", () => {
    drag = null;
  });

  // modalBack (not closeModal) so a caller that pushed a "redraw me" step
  // (the lightbox's Edit crop button) returns there instead of closing
  // outright; with nothing pushed it falls through to closeModal() same as
  // before, still triggering settleCancel via modalOnClose.
  modal.querySelector("#cropCancelBtn").addEventListener("click", modalBack);
  modal.querySelector("#cropSaveBtn").addEventListener("click", async () => {
    const natural = { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
    // Cropped right here in the browser, from the full-resolution <img> this
    // modal already has loaded -- the server just persists the resulting
    // bytes (see api.js/storage.py), no Pillow round-trip needed for a plain
    // rectangular crop.
    const blob = await cropImageToBlob(modal.querySelector("#cropImg"), natural);
    settled = true; // suppress the settleCancel that closeModal() would otherwise fire
    closeModal();
    onSave(natural, blob);
  });
}

// Crops imgEl (its full natural-resolution bitmap, already decoded by the
// browser) to box (natural pixel coords, fractional) and returns a PNG blob.
// Flattens onto white first, matching what the server used to do when it
// normalized/cropped with Pillow -- source images here never actually carry
// alpha (reference originals are flattened on upload), but this keeps that
// invariant even if one somehow did.
function cropImageToBlob(imgEl, box) {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(imgEl, x, y, w, h, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Opens the zoom lightbox for a reference image, outlining whatever crop is
// currently applied over the full original (see openImageLightbox's `crop`
// option) instead of just showing the original with no indication of what
// region actually feeds generation. `ref` may be null (a stale/missing
// reference -- see resolveReferenceForDisplay), in which case this falls
// back to a plain lightbox with no crop overlay or edit action.
//
// The "Edit crop" button pushes a step that redraws this same lightbox onto
// modalBackStack before opening openCropModal, so cancelling returns here;
// saving re-fetches the ref (its crop fields and active file both changed)
// and reopens this lightbox with the updated crop shown. A SAM3 placement
// reference (ref.source_image_id set, see renderReferenceLibrary/picker)
// isn't in state.referenceImages, so it refreshes via state.currentImage
// instead of loadReferenceImages.
function openReferenceLightbox(ref, id) {
  const refId = ref ? ref.id : id;
  const crop =
    ref && ref.crop_x != null
      ? { x: ref.crop_x, y: ref.crop_y, w: ref.crop_w, h: ref.crop_h, naturalWidth: ref.orig_width, naturalHeight: ref.orig_height }
      : null;
  openImageLightbox(`/api/reference-images/${refId}/original`, ref ? ref.display_name : "", {
    crop,
    onEditCrop: ref
      ? () => {
          pushModalBack(() => openReferenceLightbox(ref, id));
          openCropModal({
            title: `Crop "${ref.display_name}"`,
            imageUrl: `/api/reference-images/${refId}/original`,
            naturalWidth: ref.orig_width,
            naturalHeight: ref.orig_height,
            initialBox: crop,
            onSave: async (box, blob) => {
              await api.recropReferenceImage(refId, box, blob);
              if (ref.source_image_id) {
                if (state.currentImageId) {
                  state.currentImage = await api.getImage(state.currentImageId);
                  renderDetails();
                  openReferenceLightbox(state.currentImage.sam3_reference, id);
                }
              } else {
                await loadReferenceImages();
                openReferenceLightbox(state.referenceImages.find((r) => r.id === refId), id);
              }
            },
          });
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// SAM3 interactive object placement: detects the named object with SAM3 as a
// transparent cutout, then lets the user drag/resize it directly onto the
// source image (reusing the crop tool's drag/resize interaction, minus its
// crop-mask styling) instead of tuning scale/pin numbers and re-running a
// full ComfyUI generation to see the result. The final composite is saved
// as a reference image scoped to this one image (db's source_image_id /
// get_scoped_reference_image) -- excluded from the project's general
// reference library, and auto-selected for the next generation.
// ---------------------------------------------------------------------------
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
}

function existingSam3Prompt(image) {
  const name = image.sam3_reference?.display_name || "";
  return name.startsWith("SAM3: ") ? name.slice(6) : "";
}

// A finished multi-layer placement stores its original per-layer prompts
// as a JSON array (sam3_reference.sam3_prompts -- see the save handler in
// renderSam3StageStep) alongside the human-readable ", "-joined
// display_name, so re-opening the prompt step for it (e.g. "try a
// different prompt") can restore the exact original rows. display_name
// alone isn't safe to split back apart -- a single prompt can itself
// contain a comma -- so that's only a last-resort fallback for a
// placement saved before sam3_prompts existed.
function existingSam3Prompts(image) {
  const raw = image.sam3_reference?.sam3_prompts;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
  }
  const joined = existingSam3Prompt(image);
  if (!joined) return null;
  const parts = joined.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// ---------------------------------------------------------------------------
// Quad warp math for the SAM3 placement tool's free-corner (ctrl+drag) mode.
// The placement is a quadrilateral (nw/ne/sw/se corners, each {x,y}) rather
// than a plain box -- a rectangle is just the common case where all four
// corners still form a right angle. A quad can also grow an optional
// midpoint control point on any of its four edges (see EDGE_MIDS/edgePoint
// below), letting that edge bend instead of staying straight, and can be
// rotated as a whole (see rotatePoint/quadCenter) by spinning every point
// it currently has -- corners and edge points alike -- around its center.
// Canvas 2D has no built-in way to draw an image into an arbitrary
// quadrilateral, let alone one with bent edges, so it's approximated the
// standard way: split the quad into a grid of smaller quads, each drawn as
// two affine-warped (clipped) copies of the corresponding piece of the
// source image (see drawWarpedQuad below), with each small quad's own
// corners positioned via a Coons patch (coonsPoint) so bent edges curve
// smoothly rather than just kinking at the midpoint. A true single-pass
// projective warp would need per-pixel resampling; this mesh of affine
// triangles is the cheap, GPU-free alternative and converges to it as the
// grid gets finer.
// ---------------------------------------------------------------------------
const QUAD_CORNERS = ["nw", "ne", "sw", "se"];
// Optional edge-midpoint control points, one per side. Each maps to the pair
// of corners it sits between -- used both to compute its default position
// (the straight midpoint) when it hasn't been dragged, and to draw the
// curve its edge follows once it has. Absent from a quad until the "Edge
// points" toggle adds them (see renderSam3StageStep).
const EDGE_MIDS = ["n", "e", "s", "w"];
const EDGE_MID_CORNERS = { n: ["nw", "ne"], s: ["sw", "se"], w: ["nw", "sw"], e: ["ne", "se"] };

// A quad's corners plus whichever edge-midpoints it currently has.
function cloneQuad(q) {
  const out = {};
  for (const k of Object.keys(q)) out[k] = { ...q[k] };
  return out;
}

// The position of edge midpoint `key`: its own stored point if the user has
// dragged it, otherwise the straight-line midpoint of its two corners (which
// makes coonsPoint below reduce exactly to plain bilinear interpolation for
// a quad that has no custom edge points at all -- see its comment).
function edgePoint(quad, key) {
  if (quad[key]) return quad[key];
  const [a, b] = EDGE_MID_CORNERS[key];
  return { x: (quad[a].x + quad[b].x) / 2, y: (quad[a].y + quad[b].y) / 2 };
}

// Quad center (corners only), used as the pivot for rotation.
function quadCenter(quad) {
  return {
    x: (quad.nw.x + quad.ne.x + quad.sw.x + quad.se.x) / 4,
    y: (quad.nw.y + quad.ne.y + quad.sw.y + quad.se.y) / 4,
  };
}

function rotatePoint(p, center, angle) {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, hi));
}

// Ray-casting point-in-polygon test, used to tell a click meant to move the
// placement from a click on the empty stage around it (the hit area is no
// longer a simple rectangle once a corner's been dragged free).
function pointInQuad(p, q) {
  const pts = [q.nw, q.ne, q.se, q.sw];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// The 2D affine transform [a b c d e f] (same order Canvas2D's ctx.transform
// takes) mapping source triangle src[0..2] onto destination triangle
// dst[0..2], solved via Cramer's rule from the three point correspondences.
function triangleAffine(src, dst) {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-8) return null;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;
  return [a, b, c, d, e, f];
}

function drawTexturedTriangle(ctx, img, src, dst) {
  const m = triangleAffine(src, dst);
  if (!m) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dst[0].x, dst[0].y);
  ctx.lineTo(dst[1].x, dst[1].y);
  ctx.lineTo(dst[2].x, dst[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(...m);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// Quadratic (Lagrange) interpolation through p0 (t=0), pMid (t=0.5) and p1
// (t=1) -- used to curve an edge through its midpoint control point instead
// of just drawing it straight.
function quadLerp(p0, pMid, p1, t) {
  const l0 = 2 * t * t - 3 * t + 1;
  const l1 = -4 * t * t + 4 * t;
  const l2 = 2 * t * t - t;
  return { x: l0 * p0.x + l1 * pMid.x + l2 * p1.x, y: l0 * p0.y + l1 * pMid.y + l2 * p1.y };
}

// Coons patch: fills the quad's interior at (u, v) in [0, 1] from its four
// boundary curves (each a quadLerp through its two corners and its edge
// midpoint -- straight if that midpoint hasn't been dragged off-center).
// When all four edges are still straight this is exactly equivalent to
// plain bilinear interpolation of the four corners (the old lerpQuad): a
// quadLerp through a corner-average midpoint reduces to a straight lerp, so
// existing quads with no edge points render identically.
function coonsPoint(quad, u, v) {
  const top = quadLerp(quad.nw, edgePoint(quad, "n"), quad.ne, u);
  const bottom = quadLerp(quad.sw, edgePoint(quad, "s"), quad.se, u);
  const left = quadLerp(quad.nw, edgePoint(quad, "w"), quad.sw, v);
  const right = quadLerp(quad.ne, edgePoint(quad, "e"), quad.se, v);
  const bx = (1 - u) * (1 - v) * quad.nw.x + u * (1 - v) * quad.ne.x + (1 - u) * v * quad.sw.x + u * v * quad.se.x;
  const by = (1 - u) * (1 - v) * quad.nw.y + u * (1 - v) * quad.ne.y + (1 - u) * v * quad.sw.y + u * v * quad.se.y;
  return {
    x: (1 - v) * top.x + v * bottom.x + (1 - u) * left.x + u * right.x - bx,
    y: (1 - v) * top.y + v * bottom.y + (1 - u) * left.y + u * right.y - by,
  };
}

// Draws `img` warped so its four corners land on quad.nw/ne/sw/se, in
// whatever coordinate space `quad` is expressed in (the ctx's own pixels).
// A single quad split into 2 affine triangles shows a visible shear along
// that diagonal once the quad isn't a rectangle, because the two triangles
// use unrelated linear mappings on either side of a shared edge. Subdividing
// into a grid of smaller quads (each still 2 triangles) bilinearly interpolates
// the corners instead, so the warp approaches a smooth projective one and the
// crease disappears -- cheap since it's still plain canvas affine draws.
const QUAD_MESH_STEPS = 12;
function drawWarpedQuad(ctx, img, quad) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const n = QUAD_MESH_STEPS;
  for (let row = 0; row < n; row++) {
    const v0 = row / n;
    const v1 = (row + 1) / n;
    for (let col = 0; col < n; col++) {
      const u0 = col / n;
      const u1 = (col + 1) / n;
      const srcNW = { x: u0 * w, y: v0 * h };
      const srcNE = { x: u1 * w, y: v0 * h };
      const srcSW = { x: u0 * w, y: v1 * h };
      const srcSE = { x: u1 * w, y: v1 * h };
      const dstNW = coonsPoint(quad, u0, v0);
      const dstNE = coonsPoint(quad, u1, v0);
      const dstSW = coonsPoint(quad, u0, v1);
      const dstSE = coonsPoint(quad, u1, v1);
      drawTexturedTriangle(ctx, img, [srcNW, srcNE, srcSE], [dstNW, dstNE, dstSE]);
      drawTexturedTriangle(ctx, img, [srcNW, srcSE, srcSW], [dstNW, dstSE, dstSW]);
    }
  }
}

// Detection is fire-and-forget (see api.startSam3CutoutBatch): it's just
// queued here and the modal closes right away, so a long wait behind other
// work in ComfyUI's queue -- or just wanting to go do something else in the
// meantime -- never leaves anything blocked. Its result shows up later as a
// "needs positioning" chit in the sidebar (renderChits) and a banner here in
// the details panel (renderSam3PendingBannerHtml) once list_images/getImage
// next report it, via the normal queue poll's anyNewlyFinished handling --
// no separate polling loop needed for this modal at all. While any layer of
// the batch is still detecting, this goes to the same wait-then-position
// flow as a finished batch (it shows live "waiting for N more" status)
// rather than either re-opening the prompt step or jumping into positioning
// with an incomplete set of layers.
function openSam3PlacementModal() {
  const imageId = state.currentImageId;
  const image = state.currentImage;
  if (!imageId || !image) return;
  const ref = image.sam3_reference;
  if ((ref && ref.needs_composite) || sam3PendingLayerJobs(imageId).length) {
    openSam3PositioningModal(imageId, image);
  } else {
    renderSam3PromptStep(imageId, image);
  }
}

// Waits for every layer in the in-flight batch to finish -- piggybacking on
// the global queue poll already running (see pollQueue) rather than running
// a separate network poll of its own -- then loads the base image plus each
// finished cutout and enters the multi-layer positioning stage. Entered
// from the "needs positioning" banner/chit, skipping the prompt/detect step
// since detection already ran (or is still running) in the background.
async function openSam3PositioningModal(imageId, image) {
  const modal = openModal(`<h3>Position objects (SAM3)</h3><div id="sam3ModalStatus" class="status-line"><span class="spinner"></span><span>Loading...</span></div>`);
  const statusEl = () => modal.querySelector("#sam3ModalStatus");
  try {
    while (true) {
      const pending = state.queue.filter(
        (j) => j.image_id === imageId && j.kind === "sam3_cutout" && (j.status === "queued" || j.status === "running")
      );
      if (!pending.length) break;
      if (!statusEl()) return; // modal closed/cancelled while waiting
      statusEl().innerHTML = `<span class="spinner"></span><span>Waiting for ${pending.length} more layer${pending.length > 1 ? "s" : ""}...</span>`;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!statusEl()) return;
    const layers = await api.getSam3Layers(imageId);
    if (!layers.length) throw new Error("No SAM3 layers are ready to position");
    const baseUrl = sourceUrlFor(image).url;
    const cutoutImgs = await Promise.all(layers.map((ref) => loadImage(`/api/reference-images/${ref.id}/original?v=${ref.id}`)));
    const baseImg = await loadImage(baseUrl);
    if (!statusEl()) return;
    const layerData = layers.map((ref, i) => ({
      ref,
      img: cutoutImgs[i],
      prompt: existingSam3Prompt({ sam3_reference: ref }),
    }));
    renderSam3StageStep(imageId, image, baseImg, layerData);
  } catch (e) {
    if (statusEl()) statusEl().textContent = `Error: ${e.message}`;
  }
}

function renderSam3PromptStep(imageId, image) {
  const existing = image.sam3_reference;
  // Resuming this image's own in-progress placement takes priority; failing
  // that, offer the same set of prompts (and layer count) as whatever batch
  // was last submitted for any image, rather than always starting back at a
  // single blank row -- see rememberSam3LastBatch below.
  let prompts = existingSam3Prompts(image) || getSam3LastBatch() || [getSam3PromptHistory()[0] || ""];

  function currentValues(modal) {
    return [...modal.querySelectorAll(".sam3-prompt-input")].map((el) => el.value);
  }

  // Layers stack bottom-to-top in list order (row 1 = bottom); reordering
  // here keeps that order in sync with the positioning stage's sidebar,
  // which lists/stacks layers the same way once they're detected.
  function moveRow(modal, index, delta) {
    const values = currentValues(modal);
    const target = index + delta;
    if (target < 0 || target >= values.length) return;
    [values[index], values[target]] = [values[target], values[index]];
    prompts = values;
    renderRows(modal);
  }

  function renderRows(modal) {
    const rowsEl = modal.querySelector("#sam3PromptRows");
    rowsEl.innerHTML = prompts
      .map(
        (value, index) => `
      <div class="sam3-prompt-row">
        <span class="sam3-layer-index">${index + 1}</span>
        <div class="sam3-reorder-btns">
          <button type="button" class="sam3-reorder-btn" data-index="${index}" data-dir="-1" title="Move layer up" ${index === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="sam3-reorder-btn" data-index="${index}" data-dir="1" title="Move layer down" ${index === prompts.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <input type="text" class="sam3-prompt-input" placeholder="Object to detect..." list="sam3PromptHistoryList" value="${escapeAttr(value)}" />
        ${prompts.length > 1 ? `<button type="button" class="sam3-remove-row-btn" data-index="${index}" title="Remove layer">✕</button>` : ""}
      </div>
    `
      )
      .join("");
    rowsEl.querySelectorAll(".sam3-remove-row-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        prompts = currentValues(modal);
        prompts.splice(Number(btn.dataset.index), 1);
        renderRows(modal);
      });
    });
    rowsEl.querySelectorAll(".sam3-reorder-btn").forEach((btn) => {
      btn.addEventListener("click", () => moveRow(modal, Number(btn.dataset.index), Number(btn.dataset.dir)));
    });
  }

  const modal = openModal(`
    <h3>Detect objects (SAM3)</h3>
    <p class="dup-section-hint">Detects each object with SAM3 in the background, each as its own layer -- once they're all ready (watch for the amber chit on this image), come back here to arrange them onto the image before saving as a reference. Layers stack in the order listed below, bottom first.</p>
    <div class="field" id="sam3PromptRows"></div>
    <button id="sam3AddLayerBtn" class="btn-ghost sam3-add-layer-btn" type="button">+ Add layer</button>
    <div id="sam3ModalStatus" class="status-line"></div>
    <div class="modal-actions">
      ${existing ? '<button id="sam3ModalRemoveBtn" class="btn-ghost" type="button">Remove placement</button>' : ""}
      <button id="sam3ModalCancelBtn" class="btn-ghost" type="button">Cancel</button>
      <button id="sam3ModalDetectBtn" class="btn-primary" type="button">Detect</button>
    </div>
  `);
  renderRows(modal);

  const statusEl = modal.querySelector("#sam3ModalStatus");
  const removeBtn = modal.querySelector("#sam3ModalRemoveBtn");
  const detectBtn = modal.querySelector("#sam3ModalDetectBtn");
  modal.querySelector("#sam3ModalCancelBtn").addEventListener("click", closeModal);
  modal.querySelector("#sam3AddLayerBtn").addEventListener("click", () => {
    prompts = [...currentValues(modal), ""];
    renderRows(modal);
    [...modal.querySelectorAll(".sam3-prompt-input")].at(-1)?.focus();
  });

  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      statusEl.textContent = "Removing...";
      try {
        await api.clearSam3Reference(imageId);
        state.referenceImageIds = state.referenceImageIds.filter((id) => id !== existing.id);
        if (state.currentImageId === imageId) {
          state.currentImage.sam3_reference = null;
          renderReferenceImages();
        }
        closeModal();
        loadImages(); // clears the sidebar's "needs positioning" chit if this was an unfinished one
      } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        removeBtn.disabled = false;
      }
    });
  }
  detectBtn.addEventListener("click", () => {
    const values = currentValues(modal)
      .map((v) => v.trim())
      .filter(Boolean);
    if (!values.length) {
      statusEl.textContent = "Enter at least one SAM3 prompt.";
      return;
    }
    values.forEach(rememberSam3Prompt);
    rememberSam3LastBatch(values);
    // Closes right away instead of waiting on startSam3CutoutBatch's
    // response -- that request submits every cache-miss layer to ComfyUI
    // synchronously server-side (see sam3_cutout_batch's docstring) so it can
    // take a while if ComfyUI is busy, and there's nothing left for this
    // modal to usefully show meanwhile: the jobs it's waiting on already show
    // up via the normal queue poll the moment the server creates them, well
    // before this request even returns.
    closeModal();
    api.startSam3CutoutBatch(imageId, values)
      .then(({ jobs }) => {
        jobs.forEach(mergeQueueJob);
        applyQueueOrdering();
        renderQueueOverlay();
        if (state.currentImageId === imageId) renderReferenceImages();
      })
      .catch((e) => {
        els.generateStatus.textContent = `Error starting SAM3 detection: ${e.message}`;
      });
  });
}

// layers: [{ ref, img, prompt }, ...] in bottom-to-top stacking order (as
// requested when detection was queued). Each layer gets its own quad
// (nw/ne/sw/se corners, same warp math as the single-layer tool used to);
// only the layer selected in the sidebar shows its handles, which jump to
// whichever layer becomes active -- the others stay exactly as positioned.
function renderSam3StageStep(imageId, image, baseImg, layers) {
  // The modal is near-fullscreen (see .modal:has(.sam3-stage-layout)) so
  // this tool gets as much precision room as the viewport allows for
  // dragging/resizing quads -- leaves just enough headroom for the layer
  // sidebar, title, hint text, status line and action buttons around it.
  const maxW = Math.max(600, Math.round(window.innerWidth * 0.98) - 220);
  const maxH = Math.max(420, Math.round(window.innerHeight * 0.96) - 170);
  const naturalWidth = baseImg.naturalWidth;
  const naturalHeight = baseImg.naturalHeight;
  const scale = Math.min(maxW / naturalWidth, maxH / naturalHeight, 1);
  const dispW = Math.round(naturalWidth * scale);
  const dispH = Math.round(naturalHeight * scale);

  // Default per-layer placement: each cutout at its own detected size
  // (capped to fit the stage), staggered slightly from center so several
  // layers don't all start exactly on top of each other -- each is still
  // just a starting point the user is about to drag/resize anyway.
  function initialQuad(img, index) {
    const fitScale = Math.min(dispW / img.naturalWidth, dispH / img.naturalHeight, 1);
    const w = img.naturalWidth * fitScale;
    const h = img.naturalHeight * fitScale;
    const stagger = (index - (layers.length - 1) / 2) * 24;
    const bx = clamp((dispW - w) / 2 + stagger, -dispW, dispW * 2);
    const by = clamp((dispH - h) / 2 + stagger, -dispH, dispH * 2);
    return {
      nw: { x: bx, y: by },
      ne: { x: bx + w, y: by },
      sw: { x: bx, y: by + h },
      se: { x: bx + w, y: by + h },
    };
  }
  let layerQuads = layers.map((l, i) => initialQuad(l.img, i));
  let activeIndex = layers.length - 1; // top layer selected by default

  const modal = openModal(`
    <h3>Position objects (SAM3)</h3>
    <div class="sam3-stage-layout">
      <div class="sam3-layer-sidebar" id="sam3LayerSidebar"></div>
      <div class="crop-stage-wrap sam3-stage-wrap">
        <div class="crop-stage" id="sam3Stage" style="width:${dispW}px;height:${dispH}px">
          <img id="sam3BaseImg" src="${baseImg.src}" draggable="false" style="width:${dispW}px;height:${dispH}px" />
          <canvas id="sam3Canvas" width="${dispW}" height="${dispH}" style="position:absolute;left:0;top:0;width:${dispW}px;height:${dispH}px;pointer-events:none"></canvas>
          <div class="placement-box" id="sam3Box">
            <div class="crop-handle crop-handle-quad" data-handle="nw"></div>
            <div class="crop-handle crop-handle-quad" data-handle="ne"></div>
            <div class="crop-handle crop-handle-quad" data-handle="sw"></div>
            <div class="crop-handle crop-handle-quad" data-handle="se"></div>
            <div class="crop-handle crop-handle-quad crop-handle-edge" data-handle="n"></div>
            <div class="crop-handle crop-handle-quad crop-handle-edge" data-handle="e"></div>
            <div class="crop-handle crop-handle-quad crop-handle-edge" data-handle="s"></div>
            <div class="crop-handle crop-handle-quad crop-handle-edge" data-handle="w"></div>
            <div class="crop-handle crop-handle-quad crop-handle-rotate" data-handle="rotate" title="Drag to rotate"></div>
          </div>
        </div>
      </div>
    </div>
    <p class="dup-section-hint">Select a layer at left, then drag to move, drag a corner or edge point to reshape it, or drag the handle above it to rotate. <button id="sam3EdgePointsBtn" class="btn-ghost sam3-edge-points-btn" type="button"></button></p>
    <div id="sam3ModalStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="sam3ModalRemoveBtn" class="btn-ghost" type="button">Discard</button>
      <button id="sam3ModalBackBtn" class="btn-ghost" type="button">Try different prompts</button>
      <button id="sam3ModalCancelBtn" class="btn-ghost" type="button">Cancel</button>
      <button id="sam3ModalSaveBtn" class="btn-primary" type="button">Save as reference</button>
    </div>
  `);

  const stage = modal.querySelector("#sam3Stage");
  const boxEl = modal.querySelector("#sam3Box");
  const statusEl = modal.querySelector("#sam3ModalStatus");
  const sidebarEl = modal.querySelector("#sam3LayerSidebar");

  // Swaps two layers' stacking position -- both their z-order (layers'
  // array order, which render() draws bottom to top) and their sidebar
  // position move together, since the sidebar lists them in the same
  // order they're stacked. The active selection follows whichever layer
  // moved, so reordering never silently switches what the handles act on.
  function moveLayer(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= layers.length) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    [layerQuads[index], layerQuads[target]] = [layerQuads[target], layerQuads[index]];
    if (activeIndex === index) activeIndex = target;
    else if (activeIndex === target) activeIndex = index;
    renderSidebar();
    render();
    updateEdgePointsBtn();
  }

  function renderSidebar() {
    sidebarEl.innerHTML = layers
      .map(
        (l, i) => `
      <div class="sam3-layer-item-row">
        <div class="sam3-reorder-btns">
          <button type="button" class="sam3-reorder-btn" data-index="${i}" data-dir="-1" title="Move layer up" ${i === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="sam3-reorder-btn" data-index="${i}" data-dir="1" title="Move layer down" ${i === layers.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <button type="button" class="sam3-layer-item${i === activeIndex ? " active" : ""}" data-index="${i}">${escapeHtml(l.prompt || l.ref.display_name)}</button>
      </div>
    `
      )
      .join("");
    sidebarEl.querySelectorAll(".sam3-layer-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeIndex = Number(btn.dataset.index);
        renderSidebar();
        render();
        updateEdgePointsBtn();
      });
    });
    sidebarEl.querySelectorAll(".sam3-reorder-btn").forEach((btn) => {
      btn.addEventListener("click", () => moveLayer(Number(btn.dataset.index), Number(btn.dataset.dir)));
    });
  }
  renderSidebar();

  // Reachable right from the stage, not just by backing out to the prompt
  // step first -- the usual reason to want this here is "wrong object, bad
  // crop" becoming obvious only once you're looking at it positioned. This
  // discards every layer in the placement, not just the active one.
  modal.querySelector("#sam3ModalRemoveBtn").addEventListener("click", async (evt) => {
    evt.currentTarget.disabled = true;
    statusEl.textContent = "Removing...";
    try {
      await api.clearSam3Reference(imageId);
      state.referenceImageIds = state.referenceImageIds.filter((id) => id !== image.sam3_reference?.id);
      if (state.currentImageId === imageId) {
        state.currentImage.sam3_reference = null;
        renderReferenceImages();
      }
      closeModal();
      loadImages();
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
      evt.currentTarget.disabled = false;
    }
  });
  // Each placement is a quad (nw/ne/sw/se corners, in DISPLAY pixel coords
  // relative to the stage) rather than a plain box: a rectangle is just the
  // case where all four corners still form a right angle. Dragging a corner
  // moves only that corner -- the other three stay put, turning resize into
  // skew/distort -- since linking opposite corners together made drags feel
  // like they were affecting the wrong point. Rotation is the one operation
  // that still moves every point together, as a rigid transform.
  const canvas = modal.querySelector("#sam3Canvas");
  const ctx2d = canvas.getContext("2d");
  const handleEls = {};
  for (const k of QUAD_CORNERS) handleEls[k] = boxEl.querySelector(`[data-handle="${k}"]`);
  for (const k of EDGE_MIDS) handleEls[k] = boxEl.querySelector(`[data-handle="${k}"]`);
  const rotateHandleEl = boxEl.querySelector('[data-handle="rotate"]');
  const HANDLE_CURSORS = { nw: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", se: "nwse-resize" };
  const ROTATE_HANDLE_DIST = 28;
  const edgePointsBtn = modal.querySelector("#sam3EdgePointsBtn");

  function activeQuad() {
    return layerQuads[activeIndex];
  }

  function hasEdgePoints(quad) {
    return EDGE_MIDS.some((k) => quad[k]);
  }

  // Turns a plain corner quad into one with all four edge midpoints as real,
  // independently-draggable points (initialized at their current straight
  // position, so turning this on never moves anything by itself), or strips
  // them back off a quad that has them -- discarding any bends.
  function toggleEdgePoints() {
    const quad = activeQuad();
    const next = cloneQuad(quad);
    if (hasEdgePoints(quad)) {
      for (const k of EDGE_MIDS) delete next[k];
    } else {
      for (const k of EDGE_MIDS) next[k] = edgePoint(quad, k);
    }
    setQuad(next);
    updateEdgePointsBtn();
  }
  function updateEdgePointsBtn() {
    edgePointsBtn.textContent = hasEdgePoints(activeQuad()) ? "Remove edge points" : "+ Edge points";
  }
  edgePointsBtn.addEventListener("click", toggleEdgePoints);

  // Unlike the crop box, this is allowed to run past the stage's edges in
  // either direction -- the final composite (see the Save handler below)
  // draws it onto a canvas sized to the base image, which silently clips
  // whatever falls outside, the same way the old ComfyUI-side pin/scale
  // graph cropped an over-large placement to the canvas before compositing.
  // Layers are drawn bottom to top (array order); only the active layer
  // gets the selection outline and draggable handles.
  function render() {
    ctx2d.clearRect(0, 0, dispW, dispH);
    layers.forEach((l, i) => drawWarpedQuad(ctx2d, l.img, layerQuads[i]));
    const quad = activeQuad();
    ctx2d.save();
    ctx2d.strokeStyle = "#8B5CF6";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    // Follows each edge's actual curve (through its midpoint control point)
    // rather than cutting straight corner-to-corner, so the outline matches
    // what's drawn underneath once an edge has been bent.
    const EDGE_STEPS = 8;
    const edges = [
      ["nw", "n", "ne"],
      ["ne", "e", "se"],
      ["se", "s", "sw"],
      ["sw", "w", "nw"],
    ];
    ctx2d.moveTo(quad.nw.x, quad.nw.y);
    for (const [from, midKey, to] of edges) {
      const mid = edgePoint(quad, midKey);
      for (let i = 1; i <= EDGE_STEPS; i++) {
        const p = quadLerp(quad[from], mid, quad[to], i / EDGE_STEPS);
        ctx2d.lineTo(p.x, p.y);
      }
    }
    ctx2d.closePath();
    ctx2d.stroke();
    ctx2d.restore();
    for (const k of QUAD_CORNERS) {
      handleEls[k].style.left = `${quad[k].x}px`;
      handleEls[k].style.top = `${quad[k].y}px`;
      if (!handleEls[k].style.cursor) handleEls[k].style.cursor = HANDLE_CURSORS[k];
    }
    const showEdges = hasEdgePoints(quad);
    for (const k of EDGE_MIDS) {
      const el = handleEls[k];
      el.style.display = showEdges ? "" : "none";
      if (!showEdges) continue;
      const p = edgePoint(quad, k);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
    // Positioned above the top edge's midpoint, offset along that edge's
    // own perpendicular (rather than always straight up) so the handle
    // still reads as "above the shape" once it's been rotated or skewed.
    const nMid = edgePoint(quad, "n");
    const topVec = { x: quad.ne.x - quad.nw.x, y: quad.ne.y - quad.nw.y };
    const len = Math.hypot(topVec.x, topVec.y) || 1;
    let perp = { x: -topVec.y / len, y: topVec.x / len };
    if (perp.y > 0) perp = { x: -perp.x, y: -perp.y };
    rotateHandleEl.style.left = `${nMid.x + perp.x * ROTATE_HANDLE_DIST}px`;
    rotateHandleEl.style.top = `${nMid.y + perp.y * ROTATE_HANDLE_DIST}px`;
  }
  function setQuad(next) {
    layerQuads[activeIndex] = next;
    render();
  }
  render();
  updateEdgePointsBtn();

  function pointerPos(evt) {
    const rect = stage.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  let drag = null; // { mode: "move" | "corner" | "edge" | "rotate", handle, start: {x,y}, startQuad, startCenter?, startAngle? }
  boxEl.addEventListener("pointerdown", (evt) => {
    const handle = evt.target.dataset.handle;
    if (!handle && !pointInQuad(pointerPos(evt), activeQuad())) return; // missed the shape entirely
    const startQuad = cloneQuad(activeQuad());
    if (handle === "rotate") {
      const startCenter = quadCenter(startQuad);
      const p = pointerPos(evt);
      drag = { mode: "rotate", start: p, startQuad, startCenter, startAngle: Math.atan2(p.y - startCenter.y, p.x - startCenter.x) };
    } else {
      const mode = !handle ? "move" : EDGE_MIDS.includes(handle) ? "edge" : "corner";
      drag = { mode, handle, start: pointerPos(evt), startQuad };
    }
    boxEl.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });
  boxEl.addEventListener("pointermove", (evt) => {
    if (!drag) {
      boxEl.style.cursor = pointInQuad(pointerPos(evt), activeQuad()) ? "move" : "default";
      return;
    }
    const p = pointerPos(evt);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.mode === "move") {
      const next = cloneQuad(drag.startQuad);
      for (const k of Object.keys(next)) {
        next[k].x += dx;
        next[k].y += dy;
      }
      setQuad(next);
      return;
    }
    if (drag.mode === "rotate") {
      // Spins every control point the quad currently has (corners and any
      // edge midpoints alike) by the same angle around the quad's center --
      // this is a rigid rotation, not a resize, so nothing else changes.
      const angle = Math.atan2(p.y - drag.startCenter.y, p.x - drag.startCenter.x) - drag.startAngle;
      const next = {};
      for (const k of Object.keys(drag.startQuad)) next[k] = rotatePoint(drag.startQuad[k], drag.startCenter, angle);
      setQuad(next);
      return;
    }
    if (drag.mode === "edge") {
      // Edge midpoints are free points like a ctrl-dragged corner: only the
      // dragged one moves, bending just that edge.
      const next = cloneQuad(drag.startQuad);
      next[drag.handle] = {
        x: clamp(edgePoint(drag.startQuad, drag.handle).x + dx, -dispW * 3, dispW * 4),
        y: clamp(edgePoint(drag.startQuad, drag.handle).y + dy, -dispH * 3, dispH * 4),
      };
      setQuad(next);
      return;
    }
    const h = drag.handle;
    // Only the dragged corner moves -- the other three stay exactly where
    // they started, same as a free-dragged edge midpoint.
    const next = cloneQuad(drag.startQuad);
    next[h] = {
      x: clamp(drag.startQuad[h].x + dx, -dispW * 3, dispW * 4),
      y: clamp(drag.startQuad[h].y + dy, -dispH * 3, dispH * 4),
    };
    setQuad(next);
  });
  boxEl.addEventListener("pointerup", () => {
    drag = null;
  });
  boxEl.addEventListener("pointercancel", () => {
    drag = null;
  });

  modal.querySelector("#sam3ModalCancelBtn").addEventListener("click", closeModal);
  modal.querySelector("#sam3ModalBackBtn").addEventListener("click", () => renderSam3PromptStep(imageId, image));
  modal.querySelector("#sam3ModalSaveBtn").addEventListener("click", async (evt) => {
    const saveBtn = evt.currentTarget;
    saveBtn.disabled = true;
    statusEl.innerHTML = `<span class="spinner"></span><span>Saving...</span>`;
    try {
      // Constrained to the server's upload size (default_max_dim) rather than
      // the base image's full native resolution -- that's what the reference
      // ends up resized to before it's sent anyway, so building it bigger
      // than that just wastes memory/upload time for no gain in fidelity.
      const maxDim = state.config?.default_max_dim || naturalWidth;
      const outScale = Math.min(maxDim / naturalWidth, maxDim / naturalHeight, 1);
      const outW = Math.round(naturalWidth * outScale);
      const outH = Math.round(naturalHeight * outScale);
      const outCanvas = document.createElement("canvas");
      outCanvas.width = outW;
      outCanvas.height = outH;
      const outCtx = outCanvas.getContext("2d");
      outCtx.drawImage(baseImg, 0, 0, outW, outH);
      // Flattened bottom to top, same as the stage preview -- the server
      // only ever sees one finished composite, never individual layers.
      layers.forEach((l, i) => {
        const quad = layerQuads[i];
        const naturalQuad = {};
        for (const k of Object.keys(quad)) naturalQuad[k] = { x: (quad[k].x / scale) * outScale, y: (quad[k].y / scale) * outScale };
        drawWarpedQuad(outCtx, l.img, naturalQuad);
      });
      const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/png"));
      const layerPrompts = layers.map((l) => l.prompt).filter(Boolean);
      const combinedPrompt = layerPrompts.join(", ");
      const savedRef = await api.setSam3Reference(imageId, { file: blob, sam3Prompt: combinedPrompt, sam3Prompts: layerPrompts });
      if (state.currentImageId === imageId) {
        state.currentImage.sam3_reference = savedRef;
        const max = maxReferenceImages();
        state.referenceImageIds = state.referenceImageIds.filter((id) => id !== savedRef.id);
        if (state.referenceImageIds.length >= max) state.referenceImageIds.length = max - 1;
        state.referenceImageIds.push(savedRef.id);
        renderReferenceImages();
      }
      closeModal();
      // The sidebar's "needs positioning" chit (renderChits) is driven by
      // list_images' unfinished_sam3_reference_id, not by anything patched
      // into state above -- refresh it so the chit clears right away instead
      // of on whatever next incidental reload happens to occur.
      loadImages();
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
      saveBtn.disabled = false;
    }
  });
}

els.sam3PlaceBtn.addEventListener("click", openSam3PlacementModal);
els.addReferenceImageBtn.addEventListener("click", openReferenceImagePicker);
els.engineSelect.addEventListener("change", updateReferenceImagesVisibility);
// The dropdown remembers the last engine picked; Settings' "Default Engine"
// is only the fallback for when nothing has been picked yet (see init()).
const ENGINE_STORAGE_KEY = "grok_img2img.engine";
els.engineSelect.addEventListener("change", () => {
  localStorage.setItem(ENGINE_STORAGE_KEY, els.engineSelect.value);
});
updateReferenceImagesVisibility();
renderReferenceImages();

// ---------------------------------------------------------------------------
// Output aspect ratio is Grok-only: it's the one engine whose API reframes the
// output itself. ComfyUI/fal.ai just return an image shaped like their input,
// so for them the framing is done up front by pre-processing the source (the
// crop button in the viewer's modebar -- see preprocess.js), for every engine.
// ---------------------------------------------------------------------------
function updateAspectRatioVisibility() {
  els.aspectRatioSelect.style.display = els.engineSelect.value === "grok" ? "" : "none";
}
els.engineSelect.addEventListener("change", updateAspectRatioVisibility);
updateAspectRatioVisibility();

// ---------------------------------------------------------------------------
// ComfyUI workflow picker. The default Flux.2 edit workflow covers most
// generations; the two SAM3 workflows are advanced alternatives that run an
// upstream object-detection/rescale pass (useful for shrinking or growing a
// specific object) and need their own prompt plus a few numeric settings --
// "sam3" scales it uniformly (scale by), "sam3_xy" scales width/height
// independently (scale X / scale Y), e.g. to stretch or squash it.
// Only shown for the comfyui engine, and only remembered per-engine like it.
// ---------------------------------------------------------------------------
const COMFY_WORKFLOW_STORAGE_KEY = "grok_img2img.comfyWorkflow";
function updateComfyWorkflowVisibility() {
  const isComfy = els.engineSelect.value === "comfyui";
  const workflow = els.comfyWorkflowSelect.value;
  els.comfyWorkflowRow.style.display = isComfy ? "flex" : "none";
  els.sam3Fields.style.display = isSam3Workflow() ? "flex" : "none";
  els.sam3ScaleByField.style.display = workflow === "sam3" ? "flex" : "none";
  els.sam3ScaleXField.style.display = workflow === "sam3_xy" ? "flex" : "none";
  els.sam3ScaleYField.style.display = workflow === "sam3_xy" ? "flex" : "none";
}
els.engineSelect.addEventListener("change", updateComfyWorkflowVisibility);
els.comfyWorkflowSelect.addEventListener("change", () => {
  localStorage.setItem(COMFY_WORKFLOW_STORAGE_KEY, els.comfyWorkflowSelect.value);
  updateComfyWorkflowVisibility();
  updateReferenceImagesVisibility();
});
const savedComfyWorkflow = localStorage.getItem(COMFY_WORKFLOW_STORAGE_KEY);
if (savedComfyWorkflow && [...els.comfyWorkflowSelect.options].some((o) => o.value === savedComfyWorkflow)) {
  els.comfyWorkflowSelect.value = savedComfyWorkflow;
}
updateComfyWorkflowVisibility();
updateReferenceImagesVisibility();

// ---------------------------------------------------------------------------
// SAM3 prompt history -- shared between the prompt panel's SAM3 Prompt field
// (els.sam3PromptInput) and the "Detect object" modal's prompt field, so
// using either one feeds the same recency list. Keeps the 5 most recently
// used prompts, most-recent first, surfaced via a <datalist> on both inputs.
// The most recent entry also pre-fills the panel's field on load, so a fresh
// session doesn't start from a blank SAM3 prompt.
// ---------------------------------------------------------------------------
const SAM3_PROMPT_HISTORY_KEY = "grok_img2img.sam3PromptHistory";
const SAM3_PROMPT_HISTORY_MAX = 5;

function getSam3PromptHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(SAM3_PROMPT_HISTORY_KEY));
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p.trim()) : [];
  } catch {
    return [];
  }
}

function rememberSam3Prompt(prompt) {
  prompt = prompt.trim();
  if (!prompt) return;
  const history = [prompt, ...getSam3PromptHistory().filter((p) => p !== prompt)].slice(0, SAM3_PROMPT_HISTORY_MAX);
  localStorage.setItem(SAM3_PROMPT_HISTORY_KEY, JSON.stringify(history));
  renderSam3PromptHistoryList();
}

function renderSam3PromptHistoryList() {
  els.sam3PromptHistoryList.innerHTML = getSam3PromptHistory()
    .map((p) => `<option value="${escapeAttr(p)}"></option>`)
    .join("");
}

renderSam3PromptHistoryList();
if (!els.sam3PromptInput.value.trim()) {
  els.sam3PromptInput.value = getSam3PromptHistory()[0] || "";
}

// Remembers the full set of prompts from the last multi-layer SAM3 batch
// submitted (any image), so opening "Detect objects" fresh offers the same
// number of layers, pre-filled with the same prompts, instead of starting
// back at a single blank row every time -- separate from the single-value
// history above, which only remembers individual prompt strings for
// autocomplete, not how many layers were last used together.
const SAM3_LAST_BATCH_KEY = "grok_img2img.sam3LastBatch";

function getSam3LastBatch() {
  try {
    const list = JSON.parse(localStorage.getItem(SAM3_LAST_BATCH_KEY));
    return Array.isArray(list) && list.length ? list.filter((p) => typeof p === "string" && p.trim()) : null;
  } catch {
    return null;
  }
}

function rememberSam3LastBatch(prompts) {
  const cleaned = prompts.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return;
  localStorage.setItem(SAM3_LAST_BATCH_KEY, JSON.stringify(cleaned));
}

// ---------------------------------------------------------------------------
// Source pre-processing (rotate / crop / pad). Only the settings are stored on
// the image -- the original file is never modified -- and the server applies
// them to what it sends to the engine. The viewer shows that processed image
// as its base, and the note under the engine picker says when it's in effect.
// ---------------------------------------------------------------------------

// Cheap change-marker for the processed image's URL, so re-applying different
// settings isn't served from the browser's cache of the previous render.
function preprocessVersion(params) {
  const s = JSON.stringify(params);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// What the viewer shows as an image's source: the processed render if there
// are pre-process settings, else the original file.
//
// An image's settings are editable, but each result records the settings it was
// actually generated with. `generatedWith` ({ resultId, params, known }) picks
// that snapshot instead of the image's current settings, so a comparison shows
// the crop that produced the result even if it's been changed since. A result
// from before snapshots were recorded (known: false) falls back to the
// image's current settings.
function sourceUrlFor(image, generatedWith = null) {
  const params = generatedWith?.known ? generatedWith.params : image.preprocess;
  if (!params) return { url: `/api/images/${image.id}/file`, processed: false };
  const version = preprocessVersion(params);
  if (generatedWith?.known && version !== preprocessVersion(image.preprocess)) {
    return { url: `/api/results/${generatedWith.resultId}/source?v=${version}`, processed: true };
  }
  return { url: `/api/images/${image.id}/processed?v=${version}`, processed: true };
}

// The generatedWith for a result on the image that owns it.
function generatedWithResult(result) {
  if (!result) return null;
  return { resultId: result.id, params: result.source_preprocess, known: result.source_preprocess_known };
}

// The generatedWith for an ancestor in derived_from.ancestors: the result its
// child image was promoted from.
function generatedWithAncestor(ancestor) {
  return { resultId: ancestor.promoted_result_id, params: ancestor.generated_preprocess, known: ancestor.generated_preprocess_known };
}

function describePreprocess(p) {
  const parts = [];
  if (p.rotation) parts.push(`rotated ${p.rotation}°`);
  parts.push(`${p.crop.w}×${p.crop.h}`);
  return parts.join(", ");
}

function renderPreprocessNote() {
  const p = state.currentImage?.preprocess;
  els.preprocessNote.style.display = p ? "flex" : "none";
  if (p) els.preprocessNoteText.textContent = `✂ Sending a pre-processed source (${describePreprocess(p)}). The original is unchanged.`;
}

// Swaps freshly-saved settings into local state (current image + sidebar list
// row) and re-renders everything that depends on them.
function applyPreprocessedImage(image) {
  if (state.currentImageId === image.id) {
    state.currentImage = image;
    renderPreprocessNote();
    syncViewer();
  }
  const listed = state.images.find((i) => i.id === image.id);
  if (listed) listed.preprocess = image.preprocess;
}

async function savePreprocess(imageId, params) {
  applyPreprocessedImage(await api.setImagePreprocess(imageId, params));
}

els.preprocessClearBtn.addEventListener("click", async () => {
  const imageId = state.currentImageId;
  if (!imageId) return;
  try {
    applyPreprocessedImage(await api.clearImagePreprocess(imageId));
  } catch (e) {
    els.generateStatus.textContent = `Error: ${e.message}`;
  }
});

// ---------------------------------------------------------------------------
// References sidebar tab -- this project's reference-image library: upload
// (with a just-in-time crop step per file), recrop later from the untouched
// original, rename via the crop title, and delete. Separate pool from the
// main image list; see the generate-panel picker above for where these get used.
// ---------------------------------------------------------------------------

function setSidebarTab(tab) {
  state.sidebarTab = tab;
  els.imagesTabBtn.classList.toggle("active", tab === "images");
  els.referencesTabBtn.classList.toggle("active", tab === "references");
  els.imagesTabPanel.style.display = tab === "images" ? "flex" : "none";
  els.referencesTabPanel.style.display = tab === "references" ? "flex" : "none";
  els.libraryMenuBtn.style.display = tab === "images" ? "" : "none";
}
els.imagesTabBtn.addEventListener("click", () => setSidebarTab("images"));
els.referencesTabBtn.addEventListener("click", () => setSidebarTab("references"));

function renderReferenceLibrary() {
  if (!state.referenceImages.length) {
    els.referenceLibraryGrid.innerHTML = `<p class="dup-section-hint">No reference images yet.</p>`;
    return;
  }
  els.referenceLibraryGrid.innerHTML = state.referenceImages
    .map(
      (ref) => `
        <div class="reference-library-item" title="${escapeHtml(ref.display_name)}">
          <img src="${refThumbUrl(ref)}" loading="lazy" data-view-ref="${ref.id}" />
          <div class="reference-library-item-actions">
            <button class="reference-library-item-btn" data-view-ref-btn="${ref.id}" title="View full size">🔍</button>
            <button class="reference-library-item-btn" data-crop-ref="${ref.id}" title="Crop">✂</button>
            <button class="reference-library-item-btn danger" data-delete-ref="${ref.id}" title="Delete">✕</button>
          </div>
          <div class="reference-library-item-name">${escapeHtml(ref.display_name)}</div>
        </div>
      `
    )
    .join("");
  els.referenceLibraryGrid.querySelectorAll("[data-view-ref], [data-view-ref-btn]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.viewRef || el.dataset.viewRefBtn;
      openReferenceLightbox(state.referenceImages.find((r) => r.id === id), id);
    });
  });
  els.referenceLibraryGrid.querySelectorAll("[data-crop-ref]").forEach((btn) => {
    btn.addEventListener("click", () => recropReferenceImage(btn.dataset.cropRef));
  });
  els.referenceLibraryGrid.querySelectorAll("[data-delete-ref]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteRef;
      const ref = state.referenceImages.find((r) => r.id === id);
      const ok = await openConfirmModal({
        title: "Move to Trash",
        message: `Move reference image "${ref ? ref.display_name : ""}" to Trash? You can restore it within 2 days.`,
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) return;
      await api.deleteReferenceImage(id);
      await loadReferenceImages();
    });
  });
}

function recropReferenceImage(id) {
  const ref = state.referenceImages.find((r) => r.id === id);
  if (!ref) return;
  openCropModal({
    title: `Crop "${ref.display_name}"`,
    imageUrl: `/api/reference-images/${id}/original`,
    naturalWidth: ref.orig_width,
    naturalHeight: ref.orig_height,
    initialBox: ref.crop_x != null ? { x: ref.crop_x, y: ref.crop_y, w: ref.crop_w, h: ref.crop_h } : null,
    onSave: async (box, blob) => {
      await api.recropReferenceImage(id, box, blob);
      await loadReferenceImages();
    },
  });
}

// Loads a File into an <img> just to read its natural pixel size for the crop
// modal -- the object URL is revoked once the modal for this file is done.
function readImageNaturalSize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

// Uploads each file in sequence, opening the crop modal for it first --
// cancelling a file's crop skips just that file rather than the whole batch.
// Returns how many files were actually uploaded, so callers with a follow-up
// side effect (e.g. deleting the file a "move" originated from) can tell a
// real upload apart from an all-cancelled batch.
async function uploadReferenceFilesWithCrop(files) {
  const fileList = Array.from(files);
  if (!fileList.length || !state.currentProjectId) return 0;
  let uploaded = 0;
  for (const file of fileList) {
    let dims;
    try {
      dims = await readImageNaturalSize(file);
    } catch {
      continue;
    }
    const displayName = (file.name || "reference").replace(/\.[^.]+$/, "");
    const cropped = await new Promise((resolve) => {
      openCropModal({
        title: `Crop "${displayName}"`,
        imageUrl: dims.url,
        naturalWidth: dims.width,
        naturalHeight: dims.height,
        initialBox: null,
        onSave: (box, blob) => resolve({ box, blob }),
        onCancel: () => resolve(null),
      });
    });
    URL.revokeObjectURL(dims.url);
    if (!cropped) continue;
    els.referenceUploadStatus.innerHTML = `<span class="spinner"></span><span>Uploading ${uploaded + 1}/${fileList.length}...</span>`;
    await api.uploadReferenceImage(state.currentProjectId, { file, displayName, cropBox: cropped.box, activeBlob: cropped.blob });
    uploaded++;
  }
  els.referenceUploadStatus.textContent = uploaded ? `Added ${uploaded} reference image(s).` : "";
  await loadReferenceImages();
  return uploaded;
}

els.referenceUploadInput.addEventListener("change", async () => {
  const files = els.referenceUploadInput.files;
  els.referenceUploadInput.value = "";
  await uploadReferenceFilesWithCrop(files);
});
["dragover", "dragleave", "drop"].forEach((evtName) => {
  els.referenceUploadDrop.addEventListener(evtName, (e) => {
    e.preventDefault();
    els.referenceUploadDrop.classList.toggle("dragover", evtName === "dragover");
  });
});
els.referenceUploadDrop.addEventListener("drop", async (e) => {
  await uploadReferenceFilesWithCrop(e.dataTransfer.files);
});

// "Use as reference" from a library image or a generated result (the 📎
// button on image rows and result tiles): fetches the already-stored file
// and feeds it through the normal upload-with-crop flow, so it lands in the
// reference library as its own independent copy -- editing or deleting it
// later never touches the source image/result it came from.
async function useAsReferenceFromUrl(url, suggestedName) {
  let blob;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(resp.statusText || "request failed");
    blob = await resp.blob();
  } catch (e) {
    els.referenceUploadStatus.textContent = `Error: could not load image (${e.message})`;
    return 0;
  }
  const file = new File([blob], `${suggestedName || "reference"}.png`, { type: blob.type || "image/png" });
  setSidebarTab("references");
  return uploadReferenceFilesWithCrop([file]);
}

// "Move to reference" from a library image (image-list row's scissors icon):
// same as useAsReferenceFromUrl, but afterward removes the original from the
// main image list -- nothing is lost (under the hood it's the same reversible
// soft-delete as any other image removal, just not framed as "Trash" here
// since from the user's side this is a relocation, not a deletion), and
// skipped entirely if the user cancels the crop step (nothing uploaded =>
// nothing removed).
async function moveImageToReference(imageId) {
  const img = state.images.find((i) => i.id === imageId);
  if (!img) return;
  const resultCount = img.result_count || 0;
  const message =
    `Move "${img.display_name}" to your reference library? It'll leave the main image list` +
    (resultCount ? `, along with its ${resultCount} result(s), ` : " ") +
    `-- nothing is deleted, and the original stays recoverable from Trash if you change your mind.`;
  const ok = await openConfirmModal({ title: "Move to References", message, confirmLabel: "Move" });
  if (!ok) return;

  const uploadedCount = await useAsReferenceFromUrl(`/api/images/${imageId}/file`, img.display_name);
  if (!uploadedCount) return; // cancelled the crop step -- leave the original alone

  await api.deleteImage(imageId);
  if (state.currentImageId === imageId) {
    state.currentImageId = null;
    state.currentImage = null;
    renderDetails();
  }
  await loadImages();
}

// Turns a result into a new source image (for re-running a prompt on
// something you just generated) and jumps to it. The new image keeps a
// provenance link back to the result/prompt it came from -- see the
// provenance line rendered in renderDetails() below.
async function promoteResultToSource(resultId) {
  let newImage;
  try {
    newImage = await api.promoteResultToSource(resultId);
  } catch (e) {
    els.generateStatus.textContent = `Error: ${e.message}`;
    return;
  }
  await loadImages();
  await selectImage(newImage.id);
}

els.generateBtn.addEventListener("click", generate);

async function generate() {
  const targetImageId = state.currentImageId;
  if (!targetImageId) return;
  const promptText = els.promptTextarea.value.trim();
  if (!promptText) {
    els.generateStatus.textContent = "Enter a prompt first.";
    return;
  }
  if (isSam3Workflow() && !els.sam3PromptInput.value.trim()) {
    els.generateStatus.textContent = "Enter a SAM3 prompt first.";
    return;
  }

  // The button only disables for the round-trip that enqueues the job — the
  // actual generation runs in the background, so it's fine to queue several
  // at once (same image or different ones). Progress and completion are
  // picked up by the queue poller below.
  els.generateBtn.disabled = true;
  try {
    await enqueueGeneration(targetImageId);
    applyQueueOrdering();
    renderImageList();
    if (state.currentImageId === targetImageId && state.currentImage) {
      renderResultGrid(
        state.currentImage.results || [],
        state.currentImage.results?.find((r) => r.is_active_result)?.id,
        targetImageId
      );
    }
    updateGenerateStatusForCurrentImage();
    renderQueueOverlay();
  } catch (e) {
    if (state.currentImageId === targetImageId) {
      els.generateStatus.textContent = `Error: ${e.message}`;
    }
  } finally {
    els.generateBtn.disabled = false;
  }
}

// Enqueues a generation job for `imageId` using the prompt/engine/aspect-ratio
// currently set in the details panel. Shared by the Generate button and
// upload-time auto-generation.
// A SAM3 placement reference (source_image_id set) belongs to exactly one
// image, but state.referenceImageIds is UI selection state that otherwise
// persists across image switches within a project (see reconcileSam3ReferenceSelection
// and referencePicksByProject) -- fine for an ordinary project-wide library
// pick, but a scoped one must never be forwarded to a *different* image's
// generation. That gap mattered specifically for enqueueGeneration calls
// where imageId isn't the currently-loaded image -- e.g. autoGenerateForImages
// firing for freshly uploaded images before any of them have been selected
// (and so before reconciliation ever ran for them) -- which could otherwise
// silently attach whatever image was open before to a brand new one.
function referenceIdsForImage(imageId) {
  return state.referenceImageIds.filter(
    (id) =>
      state.referenceImages.some((r) => r.id === id) ||
      (imageId === state.currentImageId && id === state.currentImage?.sam3_reference?.id)
  );
}

async function enqueueGeneration(imageId) {
  const promptText = els.promptTextarea.value.trim();
  const promptId = state.selectedPromptId;
  const engine = els.engineSelect.value;
  const aspectRatio = engine === "grok" ? els.aspectRatioSelect.value || null : null;
  const comfyWorkflow = engine === "comfyui" ? els.comfyWorkflowSelect.value : null;
  const isSam3 = comfyWorkflow === "sam3";
  const isSam3Xy = comfyWorkflow === "sam3_xy";
  if (isSam3 || isSam3Xy) rememberSam3Prompt(els.sam3PromptInput.value);
  const numOrUndefined = (input) => (input.value !== "" ? parseFloat(input.value) : undefined);
  const referenceIds = referenceIdsForImage(imageId);
  const job = await api.generateResult(imageId, {
    prompt_id: promptId,
    adhoc_prompt_text: promptText,
    engine,
    aspect_ratio: aspectRatio,
    reference_image_ids: referenceIds.length ? referenceIds : undefined,
    comfyui_workflow: comfyWorkflow || undefined,
    sam3_prompt: isSam3 || isSam3Xy ? els.sam3PromptInput.value.trim() : undefined,
    sam3_scale_by: isSam3 ? numOrUndefined(els.sam3ScaleByInput) : undefined,
    sam3_scale_x: isSam3Xy ? numOrUndefined(els.sam3ScaleXInput) : undefined,
    sam3_scale_y: isSam3Xy ? numOrUndefined(els.sam3ScaleYInput) : undefined,
    sam3_lr_pin: isSam3 || isSam3Xy ? numOrUndefined(els.sam3LrPinInput) : undefined,
    sam3_tb_pin: isSam3 || isSam3Xy ? numOrUndefined(els.sam3TbPinInput) : undefined,
  });
  mergeQueueJob(job);
  return job;
}

function mergeQueueJob(job) {
  const idx = state.queue.findIndex((j) => j.id === job.id);
  if (idx === -1) state.queue.push(job);
  else state.queue[idx] = job;
  speedUpQueuePolling(QUEUE_POLL_ACTIVE_MS);
}

// ---------------------------------------------------------------------------
// ComfyUI VRAM readout (topbar) — hidden whenever no ComfyUI server answers.
// Click or double-click frees its models and node cache.
// ---------------------------------------------------------------------------

let comfyFreeInFlight = false;

function formatGiB(bytes) {
  return `${(bytes / 1073741824).toFixed(1)}GiB`;
}

async function pollComfyStats() {
  if (comfyFreeInFlight) return; // don't fight the "Freeing..." label
  let res;
  try {
    res = await api.getComfyuiStats();
  } catch (e) {
    res = { ok: false };
  }
  if (!res.ok || !res.stats) {
    els.comfyStatsBtn.style.display = "none";
    return;
  }
  const { vram_free, vram_total } = res.stats;
  const usedFraction = 1 - vram_free / vram_total;
  els.comfyStatsBarFill.style.width = `${Math.round(usedFraction * 100)}%`;
  els.comfyStatsLabel.textContent = `${formatGiB(vram_total - vram_free)} / ${formatGiB(vram_total)}`;
  els.comfyStatsBtn.classList.toggle("is-high", usedFraction >= 0.85);
  els.comfyStatsBtn.style.display = "flex";
}

els.comfyStatsBtn.addEventListener("click", async () => {
  if (comfyFreeInFlight) return;
  comfyFreeInFlight = true;
  els.comfyStatsBtn.classList.add("is-busy");
  const previousLabel = els.comfyStatsLabel.textContent;
  els.comfyStatsLabel.textContent = "Freeing...";
  try {
    await api.comfyuiFree();
  } catch (e) {
    // server hiccup -- next poll tick will reflect reality
  }
  await pollComfyStats();
  if (els.comfyStatsBtn.style.display === "none") els.comfyStatsLabel.textContent = previousLabel;
  els.comfyStatsBtn.classList.remove("is-busy");
  comfyFreeInFlight = false;
});

// ---------------------------------------------------------------------------
// Background job queue (overlay + per-image status/chits)
// ---------------------------------------------------------------------------

async function pollQueue() {
  let jobs;
  try {
    jobs = await api.getQueue();
  } catch (e) {
    return; // server hiccup — try again next tick
  }
  const previousQueue = state.queue;
  state.queue = jobs;
  for (const job of jobs) {
    if (job.status === "error" && job.kind !== "sam3_cutout" && !state.failedJobs.has(job.id)) state.failedJobs.set(job.id, job);
  }

  const currentIds = new Set(jobs.map((j) => j.id));
  for (const id of handledTerminalJobIds) {
    if (!currentIds.has(id)) handledTerminalJobIds.delete(id);
  }

  let touchedCurrentImage = false;
  let anyNewlyFinished = false;
  for (const job of jobs) {
    if ((job.status === "done" || job.status === "error") && !handledTerminalJobIds.has(job.id)) {
      handledTerminalJobIds.add(job.id);
      anyNewlyFinished = true;
      if (job.image_id === state.currentImageId) touchedCurrentImage = true;
    }
  }
  // A job can also disappear from /api/queue without ever being observed in a
  // terminal state -- e.g. the tab was backgrounded and the browser throttled
  // this poll's timer, letting the backend's brief finished-job grace window
  // (jobs.FINISHED_GRACE_SECONDS) lapse between one poll and the next. Without
  // this, the sidebar chit/result-panel standby tile for that job just
  // vanishes (it's no longer "pending") while the newly-created result is
  // never fetched, leaving a permanent gap until an unrelated reload happens
  // to occur. Treat a previously active job going missing the same as
  // "finished" so the library always catches up.
  for (const job of previousQueue) {
    if ((job.status === "queued" || job.status === "running") && !currentIds.has(job.id)) {
      anyNewlyFinished = true;
      if (job.image_id === state.currentImageId) touchedCurrentImage = true;
    }
  }

  if (anyNewlyFinished) {
    await loadImages();
    if (touchedCurrentImage && state.currentImageId) {
      const targetImageId = state.currentImageId;
      const image = await api.getImage(targetImageId);
      // The user may have switched to a different image while that fetch was
      // in flight (this runs on an unprompted poll tick, not a user action) --
      // without this check, whichever fetch resolved last would win and
      // clobber state.currentImage with the wrong image's data.
      if (state.currentImageId === targetImageId) {
        state.currentImage = image;
        renderDetails();
      }
    }
  } else {
    applyQueueOrdering();
    renderImageList();
    if (state.currentImage) {
      updatePendingTiles(state.currentImageId);
      // Keeps the "detecting N more layers" button/banner state current
      // even across ticks where nothing finished yet (e.g. right after a
      // page reload mid-batch, or while a later layer is still queued
      // behind an earlier one) -- cheap since it's just re-reading
      // state.queue, not a fetch.
      if (sam3PendingLayerJobs(state.currentImageId).length || state.currentImage.sam3_reference?.needs_composite) {
        renderReferenceImages();
      }
    }
  }

  updateGenerateStatusForCurrentImage();
  renderQueueOverlay();
}

// Patches just the #pendingTiles container in the results panel, instead of
// the full renderResultGrid() rebuild, on every routine poll tick. Skips the
// DOM write entirely when the pending job set hasn't actually changed (same
// job ids, same queued-vs-running state) -- with a full rebuild, hovering a
// standby tile made its native title tooltip blink on/off every ~1.2s poll,
// since replacing innerHTML destroys and recreates the hovered element even
// when its content is identical (same root cause as the sidebar thumbnail-
// flicker fix in renderImageList() above).
function updatePendingTiles(imageId) {
  const pendingJobs = pendingJobsFor(imageId);
  const failedJobs = failedJobsFor(imageId);
  const signature = pendingTilesSignature(pendingJobs, failedJobs);
  if (imageId === lastPendingTilesImageId && signature === lastPendingTilesSignature) return;
  lastPendingTilesImageId = imageId;
  lastPendingTilesSignature = signature;

  const container = document.getElementById("pendingTiles");
  if (!container) return; // results panel isn't showing this image right now
  container.innerHTML = renderPendingTilesHtml(pendingJobs, failedJobs);
  wirePendingTileCancelButtons(container);
}

// Unconditionally re-syncs the sidebar image list and job queue from the
// server, bypassing every local-patch shortcut above -- the "did I miss an
// update?" escape hatch for whatever those shortcuts don't cover.
async function forceRefreshImages() {
  await loadImages();
  await pollQueue();
}

// Whether #generateStatus currently holds a job-progress label written below,
// so it can be cleared once those jobs finish without wiping an unrelated
// message (e.g. an attach error) on every poll tick.
let generateStatusShowsJobs = false;

function updateGenerateStatusForCurrentImage() {
  if (!state.currentImageId) return;
  const jobsForImage = state.queue.filter((j) => j.image_id === state.currentImageId);
  const activeJobs = jobsForImage.filter((j) => j.status === "queued" || j.status === "running");
  if (activeJobs.length) {
    const job = activeJobs[0];
    const label = formatJobStatus(job);
    const text = activeJobs.length > 1 ? `${activeJobs.length} generating — ${label}` : label;
    // A sam3_cutout job never gets a pending tile in the results panel (it
    // never becomes a result -- see pendingJobsFor), so this status line is
    // its only per-image cancel affordance; an ordinary generation already
    // has one on its pending tile, so this stays plain text for those rather
    // than offering a second, redundant cancel control.
    if (job.kind === "sam3_cutout" && !job.cancel_requested) {
      els.generateStatus.innerHTML = `<span>${escapeHtml(text)}</span> <button type="button" class="generate-status-cancel" id="sam3StatusCancelBtn">✕ Cancel</button>`;
      document.getElementById("sam3StatusCancelBtn").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.cancelJob(job.id);
        } catch {
          e.currentTarget.disabled = false;
        }
      });
    } else {
      els.generateStatus.textContent = text;
    }
    generateStatusShowsJobs = true;
  } else if (generateStatusShowsJobs) {
    // A failed job's error is shown on its tile in the results panel instead.
    els.generateStatus.textContent = "";
    generateStatusShowsJobs = false;
  }
}

function jobElapsedSeconds(job) {
  return Date.now() / 1000 - job.created_at;
}

// "Queued" (waiting its turn, nothing happening yet) vs "running" (actively
// generating) for display purposes. A job's top-level status is "queued"
// only for the instant between creation and its background task starting --
// in practice the state a user actually sees waiting is ComfyUI's own queue,
// which this app tracks as status "running" with phase "queued" (submitted
// to ComfyUI, not yet executing). Grok/fal have no such sub-phase, so for
// them status alone decides.
function jobIsQueued(job) {
  if (job.status === "queued") return true;
  return job.engine === "comfyui" && job.phase === "queued";
}

// Which of the three "still in the queue" visual states a job is in, for the
// sidebar chit and results-panel standby tile alike. Cancellation is
// cooperative (jobs.py sets cancel_requested and the generation thread
// notices it on its next check-in), so a job can sit with cancel_requested
// true while status is still "queued"/"running" for a moment -- that's the
// window this needs to visibly flag as "going away" rather than looking
// like ordinary progress.
function jobDisplayState(job) {
  if (job.cancel_requested) return "cancelling";
  return jobIsQueued(job) ? "queued" : "running";
}

function formatJobStatus(job) {
  if (job.status === "done") return "Done.";
  if (job.status === "cancelled") return "Cancelled.";
  if (job.status === "error") return `Error: ${job.error || ""}`;
  const elapsed = ` (${formatElapsed(jobElapsedSeconds(job))})`;
  if (job.cancel_requested) return `Cancelling...${elapsed}`;
  if (job.status === "queued") return `Queued...${elapsed}`;
  if (job.kind === "sam3_cutout") {
    switch (job.phase) {
      case "uploading":
        return `Uploading image to ComfyUI...${elapsed}`;
      case "queued":
        return `Queued on ComfyUI...${elapsed}`;
      case "saving":
        return `Finishing up...${elapsed}`;
      default:
        return `Detecting "${job.prompt_text}" with SAM3...${elapsed}`;
    }
  }
  if (job.engine === "comfyui") {
    switch (job.phase) {
      case "uploading":
        return `Uploading image to ComfyUI...${elapsed}`;
      case "queued":
        return `Queued on ComfyUI...${elapsed}`;
      case "running":
        return (job.max ? `ComfyUI: step ${job.value}/${job.max}...` : "ComfyUI is running...") + elapsed;
      case "saving":
        return `Saving result...${elapsed}`;
      default:
        return `Generating with ComfyUI...${elapsed}`;
    }
  }
  const engineLabel = { grok: "Grok", fal: "fal.ai" }[job.engine] || job.engine;
  return `Generating with ${engineLabel}...${elapsed}`;
}

function renderQueueOverlay() {
  const active = state.queue.filter((j) => j.status === "queued" || j.status === "running");
  if (!active.length) {
    els.queueOverlay.style.display = "none";
    return;
  }
  els.queueOverlay.style.display = "block";
  els.queueOverlayCount.textContent = active.length;

  const oldest = active.reduce((a, b) => (a.created_at < b.created_at ? a : b));
  els.queueOverlayElapsed.textContent = formatElapsed(jobElapsedSeconds(oldest));

  const withProgress = active.find((j) => j.phase === "running" && j.max);
  if (withProgress) {
    const pct = Math.min(100, Math.round((withProgress.value / withProgress.max) * 100));
    els.queueOverlayBar.style.width = `${pct}%`;
    els.queueOverlayBar.classList.remove("indeterminate");
  } else {
    els.queueOverlayBar.style.width = "100%";
    els.queueOverlayBar.classList.add("indeterminate");
  }

  els.queueOverlayList.style.display = state.queueExpanded ? "block" : "none";
  if (!state.queueExpanded) return;

  els.queueOverlayList.innerHTML = state.queue
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .map((job) => {
      const label = job.status === "error" ? `Error: ${escapeHtml(job.error || "")}` : formatJobStatus(job);
      // Only ComfyUI jobs can be pulled back once submitted -- grok/fal have
      // already been sent to a third-party API by this point.
      const cancellable = job.engine === "comfyui" && (job.status === "queued" || job.status === "running");
      const cancelBtn = cancellable
        ? `<button class="queue-item-cancel" data-cancel-job="${job.id}" title="Cancel this ComfyUI job">✕ Cancel</button>`
        : "";
      const promptPreview = job.prompt_text
        ? `<div class="queue-item-prompt" title="${escapeHtml(job.prompt_text)}">${escapeHtml(job.prompt_text)}</div>`
        : "";
      return `
        <div class="queue-item ${job.status}">
          <div class="queue-item-name">
            <span>${escapeHtml(job.image_name)}</span>
            <span class="queue-item-engine">${escapeHtml(job.engine)}</span>
          </div>
          ${promptPreview}
          <div class="queue-item-status">
            <span>${label}</span>
            ${cancelBtn}
          </div>
        </div>
      `;
    })
    .join("");

  els.queueOverlayList.querySelectorAll("[data-cancel-job]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "Cancelling...";
      try {
        await api.cancelJob(btn.dataset.cancelJob);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "✕ Cancel";
      }
    });
  });
}

els.queueOverlayHeader.addEventListener("click", () => {
  state.queueExpanded = !state.queueExpanded;
  renderQueueOverlay();
});

async function attachResultFile(file) {
  const targetImageId = state.currentImageId;
  if (!file || !targetImageId) return;
  const promptText = els.promptTextarea.value.trim();
  els.generateStatus.textContent = "Attaching result...";
  try {
    await api.importResult(state.currentProjectId, {
      imageId: targetImageId,
      resultFile: file,
      promptText,
      evaluation: "UNRATED",
    });
    await loadImages();
    if (state.currentImageId === targetImageId) {
      els.generateStatus.textContent = "Attached.";
      state.currentImage = await api.getImage(targetImageId);
      renderDetails();
    }
  } catch (e) {
    if (state.currentImageId === targetImageId) {
      els.generateStatus.textContent = `Error: ${e.message}`;
    }
  }
}

els.uploadResultInput.addEventListener("change", async () => {
  const file = els.uploadResultInput.files[0];
  els.uploadResultInput.value = "";
  await attachResultFile(file);
});

// Rates the current image's active result. No longer has dedicated buttons in
// the sidebar (rating now happens per-tile in the results grid), but kept for
// the y/m/n hotkeys.
async function setEvaluation(value) {
  const targetImageId = state.currentImageId;
  const results = state.currentImage?.results || [];
  const active = results.find((r) => r.is_active_result) || results[0];
  if (!active) return;
  await api.setEvaluation(active.id, value);
  await applyRatingToSidebar(targetImageId, active.id, value);
  if (state.currentImageId === targetImageId) {
    state.currentImage = await api.getImage(targetImageId);
    renderDetails();
  }
}

// ---------------------------------------------------------------------------
// Prompt palette
// ---------------------------------------------------------------------------

// A virtual dropdown in the details panel's Prompt field, built like the
// project manager panel: the button shows the picked prompt, the panel lists
// every saved prompt with edit/delete, and picking one fills the textarea.
const promptPanel = {
  open: false,
  filter: "",
  confirmDeleteId: null,
};

async function loadPrompts() {
  state.prompts = await api.listPrompts();
  // The picked prompt may have just been deleted.
  if (!state.prompts.some((p) => p.id === state.selectedPromptId)) state.selectedPromptId = null;
  renderPromptMenuButton();
  if (promptPanel.open) renderPromptPanelRows();
}

function renderPromptMenuButton() {
  const selected = state.prompts.find((p) => p.id === state.selectedPromptId);
  els.promptMenuName.textContent = selected ? selected.title : "— ad-hoc —";
  els.promptMenuName.classList.toggle("adhoc", !selected);
}

function openPromptPanel() {
  promptPanel.open = true;
  promptPanel.filter = "";
  promptPanel.confirmDeleteId = null;
  els.promptMenuBtn.setAttribute("aria-expanded", "true");
  els.promptPanel.style.display = "flex";
  els.promptPanel.innerHTML = `
    <div class="project-panel-head">
      <input id="promptFilterInput" class="project-panel-search" type="text" placeholder="Filter prompts..." autocomplete="off" />
      <button id="promptNewBtn" class="btn-ghost small" type="button">+ New</button>
    </div>
    <div class="project-panel-subhead">
      <span id="promptAllTitle" class="project-section-title"></span>
    </div>
    <div id="promptPanelList" class="project-panel-list"></div>
    <div id="promptPanelStatus" class="project-panel-status"></div>
  `;
  // The details panel scrolls, so cap the height to the room left below the button.
  const room = window.innerHeight - els.promptMenuBtn.getBoundingClientRect().bottom - 16;
  els.promptPanel.style.maxHeight = `${Math.max(240, room)}px`;
  renderPromptPanelRows();
  els.promptPanel.querySelector("#promptFilterInput").focus();
}

function closePromptPanel() {
  if (!promptPanel.open) return;
  promptPanel.open = false;
  promptPanel.confirmDeleteId = null;
  els.promptMenuBtn.setAttribute("aria-expanded", "false");
  els.promptPanel.style.display = "none";
  els.promptPanel.innerHTML = "";
}

function setPromptPanelStatus(message) {
  const el = els.promptPanel.querySelector("#promptPanelStatus");
  if (el) el.textContent = message || "";
}

// Row markup reuses the project panel's .project-row styles.
function renderPromptRow(p) {
  const cls = `project-row${p.id === state.selectedPromptId ? " current" : ""}`;

  if (promptPanel.confirmDeleteId === p.id) {
    return `
      <div class="${cls} confirming" data-prompt-id="${p.id}">
        <div class="project-row-main">
          <div class="project-row-name">Delete “${escapeHtml(p.title)}”?</div>
          <div class="project-row-desc">This cannot be undone. Results already generated with it keep their prompt text.</div>
        </div>
        <div class="project-row-actions visible">
          <button class="btn-ghost small" type="button" data-action="cancel-delete">Cancel</button>
          <button class="btn-danger small" type="button" data-action="confirm-delete">Delete</button>
        </div>
      </div>`;
  }

  return `
    <div class="${cls}" data-prompt-id="${p.id}" title="${escapeAttr(p.prompt_text)}">
      <div class="project-row-main">
        <div class="project-row-name">${escapeHtml(p.title)}</div>
        <div class="project-row-desc">${escapeHtml(p.prompt_text)}</div>
      </div>
      <div class="project-row-actions">
        <button class="project-row-btn" type="button" data-action="edit" title="Edit prompt">✎</button>
        <button class="project-row-btn danger" type="button" data-action="delete" title="Delete prompt">✕</button>
      </div>
    </div>`;
}

// Redraws just the rows, so typing in the filter keeps its focus.
function renderPromptPanelRows() {
  const listEl = els.promptPanel.querySelector("#promptPanelList");
  if (!listEl) return;

  const needle = promptPanel.filter.trim().toLowerCase();
  const matches = state.prompts.filter(
    (p) => !needle || p.title.toLowerCase().includes(needle) || p.prompt_text.toLowerCase().includes(needle)
  );

  els.promptPanel.querySelector("#promptAllTitle").textContent = needle
    ? `${matches.length} of ${plural(state.prompts.length, "prompt")}`
    : `Saved prompts (${state.prompts.length})`;

  // Ad-hoc clears the pick without touching the textarea. Not offered while
  // filtering, where it would sit above the matches.
  const adhocRow = needle
    ? ""
    : `
    <div class="project-row${state.selectedPromptId ? "" : " current"}" data-adhoc>
      <div class="project-row-main">
        <div class="project-row-name">— ad-hoc —</div>
        <div class="project-row-desc">Use the text below without a saved prompt</div>
      </div>
    </div>`;
  listEl.innerHTML =
    adhocRow +
    (matches.length
      ? matches.map(renderPromptRow).join("")
      : `<div class="empty-state">${state.prompts.length ? "No prompts match." : "No saved prompts yet."}</div>`);
}

function selectPrompt(id) {
  const prompt = state.prompts.find((p) => p.id === id);
  state.selectedPromptId = prompt ? prompt.id : null;
  if (prompt) setPromptText(prompt.prompt_text);
  renderPromptMenuButton();
  closePromptPanel();
  els.promptMenuBtn.focus();
}

async function deletePrompt(id) {
  promptPanel.confirmDeleteId = null;
  try {
    await api.deletePrompt(id);
    await loadPrompts();
  } catch (e) {
    setPromptPanelStatus(`Delete failed: ${e.message}`);
    renderPromptPanelRows();
    return;
  }
  setPromptPanelStatus("");
}

els.promptMenuBtn.addEventListener("click", () => {
  if (promptPanel.open) closePromptPanel();
  else openPromptPanel();
});

els.promptPanel.addEventListener("input", (e) => {
  if (e.target.id !== "promptFilterInput") return;
  promptPanel.filter = e.target.value;
  renderPromptPanelRows();
});

els.promptPanel.addEventListener("keydown", (e) => {
  // Enter in the filter box picks the top match.
  if (e.key !== "Enter" || e.target.id !== "promptFilterInput") return;
  const first = els.promptPanel.querySelector("#promptPanelList .project-row[data-prompt-id]");
  if (first) selectPrompt(first.dataset.promptId);
});

els.promptPanel.addEventListener("click", (e) => {
  if (e.target.id === "promptNewBtn") {
    closePromptPanel();
    openPromptModal(null);
    return;
  }
  const row = e.target.closest(".project-row");
  if (!row) return;
  const id = row.dataset.promptId;
  const action = e.target.closest("[data-action]")?.dataset.action;

  if (action === "edit") {
    const prompt = state.prompts.find((p) => p.id === id);
    closePromptPanel();
    if (prompt) openPromptModal(prompt);
  } else if (action === "delete") {
    promptPanel.confirmDeleteId = id;
    renderPromptPanelRows();
  } else if (action === "cancel-delete") {
    promptPanel.confirmDeleteId = null;
    renderPromptPanelRows();
  } else if (action === "confirm-delete") {
    deletePrompt(id);
  } else if (!row.classList.contains("confirming")) {
    selectPrompt(id);
  }
});

document.addEventListener("mousedown", (e) => {
  if (promptPanel.open && !els.promptMenu.contains(e.target)) closePromptPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !promptPanel.open) return;
  if (promptPanel.confirmDeleteId) {
    promptPanel.confirmDeleteId = null;
    renderPromptPanelRows();
  } else {
    closePromptPanel();
    els.promptMenuBtn.focus();
  }
});

// Shared New/Edit modal -- textarea sized generously (15 rows x 80 cols,
// monospace, vertically resizable) since real prompts run long.
function openPromptModal(existing) {
  const modal = openModal(`
    <h3>${existing ? "Edit Prompt" : "New Prompt"}</h3>
    <div class="field"><label>Title</label><input id="mTitle" type="text" value="${existing ? escapeAttr(existing.title) : ""}" /></div>
    <div class="field"><label>Prompt Text</label><textarea id="mText" class="prompt-edit-textarea" rows="15" cols="80">${existing ? escapeHtml(existing.prompt_text) : ""}</textarea></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Cancel</button>
      <button id="mSave" class="btn-primary">Save</button>
    </div>
  `);
  modal.querySelector("#mTitle").focus();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mSave").addEventListener("click", async () => {
    const title = modal.querySelector("#mTitle").value.trim();
    const text = modal.querySelector("#mText").value.trim();
    if (!title || !text) return;
    if (existing) {
      await api.updatePrompt(existing.id, { title, prompt_text: text });
    } else {
      await api.createPrompt(title, text);
    }
    closeModal();
    await loadPrompts();
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

els.settingsBtn.addEventListener("click", openSettingsModal);

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

els.duplicatesBtn.addEventListener("click", async () => {
  const result = await api.getDuplicates(state.currentProjectId);
  renderDuplicatesModal(result);
});

// Recommends which copy to keep by preferring the one with the most YES
// results, then the most rated (non-UNRATED) results, then the most results
// overall -- falling back to the oldest (images arrive pre-sorted by
// date_added ASC) when everything ties.
function scoreImageForKeep(img) {
  const results = img.results || [];
  const yes = results.filter((r) => r.evaluation === "YES").length;
  const rated = results.filter((r) => r.evaluation !== "UNRATED").length;
  return { yes, rated, count: results.length };
}

function pickRecommendedKeep(images) {
  let best = images[0];
  let bestScore = scoreImageForKeep(best);
  for (const img of images.slice(1)) {
    const score = scoreImageForKeep(img);
    if (
      score.yes > bestScore.yes ||
      (score.yes === bestScore.yes && score.rated > bestScore.rated) ||
      (score.yes === bestScore.yes && score.rated === bestScore.rated && score.count > bestScore.count)
    ) {
      best = img;
      bestScore = score;
    }
  }
  return best.id;
}

function renderDupResultSummary(img) {
  const results = img.results || [];
  if (!results.length) return `<span class="dup-result-summary">No results</span>`;
  const chits = results
    .map((r) => `<span class="chit ${r.evaluation}" title="${r.evaluation}"></span>`)
    .join("");
  return `<span class="dup-result-summary">${results.length} result${results.length === 1 ? "" : "s"} <span class="chit-grid">${chits}</span></span>`;
}

function renderDupGroup(group, groupKey) {
  const recommendedId = pickRecommendedKeep(group.images);
  return `
    <div class="dup-group">
      <div class="dup-group-title">${group.images.length} copies</div>
      ${group.images
        .map((img) => {
          const checked = img.id === recommendedId ? "checked" : "";
          return `
        <div class="dup-item">
          <input type="radio" name="keep-${groupKey}" class="dup-keep-radio" value="${img.id}" ${checked} title="Keep this one" />
          <img src="/api/images/${img.id}/thumbnail" loading="lazy" />
          <span class="dup-name">${escapeHtml(img.display_name)} (${img.width}×${img.height})</span>
          ${renderDupResultSummary(img)}
          <button class="btn-ghost small" data-delete-image="${img.id}">Delete</button>
        </div>
      `;
        })
        .join("")}
      <div class="dup-group-actions">
        <button class="btn-ghost small" data-merge-group="${groupKey}">Merge into selected — combines results, removes the rest</button>
      </div>
    </div>
  `;
}

function renderDuplicatesModal({ exact, possible }) {
  if (!exact.length && !possible.length) {
    const modal = openModal(`
      <h3>Duplicate Images</h3>
      <p>No duplicates found in this project.</p>
      <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
    `);
    modal.querySelector("#mCancel").addEventListener("click", closeModal);
    return;
  }

  const exactHtml = exact.length
    ? `<div class="dup-section-title">Exact duplicates (${exact.length})</div>${exact
        .map((g) => renderDupGroup(g, `exact-${g.content_hash}`))
        .join("")}`
    : "";
  const possibleHtml = possible.length
    ? `<div class="dup-section-title">Possible duplicates — same photo, different resolution (${possible.length})<br><span class="dup-section-hint">Review before deleting — these could also just be similar-looking photos.</span></div>${possible
        .map((g) => renderDupGroup(g, `possible-${g.resized_hash}`))
        .join("")}`
    : "";

  const totalGroups = exact.length + possible.length;
  const modal = openModal(`
    <h3>Duplicate Images (${totalGroups} group${totalGroups === 1 ? "" : "s"})</h3>
    <div class="dup-groups">${exactHtml}${possibleHtml}</div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelectorAll("[data-delete-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteImage;
      const ok = await openConfirmModal({
        title: "Move to Trash",
        message: "Move this image and all its results to Trash? You can restore it within 2 days.",
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) {
        renderDuplicatesModal({ exact, possible }); // confirm modal replaced this one -- restore it
        return;
      }
      await api.deleteImage(id);
      if (state.currentImageId === id) {
        state.currentImageId = null;
        state.currentImage = null;
        renderDetails();
      }
      await loadImages();
      const refreshed = await api.getDuplicates(state.currentProjectId);
      renderDuplicatesModal(refreshed);
    });
  });
  modal.querySelectorAll("[data-merge-group]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const groupKey = btn.dataset.mergeGroup;
      const radios = modal.querySelectorAll(`input[name="keep-${groupKey}"]`);
      const selected = modal.querySelector(`input[name="keep-${groupKey}"]:checked`);
      if (!selected) return;
      const keepId = selected.value;
      const removeIds = Array.from(radios).map((r) => r.value).filter((id) => id !== keepId);
      if (!removeIds.length) return;
      const ok = await openConfirmModal({
        title: "Merge Duplicates",
        message: `Merge ${removeIds.length} duplicate(s) into the selected image? Their results will be combined onto it, and the duplicate copies removed. This cannot be undone.`,
        confirmLabel: "Merge",
        danger: true,
      });
      if (!ok) {
        renderDuplicatesModal({ exact, possible }); // confirm modal replaced this one -- restore it
        return;
      }
      await api.mergeImages(keepId, removeIds);
      if (removeIds.includes(state.currentImageId)) {
        state.currentImageId = null;
        state.currentImage = null;
        renderDetails();
      }
      await loadImages();
      const refreshed = await api.getDuplicates(state.currentProjectId);
      renderDuplicatesModal(refreshed);
    });
  });
}

// ---------------------------------------------------------------------------
// Generation log
// ---------------------------------------------------------------------------

els.logsBtn.addEventListener("click", openLogModal);

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

els.trashBtn.addEventListener("click", () =>
  openTrashModal({
    projectId: state.currentProjectId,
    projectName: state.projects.find((p) => p.id === state.currentProjectId)?.name,
    onChange: onTrashChange,
  })
);

async function onTrashChange(kind) {
  if (kind === "references") return loadReferenceImages();
  if (kind === "projects") return loadProjects();
  if (kind === "results" && state.currentImageId) {
    state.currentImage = await api.getImage(state.currentImageId);
    renderDetails();
  }
  await loadImages();
}

// ---------------------------------------------------------------------------
// Export lives in Review & Export; the menu item opens it on the Review tab
// with this project selected.
// ---------------------------------------------------------------------------

els.exportLink.addEventListener("click", () => {
  els.exportLink.href = state.currentProjectId
    ? `/manage?project=${encodeURIComponent(state.currentProjectId)}&tab=review`
    : "/manage";
});

// ---------------------------------------------------------------------------
// Hotkeys & utils
// ---------------------------------------------------------------------------

// Gallery hotkeys act on the currently selected image, which sits behind
// any open modal -- without this guard, arrow keys meant for a lightbox
// would also step the background image selection underneath it.
function whenNoModal(fn) {
  return () => {
    if (els.modalOverlay.style.display === "none") fn();
  };
}
initHotkeys({
  onYes: whenNoModal(() => setEvaluation("YES")),
  onNo: whenNoModal(() => setEvaluation("NO")),
  onMaybe: whenNoModal(() => setEvaluation("MAYBE")),
  onPrev: whenNoModal(() => stepImage(-1)),
  onNext: whenNoModal(() => stepImage(1)),
  onFocusPrompt: whenNoModal(() => els.promptTextarea.focus()),
  onHelp: toggleHotkeysModal,
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  abViewer.setImages(null, null);
  // Deep link from the management page's "Open in editor": /?project=<id>&image=<id>.
  // The project goes through lastProjectId so loadProjects() falls back as usual
  // if it's gone or archived; the query is dropped so a reload doesn't reapply it.
  const deepLink = new URLSearchParams(location.search);
  if (deepLink.has("project")) {
    localStorage.setItem("lastProjectId", deepLink.get("project"));
    history.replaceState(null, "", location.pathname);
  }
  await loadProjects();
  if (deepLink.has("image") && state.currentProjectId === deepLink.get("project")) {
    await selectImage(deepLink.get("image"));
  }
  await loadPrompts();
  const config = await api.getConfig();
  state.config = config;
  const savedEngine = localStorage.getItem(ENGINE_STORAGE_KEY);
  const engineKnown = (v) => [...els.engineSelect.options].some((o) => o.value === v);
  els.engineSelect.value = engineKnown(savedEngine) ? savedEngine : config.default_engine;
  updateReferenceImagesVisibility();
  updateAspectRatioVisibility();
  updateComfyWorkflowVisibility();
  startBackgroundPolling();
})();

// Each poll is a full round trip, which adds up on a slow link, so the queue is
// polled quickly only while jobs are in flight and slowly otherwise, and both
// polls drop to a trickle while the tab is hidden. The next poll is scheduled
// only after the previous one returns, so slow responses never pile up.
// Actions that queue a job call pollQueue() themselves, so an idle interval
// doesn't delay seeing a job the user just started.
const QUEUE_POLL_ACTIVE_MS = 1200;
const QUEUE_POLL_IDLE_MS = 5000;
const COMFY_POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;

// Set by startBackgroundPolling: moves a slow (idle) queue poll forward once a
// job has just been queued, so its progress shows at the active rate.
let speedUpQueuePolling = () => {};

function startBackgroundPolling() {
  const loop = (poll, delay) => {
    let timer = null;
    let dueAt = 0;
    let inFlight = false;
    const schedule = (ms) => {
      clearTimeout(timer);
      dueAt = Date.now() + ms;
      timer = setTimeout(run, ms);
    };
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        await poll();
      } finally {
        inFlight = false;
        schedule(document.hidden ? HIDDEN_POLL_MS : delay());
      }
    };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) run(); // catch up straight away on return
    });
    run();
    return (ms) => {
      if (!inFlight && dueAt - Date.now() > ms) schedule(ms);
    };
  };
  const hasActiveJobs = () => state.queue.some((j) => j.status === "queued" || j.status === "running");
  speedUpQueuePolling = loop(pollQueue, () => (hasActiveJobs() ? QUEUE_POLL_ACTIVE_MS : QUEUE_POLL_IDLE_MS));
  loop(pollComfyStats, () => COMFY_POLL_MS);
}
