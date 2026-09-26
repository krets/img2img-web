import { api } from "./api.js";
import { initABViewer } from "./viewer.js";
import { initHotkeys, HOTKEY_GROUPS } from "./hotkeys.js";
import { initPanels } from "./panels.js";

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
  topbarMenu: document.getElementById("topbarMenu"),
  topbarMenuBtn: document.getElementById("topbarMenuBtn"),
  topbarMenuPanel: document.getElementById("topbarMenuPanel"),
  hotkeysBtn: document.getElementById("hotkeysBtn"),
  trashBtn: document.getElementById("trashBtn"),
  exportBtn: document.getElementById("exportBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  lineageToggleBtn: document.getElementById("lineageToggleBtn"),
  filterSelect: document.getElementById("filterSelect"),
  uploadDrop: document.getElementById("uploadDrop"),
  uploadInput: document.getElementById("uploadInput"),
  autoGenOnUploadToggle: document.getElementById("autoGenOnUploadToggle"),
  uploadStatus: document.getElementById("uploadStatus"),
  cleanupNoBtn: document.getElementById("cleanupNoBtn"),
  refreshImagesBtn: document.getElementById("refreshImagesBtn"),
  imagesTabBtn: document.getElementById("imagesTabBtn"),
  referencesTabBtn: document.getElementById("referencesTabBtn"),
  imagesTabPanel: document.getElementById("imagesTabPanel"),
  referencesTabPanel: document.getElementById("referencesTabPanel"),
  referenceUploadDrop: document.getElementById("referenceUploadDrop"),
  referenceUploadInput: document.getElementById("referenceUploadInput"),
  referenceUploadStatus: document.getElementById("referenceUploadStatus"),
  referenceLibraryGrid: document.getElementById("referenceLibraryGrid"),
  duplicatesBtn: document.getElementById("duplicatesBtn"),
  logsBtn: document.getElementById("logsBtn"),
  multiSelectToggleBtn: document.getElementById("multiSelectToggleBtn"),
  multiSelectBar: document.getElementById("multiSelectBar"),
  multiSelectCount: document.getElementById("multiSelectCount"),
  multiSelectMoveBtn: document.getElementById("multiSelectMoveBtn"),
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
  preprocessNote: document.getElementById("preprocessNote"),
  preprocessNoteText: document.getElementById("preprocessNoteText"),
  preprocessClearBtn: document.getElementById("preprocessClearBtn"),
  referenceImagesField: document.getElementById("referenceImagesField"),
  referenceImageList: document.getElementById("referenceImageList"),
  addReferenceImageBtn: document.getElementById("addReferenceImageBtn"),
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

// ---------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------

// Optional one-shot callback fired by closeModal() no matter *how* the modal
// closed (button, backdrop click, Escape) -- lets a modal with async
// in-flight state (like the crop widget's batch-upload loop) always get
// notified so it doesn't hang waiting for a save that will never come.
let modalOnClose = null;

// Stack of "redraw the previous step" callbacks for multi-step modal flows
// (e.g. export filters -> report -> per-result lightbox). A step pushes a
// closure that redraws itself onto this stack right before navigating to the
// next step; modalBack() pops and calls it. Escape and backdrop-click both go
// through modalBack() rather than closeModal() directly, so backing out of a
// nested step (like a zoomed-in preview) returns to the step underneath
// instead of discarding the whole flow -- only backing out of the outermost
// step (empty stack) actually closes the modal.
let modalBackStack = [];

// { prev, next } functions set by openImageLightbox when it's given
// navigation callbacks (currently just the export report's item-by-item
// preview) -- lets the global keydown handler below move to the
// previous/next item on ArrowLeft/ArrowRight while a lightbox is open.
let lightboxNav = null;

function openModal(html) {
  els.modalContent.innerHTML = html;
  els.modalOverlay.style.display = "flex";
  return els.modalContent;
}
function closeModal() {
  els.modalOverlay.style.display = "none";
  els.modalContent.innerHTML = "";
  modalBackStack = [];
  lightboxNav = null;
  const onClose = modalOnClose;
  modalOnClose = null;
  if (onClose) onClose();
}
function modalBack() {
  lightboxNav = null;
  const step = modalBackStack.pop();
  if (step) step();
  else closeModal();
}
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) modalBack();
});
document.addEventListener("keydown", (e) => {
  if (els.modalOverlay.style.display === "none") return;
  if (e.key === "Escape") {
    modalBack();
  } else if (lightboxNav && e.key === "ArrowLeft" && lightboxNav.prev) {
    e.preventDefault();
    lightboxNav.prev();
  } else if (lightboxNav && e.key === "ArrowRight" && lightboxNav.next) {
    e.preventDefault();
    lightboxNav.next();
  }
});

// Styled stand-in for window.confirm(), matching the app's own modal chrome
// instead of the browser's native dialog. Resolves false for every dismissal
// path (Cancel, backdrop click, Escape), true only for the confirm button.
function openConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="dup-section-hint">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button id="mCancel" class="btn-ghost" type="button">${escapeHtml(cancelLabel)}</button>
        <button id="mConfirm" class="${danger ? "btn-danger" : "btn-primary"}" type="button">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    let settled = false;
    modalOnClose = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    modal.querySelector("#mCancel").addEventListener("click", closeModal); // triggers modalOnClose -> resolve(false)
    modal.querySelector("#mConfirm").addEventListener("click", () => {
      settled = true; // suppress the modalOnClose that closeModal() would otherwise fire
      closeModal();
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Item menu -- a small "more actions" popover for image-list rows and result
// tiles, triggered by a kebab (⋮) button. Rendered into document.body (not
// the row/tile itself) so it isn't clipped by the scrolling list/grid it's
// anchored to, and positioned from the trigger's own bounding rect.
// ---------------------------------------------------------------------------
let openItemMenuEl = null;
let openItemMenuCleanup = null;

function closeItemMenu() {
  if (openItemMenuEl) {
    openItemMenuEl.remove();
    openItemMenuEl = null;
  }
  if (openItemMenuCleanup) {
    openItemMenuCleanup();
    openItemMenuCleanup = null;
  }
}

// items: [{ icon, label, danger, onClick }]. onClose (optional) fires however
// the menu closes (item picked, outside click, Escape, scroll).
function openItemMenu(anchorEl, items, { onClose } = {}) {
  closeItemMenu();
  anchorEl.classList.add("menu-open");

  const menu = document.createElement("div");
  menu.className = "item-menu";
  menu.innerHTML = items
    .map((it, i) => `<button type="button" class="item-menu-option ${it.danger ? "danger" : ""}" data-idx="${i}"><span class="item-menu-icon" aria-hidden="true">${it.icon}</span><span>${it.label}</span></button>`)
    .join("");
  document.body.appendChild(menu);
  openItemMenuEl = menu;

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  left = Math.max(4, Math.min(left, window.innerWidth - menuRect.width - 4));
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll(".item-menu-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeItemMenu();
      items[Number(btn.dataset.idx)].onClick();
    });
  });

  const onDocClick = (e) => {
    if (!menu.contains(e.target)) closeItemMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeItemMenu();
  };
  const onScroll = () => closeItemMenu();
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, true);
  openItemMenuCleanup = () => {
    anchorEl.classList.remove("menu-open");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
    if (onClose) onClose();
  };
}

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

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC, with no zone marker.
function parseDbTime(ts) {
  return ts ? new Date(ts.replace(" ", "T") + "Z").getTime() : 0;
}
// 0 for a project with no results yet, so those sort below any generated one.
function projectGeneratedTime(p) {
  return parseDbTime(p.last_generated);
}
function formatRelativeTime(ms) {
  if (!ms) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
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

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

// Hamburger menu: same open/close behavior as the project panel. Opening one
// closes the other for free -- each button is "outside" the other's menu, so
// its mousedown trips the other's outside-click handler.
function isTopbarMenuOpen() {
  return els.topbarMenuPanel.style.display !== "none";
}
function setTopbarMenuOpen(open) {
  els.topbarMenuPanel.style.display = open ? "flex" : "none";
  els.topbarMenuBtn.setAttribute("aria-expanded", String(open));
}
els.topbarMenuBtn.addEventListener("click", () => setTopbarMenuOpen(!isTopbarMenuOpen()));
els.topbarMenuPanel.addEventListener("click", (e) => {
  if (e.target.closest(".topbar-menu-item")) setTopbarMenuOpen(false);
});
document.addEventListener("mousedown", (e) => {
  if (isTopbarMenuOpen() && !els.topbarMenu.contains(e.target)) setTopbarMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !isTopbarMenuOpen()) return;
  setTopbarMenuOpen(false);
  els.topbarMenuBtn.focus();
});

// Hotkeys help overlay -- content comes from HOTKEY_GROUPS in hotkeys.js.
function renderKeycaps(keys) {
  return keys
    .map((key) => key.split("+").map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join("+"))
    .join("<span>/</span>");
}
function isHotkeysModalOpen() {
  return els.modalOverlay.style.display !== "none" && !!els.modalContent.querySelector(".hotkey-groups");
}
function openHotkeysModal() {
  setTopbarMenuOpen(false);
  closeProjectPanel();
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
els.hotkeysBtn.addEventListener("click", openHotkeysModal);
// "?" toggles the overlay, but never opens over some other dialog.
function toggleHotkeysModal() {
  if (isHotkeysModalOpen()) closeModal();
  else if (els.modalOverlay.style.display === "none") openHotkeysModal();
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

function updateMultiSelectBar() {
  const count = state.selectedImageIds.size;
  els.multiSelectBar.style.display = state.multiSelectMode && count ? "contents" : "none";
  els.multiSelectCount.textContent = `${count} selected`;
}

els.multiSelectToggleBtn.addEventListener("click", () => {
  state.multiSelectMode = !state.multiSelectMode;
  state.selectedImageIds.clear();
  els.multiSelectToggleBtn.classList.toggle("active", state.multiSelectMode);
  updateMultiSelectBar();
  renderImageList();
});

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
      if (state.multiSelectMode) {
        state.selectedImageIds.clear();
        state.multiSelectMode = false;
        els.multiSelectToggleBtn.classList.remove("active");
        updateMultiSelectBar();
      }
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
// chit for each in-flight job -- dim/static while queued, pulsing while
// running, a distinct color once cancellation's been requested -- and an
// error chit for recently-failed ones, so the sidebar row doubles as a quick
// per-image progress readout. Error chits stay until the failed tile is
// dismissed in the results panel. A cancelled job gets no chit of its own: once
// the server confirms it's actually gone, it should just disappear rather
// than linger as a separate "cancelled" indicator.
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

  const chits = [...completedChits, ...pendingChits, ...errorChits];
  if (!chits.length) return `<span class="badge NONE">NEW</span>`;
  return `<div class="chit-grid">${chits.join("")}</div>`;
}

els.searchInput.addEventListener("input", debounce(() => {
  state.search = els.searchInput.value.trim();
  loadImages();
}, 250));
function syncLineageToggleBtn() {
  els.lineageToggleBtn.classList.toggle("active", state.groupByLineage);
}
syncLineageToggleBtn();
els.lineageToggleBtn.addEventListener("click", () => {
  state.groupByLineage = !state.groupByLineage;
  try {
    localStorage.setItem("grok_img2img.groupByLineage", state.groupByLineage ? "1" : "0");
  } catch {
    // preference just won't persist
  }
  syncLineageToggleBtn();
  renderImageList();
});
els.sortSelect.addEventListener("change", () => {
  state.sort = els.sortSelect.value;
  loadImages();
});
els.filterSelect.addEventListener("change", () => {
  state.filter = els.filterSelect.value;
  loadImages();
});

els.cleanupNoBtn.addEventListener("click", async () => {
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
    if (els.autoGenOnUploadToggle.checked && els.promptTextarea.value.trim()) {
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
  if (!img) {
    els.detailsEmpty.style.display = "block";
    els.detailsContent.style.display = "none";
    abViewer.setPreprocess(null);
    abViewer.setImages(null, null);
    return;
  }
  els.detailsEmpty.style.display = "none";
  els.detailsContent.style.display = "block";
  renderPreprocessNote();

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
    rawUrl: `/api/images/${img.id}/file`,
    params: img.preprocess,
    onApply: (params) => savePreprocess(img.id, params),
    onError: (message) => {
      els.generateStatus.textContent = `Error: ${message}`;
    },
  });
  abViewer.setLineage(buildLineageSteps(img, ancestors, active));
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

  els.provenanceLine.innerHTML = `↳ Derived from a result of ${sourceLink}${promptText}${compareHtml}${editHtml}${lineageHtml}`;
  els.provenanceLine.style.display = "block";
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
function pendingJobsFor(imageId) {
  return state.queue.filter((j) => j.image_id === imageId && (j.status === "queued" || j.status === "running"));
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
const MAX_REFERENCE_IMAGES = 2;

// Cache-busts the thumbnail URL whenever the crop box changes, so a recrop
// is reflected immediately instead of the browser reusing whatever it last
// fetched for that same URL -- this also doubles as a visual confirmation
// that a crop was actually saved (the thumbnail visibly updates).
function refThumbUrl(ref) {
  const crop = ref.crop_x != null ? `${ref.crop_x}-${ref.crop_y}-${ref.crop_w}-${ref.crop_h}` : "full";
  return `/api/reference-images/${ref.id}/thumbnail?v=${crop}`;
}

function updateReferenceImagesVisibility() {
  els.referenceImagesField.style.display = "flex";
}

function renderReferenceImages() {
  els.referenceImageList.innerHTML = state.referenceImageIds
    .map((id) => {
      const ref = state.referenceImages.find((r) => r.id === id);
      const label = escapeHtml(ref ? ref.display_name : "");
      return `
        <div class="reference-image-thumb" title="${label}">
          <img src="${ref ? refThumbUrl(ref) : `/api/reference-images/${id}/thumbnail`}" loading="lazy" data-view-ref="${id}" />
          <span class="reference-image-thumb-remove" data-remove-ref="${id}" title="Remove">✕</span>
        </div>
      `;
    })
    .join("");
  els.referenceImageList.querySelectorAll("[data-remove-ref]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.referenceImageIds = state.referenceImageIds.filter((id) => id !== btn.dataset.removeRef);
      renderReferenceImages();
    });
  });
  els.referenceImageList.querySelectorAll("[data-view-ref]").forEach((img) => {
    img.addEventListener("click", () => {
      const id = img.dataset.viewRef;
      const ref = state.referenceImages.find((r) => r.id === id);
      openImageLightbox(`/api/reference-images/${id}/original`, ref ? ref.display_name : "");
    });
  });
}

// Full-size view of an image (reference-image library/picker/thumb strip and
// the export report grid all open the same lightbox rather than duplicating
// zoom UI). Uses modalBack() for its dismiss action/Escape/backdrop-click, so
// when a caller has pushed a "redraw my view" step onto modalBackStack before
// opening this, backing out returns to that view instead of losing it --
// callers that open the lightbox directly (nothing pushed) get a plain
// "Close" that fully dismisses, same as before.
//
// onPrev/onNext, if given, wire both on-image chevrons and the ArrowLeft/
// ArrowRight keys (via the global keydown handler + lightboxNav) to step
// between items without leaving the lightbox -- used by the export report to
// flip through its filtered result set. Navigating does not touch
// modalBackStack, so however many items the user pages through, a single
// Back/Escape still returns straight to the grid.
function openImageLightbox(url, title, { onPrev, onNext, position } = {}) {
  const hasBack = modalBackStack.length > 0;
  const navBtns =
    onPrev || onNext
      ? `
      <button class="lightbox-nav-btn lightbox-nav-prev" id="mPrev" title="Previous (←)" ${onPrev ? "" : "disabled"}>‹</button>
      <button class="lightbox-nav-btn lightbox-nav-next" id="mNext" title="Next (→)" ${onNext ? "" : "disabled"}>›</button>
    `
      : "";
  const modal = openModal(`
    <div class="lightbox-stage">
      ${navBtns}
      <img class="lightbox-img" src="${url}" alt="${escapeHtml(title || "")}" />
    </div>
    <div class="modal-actions">
      ${position ? `<span class="lightbox-position">${escapeHtml(position)}</span>` : ""}
      <a class="btn-ghost" href="${url}" target="_blank" rel="noopener">↗ Open</a>
      <button id="mCancel" class="btn-ghost">${hasBack ? "← Back" : "Close"}</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", modalBack);
  if (onPrev) modal.querySelector("#mPrev").addEventListener("click", onPrev);
  if (onNext) modal.querySelector("#mNext").addEventListener("click", onNext);
  lightboxNav = onPrev || onNext ? { prev: onPrev, next: onNext } : null;
}

function openReferenceImagePicker() {
  if (!state.referenceImages.length) {
    const modal = openModal(`
      <h3>Add reference image</h3>
      <p class="dup-section-hint">This project has no reference images yet. Add some in the References tab first.</p>
      <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
    `);
    modal.querySelector("#mCancel").addEventListener("click", closeModal);
    return;
  }
  const modal = openModal(`
    <h3>Add reference image</h3>
    <p class="dup-section-hint">Select up to ${MAX_REFERENCE_IMAGES} images from this project's reference library.</p>
    <div class="picker-grid" id="refPickerGrid"></div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const grid = modal.querySelector("#refPickerGrid");
  grid.innerHTML = state.referenceImages
    .map((ref) => {
      const selected = state.referenceImageIds.includes(ref.id);
      const disabled = !selected && state.referenceImageIds.length >= MAX_REFERENCE_IMAGES;
      return `
        <div class="picker-item ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}" data-picker-id="${ref.id}" title="${escapeHtml(ref.display_name)}">
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
      } else if (state.referenceImageIds.length < MAX_REFERENCE_IMAGES) {
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
      const ref = state.referenceImages.find((r) => r.id === id);
      openImageLightbox(`/api/reference-images/${id}/original`, ref ? ref.display_name : "");
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
  modalOnClose = settleCancel;

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

  modal.querySelector("#cropCancelBtn").addEventListener("click", closeModal); // triggers settleCancel via modalOnClose
  modal.querySelector("#cropSaveBtn").addEventListener("click", () => {
    const natural = { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
    settled = true; // suppress the settleCancel that closeModal() would otherwise fire
    closeModal();
    onSave(natural);
  });
}

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
      const ref = state.referenceImages.find((r) => r.id === id);
      openImageLightbox(`/api/reference-images/${id}/original`, ref ? ref.display_name : "");
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
    onSave: async (box) => {
      await api.recropReferenceImage(id, box);
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
    const cropBox = await new Promise((resolve) => {
      openCropModal({
        title: `Crop "${displayName}"`,
        imageUrl: dims.url,
        naturalWidth: dims.width,
        naturalHeight: dims.height,
        initialBox: null,
        onSave: resolve,
        onCancel: () => resolve(null),
      });
    });
    URL.revokeObjectURL(dims.url);
    if (!cropBox) continue;
    els.referenceUploadStatus.innerHTML = `<span class="spinner"></span><span>Uploading ${uploaded + 1}/${fileList.length}...</span>`;
    await api.uploadReferenceImage(state.currentProjectId, { file, displayName, cropBox });
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
async function enqueueGeneration(imageId) {
  const promptText = els.promptTextarea.value.trim();
  const promptId = state.selectedPromptId;
  const engine = els.engineSelect.value;
  const aspectRatio = engine === "grok" ? els.aspectRatioSelect.value || null : null;
  const job = await api.generateResult(imageId, {
    prompt_id: promptId,
    adhoc_prompt_text: promptText,
    engine,
    aspect_ratio: aspectRatio,
    reference_image_ids: state.referenceImageIds.length ? state.referenceImageIds : undefined,
  });
  mergeQueueJob(job);
  return job;
}

function mergeQueueJob(job) {
  const idx = state.queue.findIndex((j) => j.id === job.id);
  if (idx === -1) state.queue.push(job);
  else state.queue[idx] = job;
}

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
    if (job.status === "error" && !state.failedJobs.has(job.id)) state.failedJobs.set(job.id, job);
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
    if (state.currentImage) updatePendingTiles(state.currentImageId);
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
  els.refreshImagesBtn.disabled = true;
  try {
    await loadImages();
    await pollQueue();
  } finally {
    els.refreshImagesBtn.disabled = false;
  }
}
els.refreshImagesBtn.addEventListener("click", forceRefreshImages);

// Whether #generateStatus currently holds a job-progress label written below,
// so it can be cleared once those jobs finish without wiping an unrelated
// message (e.g. an attach error) on every poll tick.
let generateStatusShowsJobs = false;

function updateGenerateStatusForCurrentImage() {
  if (!state.currentImageId) return;
  const jobsForImage = state.queue.filter((j) => j.image_id === state.currentImageId);
  const activeJobs = jobsForImage.filter((j) => j.status === "queued" || j.status === "running");
  if (activeJobs.length) {
    const label = formatJobStatus(activeJobs[0]);
    els.generateStatus.textContent = activeJobs.length > 1 ? `${activeJobs.length} generating — ${label}` : label;
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

// Models fal_client.py has an explicit MODEL_SPECS entry for (correct
// image_url/image_urls shape + the right safety-filter fields for that
// model). Anything else -- picked via "Custom model ID..." below -- falls
// back to a best-guess shape server-side that may not be exactly right.
const FAL_MODELS = [
  { value: "fal-ai/flux-pro/kontext", label: "FLUX.1 Kontext [pro] — balanced quality (default)", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-pro/kontext/max", label: "FLUX.1 Kontext [max] — best prompt adherence, pricier", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-kontext/dev", label: "FLUX.1 Kontext [dev] — cheaper/faster, open-weight", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-2/klein/4b/edit", label: "FLUX.2 [klein] 4B — fastest/cheapest FLUX.2 edit", group: "FLUX.2" },
  { value: "fal-ai/flux-2/klein/9b/edit", label: "FLUX.2 [klein] 9B — larger klein, better quality", group: "FLUX.2" },
  { value: "fal-ai/flux-2-pro/edit", label: "FLUX.2 [pro] — flagship editor, up to 9 reference images", group: "FLUX.2" },
  { value: "fal-ai/flux-2-flex/edit", label: "FLUX.2 [flex] — tunable quality/speed/cost, up to 10 references", group: "FLUX.2" },
];
const FAL_MODEL_CUSTOM = "__custom__";

// Populated on demand by the "Refresh from fal.ai" button in Settings (GET
// /api/config/fal-models). Kept in module scope, not persisted, so it
// survives closing/reopening the Settings modal within a session but a page
// reload starts back at just the curated FAL_MODELS list above.
let discoveredFalModels = [];

function isKnownFalModel(value) {
  return FAL_MODELS.some((m) => m.value === value) || discoveredFalModels.some((m) => m.value === value);
}

function renderFalModelOptions(selectedValue) {
  const groups = new Map();
  for (const m of FAL_MODELS) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const curatedValues = new Set(FAL_MODELS.map((m) => m.value));
  const discovered = discoveredFalModels.filter((m) => !curatedValues.has(m.value));
  if (discovered.length) groups.set("More from fal.ai", discovered);
  return [...groups.entries()]
    .map(
      ([group, models]) => `
        <optgroup label="${escapeHtml(group)}">
          ${models
            .map(
              (m) =>
                `<option value="${escapeHtml(m.value)}" ${selectedValue === m.value ? "selected" : ""}>${escapeHtml(m.label)}</option>`
            )
            .join("")}
        </optgroup>
      `
    )
    .join("");
}

function falModelSelectHtml(selectedValue) {
  return `
    ${renderFalModelOptions(selectedValue)}
    <option value="${FAL_MODEL_CUSTOM}" ${isKnownFalModel(selectedValue) ? "" : "selected"}>Custom model ID...</option>
  `;
}

els.settingsBtn.addEventListener("click", async () => {
  const config = await api.getConfig();
  const modal = openModal(`
    <h3>Settings</h3>
    <div class="settings-section">
      <div class="settings-section-title">Grok (xAI)</div>
      <div class="field">
        <label>API Key</label>
        <div id="mKeyHint" class="field-hint">${config.has_api_key ? `Current: ${config.xai_api_key}` : ""}</div>
        <input id="mKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="field"><label>Default Model</label><input id="mModel" type="text" value="${config.default_model}" /></div>
      <div class="field"><label>Default Max Dimension</label><input id="mMaxDim" type="number" value="${config.default_max_dim}" /></div>
      <div class="settings-section-actions">
        <button id="mCheck" class="btn-ghost small">Check Connection</button>
        <div id="mConnStatus" class="status-line"></div>
      </div>
      <div class="field">
        <label>Management Key <span class="hint">(optional; only needed to show the balance)</span></label>
        <div id="mXaiMgmtHint" class="field-hint">${config.has_xai_management_key ? `Current: ${config.xai_management_key}` : ""}</div>
        <input id="mXaiMgmtKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="settings-section-actions">
        <button id="mCheckXaiBalance" class="btn-ghost small">Check Balance</button>
        <div id="mXaiBalanceStatus" class="status-line"></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Default Engine &amp; ComfyUI</div>
      <div class="field">
        <label>Default Engine</label>
        <select id="mEngine">
          <option value="grok" ${config.default_engine === "grok" ? "selected" : ""}>Grok</option>
          <option value="comfyui" ${config.default_engine === "comfyui" ? "selected" : ""}>ComfyUI (local)</option>
          <option value="fal" ${config.default_engine === "fal" ? "selected" : ""}>fal.ai</option>
        </select>
      </div>
      <div class="field"><label>ComfyUI URL</label><input id="mComfyUrl" type="text" value="${config.comfyui_url}" /></div>
      <div class="field"><label>ComfyUI Workflow File</label><input id="mComfyWorkflow" type="text" value="${config.comfyui_workflow_path}" /></div>
      <div class="settings-section-actions">
        <button id="mCheckComfy" class="btn-ghost small">Check Connection</button>
        <button id="mComfyFree" class="btn-warn small" title="Unload models and clear ComfyUI's execution cache">⏏ Unload Models</button>
      </div>
      <div id="mComfyConnStatus" class="status-line"></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">fal.ai</div>
      <div class="field">
        <label>API Key</label>
        <div id="mFalKeyHint" class="field-hint">${config.has_fal_api_key ? `Current: ${config.fal_api_key}` : ""}</div>
        <input id="mFalKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="field">
        <label>Model</label>
        <div class="fal-model-row">
          <select id="mFalModel">
            ${falModelSelectHtml(config.fal_model)}
          </select>
          <button id="mFalModelRefresh" class="btn-ghost small" type="button">Refresh from fal.ai</button>
        </div>
        <input
          id="mFalModelCustom"
          type="text"
          placeholder="e.g. fal-ai/your-model-id"
          style="display:${isKnownFalModel(config.fal_model) ? "none" : "block"}; margin-top:6px;"
          value="${isKnownFalModel(config.fal_model) ? "" : escapeHtml(config.fal_model || "")}"
        />
        <div id="mFalModelsStatus" class="status-line"></div>
      </div>
      <div class="settings-section-actions">
        <button id="mCheckFal" class="btn-ghost small">Check Connection</button>
        <div id="mFalConnStatus" class="status-line"></div>
      </div>
      <div class="settings-section-actions">
        <button id="mCheckFalBalance" class="btn-ghost small" title="Showing the balance needs an ADMIN-scope API key">Check Balance</button>
        <div id="mFalBalanceStatus" class="status-line"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Close</button>
      <button id="mSave" class="btn-primary">Save</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mFalModel").addEventListener("change", (e) => {
    modal.querySelector("#mFalModelCustom").style.display = e.target.value === FAL_MODEL_CUSTOM ? "block" : "none";
  });
  modal.querySelector("#mFalModelRefresh").addEventListener("click", async () => {
    const select = modal.querySelector("#mFalModel");
    const statusEl = modal.querySelector("#mFalModelsStatus");
    const refreshBtn = modal.querySelector("#mFalModelRefresh");
    const previousValue = select.value === FAL_MODEL_CUSTOM ? modal.querySelector("#mFalModelCustom").value.trim() : select.value;
    refreshBtn.disabled = true;
    statusEl.textContent = "Fetching edit models from fal.ai...";
    try {
      const res = await api.getFalModels();
      discoveredFalModels = res.models;
      select.innerHTML = falModelSelectHtml(previousValue);
      modal.querySelector("#mFalModelCustom").style.display = isKnownFalModel(previousValue) ? "none" : "block";
      statusEl.textContent = `Found ${discoveredFalModels.length} edit model(s) from fal.ai.`;
    } catch (e) {
      statusEl.textContent = `Refresh failed: ${e.message}`;
    } finally {
      refreshBtn.disabled = false;
    }
  });
  modal.querySelector("#mCheck").addEventListener("click", async () => {
    modal.querySelector("#mConnStatus").textContent = "Checking...";
    const res = await api.checkConnection();
    modal.querySelector("#mConnStatus").textContent = res.message;
  });
  modal.querySelector("#mCheckComfy").addEventListener("click", async () => {
    modal.querySelector("#mComfyConnStatus").textContent = "Checking...";
    const res = await api.checkComfyuiConnection();
    modal.querySelector("#mComfyConnStatus").textContent = res.message;
  });
  modal.querySelector("#mComfyFree").addEventListener("click", async () => {
    modal.querySelector("#mComfyConnStatus").textContent = "Unloading models and freeing cache...";
    const res = await api.comfyuiFree();
    modal.querySelector("#mComfyConnStatus").textContent = res.message;
  });
  modal.querySelector("#mCheckFal").addEventListener("click", async () => {
    modal.querySelector("#mFalConnStatus").textContent = "Checking...";
    const res = await api.checkFalConnection();
    modal.querySelector("#mFalConnStatus").textContent = res.message;
  });
  const balanceEls = {
    grok: modal.querySelector("#mXaiBalanceStatus"),
    fal: modal.querySelector("#mFalBalanceStatus"),
  };
  const showBalance = (provider, res) => {
    balanceEls[provider].textContent = res.ok ? `Balance: $${res.balance.toFixed(2)}` : res.message;
  };
  // Persists any keys typed into the modal first, so a key entered just now is
  // used without having to Save and reopen Settings.
  const checkBalance = async (provider) => {
    balanceEls[provider].textContent = "Checking...";
    try {
      const updated = await api.updateConfig({
        xai_api_key: modal.querySelector("#mKey").value || undefined,
        xai_management_key: modal.querySelector("#mXaiMgmtKey").value || undefined,
        fal_api_key: modal.querySelector("#mFalKey").value || undefined,
      });
      for (const [inputId, hintId, has, masked] of [
        ["#mKey", "#mKeyHint", updated.has_api_key, updated.xai_api_key],
        ["#mXaiMgmtKey", "#mXaiMgmtHint", updated.has_xai_management_key, updated.xai_management_key],
        ["#mFalKey", "#mFalKeyHint", updated.has_fal_api_key, updated.fal_api_key],
      ]) {
        modal.querySelector(inputId).value = "";
        modal.querySelector(hintId).textContent = has ? `Current: ${masked}` : "";
      }
      showBalance(provider, (await api.getBalances())[provider]);
    } catch (e) {
      balanceEls[provider].textContent = `Balance check failed: ${e.message}`;
    }
  };
  modal.querySelector("#mCheckXaiBalance").addEventListener("click", () => checkBalance("grok"));
  modal.querySelector("#mCheckFalBalance").addEventListener("click", () => checkBalance("fal"));
  const grokBalanceConfigured = config.has_api_key && config.has_xai_management_key;
  if (grokBalanceConfigured || config.has_fal_api_key) {
    if (grokBalanceConfigured) balanceEls.grok.textContent = "Loading balance...";
    if (config.has_fal_api_key) balanceEls.fal.textContent = "Loading balance...";
    api
      .getBalances()
      .then((res) => {
        if (grokBalanceConfigured) showBalance("grok", res.grok);
        if (config.has_fal_api_key) showBalance("fal", res.fal);
      })
      .catch((e) => {
        for (const el of Object.values(balanceEls)) if (el.textContent === "Loading balance...") el.textContent = `Balance unavailable: ${e.message}`;
      });
  }
  modal.querySelector("#mSave").addEventListener("click", async () => {
    const falModelSelected = modal.querySelector("#mFalModel").value;
    const falModel =
      falModelSelected === FAL_MODEL_CUSTOM
        ? modal.querySelector("#mFalModelCustom").value.trim()
        : falModelSelected;
    await api.updateConfig({
      xai_api_key: modal.querySelector("#mKey").value || undefined,
      default_model: modal.querySelector("#mModel").value,
      default_max_dim: parseInt(modal.querySelector("#mMaxDim").value, 10),
      default_engine: modal.querySelector("#mEngine").value,
      comfyui_url: modal.querySelector("#mComfyUrl").value,
      comfyui_workflow_path: modal.querySelector("#mComfyWorkflow").value,
      fal_api_key: modal.querySelector("#mFalKey").value || undefined,
      fal_model: falModel,
      xai_management_key: modal.querySelector("#mXaiMgmtKey").value || undefined,
    });
    closeModal();
  });
});

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

// Ring buffer of finished (done/error) jobs kept server-side -- see jobs.py.
// Unlike the queue overlay's per-image chits (which vanish ~10s after a job
// finishes), this survives long enough to review failures you weren't
// watching for live. It's still in-memory only, so it resets on server restart.
els.logsBtn.addEventListener("click", async () => {
  const log = await api.getQueueLog();
  renderLogModal(log);
});

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

els.trashBtn.addEventListener("click", renderTrashModal);

async function renderTrashModal(statusMessage = "") {
  const [rawProjectTrash, trashedProjects] = await Promise.all([
    state.currentProjectId ? api.getProjectTrash(state.currentProjectId) : Promise.resolve({}),
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
  const currentProjectName = state.projects.find((p) => p.id === state.currentProjectId)?.name || "this project";

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
      <div class="panel-header">
        <span>${escapeHtml(currentProjectName)} — Images</span>
        <button id="mTrashNo" class="btn-ghost small">Trash all NO results</button>
      </div>
      <div class="trash-list">${imagesHtml}</div>
      <div class="panel-header"><span>${escapeHtml(currentProjectName)} — Results</span></div>
      <div class="trash-list">${resultsHtml}</div>
      <div class="panel-header"><span>${escapeHtml(currentProjectName)} — References</span></div>
      <div class="trash-list">${referencesHtml}</div>
      <div class="panel-header"><span>Trashed Projects</span></div>
      <div class="trash-list">${projectsHtml}</div>
    </div>
    <div id="mTrashStatus" class="status-line">${escapeHtml(statusMessage)}</div>
    <div class="modal-actions"><button id="mCancel" class="btn-ghost">Close</button></div>
  `);

  modal.querySelector("#mCancel").addEventListener("click", closeModal);

  modal.querySelector("#mTrashNo").addEventListener("click", async () => {
    if (!state.currentProjectId) return;
    const { trashed } = await api.trashNoResults(state.currentProjectId);
    await loadImages();
    await renderTrashModal(`Trashed ${trashed.length} NO-rated result(s).`);
  });

  modal.querySelectorAll("[data-restore-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.restoreImage(btn.dataset.restoreImage);
      await loadImages();
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
      const resultId = btn.dataset.restoreResult;
      await api.restoreResult(resultId);
      if (state.currentImageId) {
        state.currentImage = await api.getImage(state.currentImageId);
        renderDetails();
      }
      await loadImages();
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
      await loadReferenceImages();
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
      await loadProjects();
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const STATUS_FILTER_LABELS = { YES: "Approved (YES)", ALL: "All evaluated", MAYBE: "Maybe", NO: "Rejected" };
const EXPORT_MODE_LABELS = { clean: "Clean (result images only)", side_by_side: "Side-by-Side (A/B pairs)" };

els.exportBtn.addEventListener("click", () => {
  modalBackStack = []; // fresh flow -- Escape/backdrop from the filter step should fully close
  showExportFilter();
});

function showExportFilter(statusFilter = "YES", mode = "clean") {
  const modal = openModal(`
    <h3>Export Results</h3>
    <div class="field">
      <label>Status Filter</label>
      <select id="mStatus">
        ${Object.entries(STATUS_FILTER_LABELS)
          .map(([v, label]) => `<option value="${v}" ${v === statusFilter ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
    </div>
    <div class="field">
      <label>Format</label>
      <select id="mMode">
        ${Object.entries(EXPORT_MODE_LABELS)
          .map(([v, label]) => `<option value="${v}" ${v === mode ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
    </div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Cancel</button>
      <button id="mGo" class="btn-primary">Generate Report</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", modalBack);
  modal.querySelector("#mGo").addEventListener("click", () => {
    const sf = modal.querySelector("#mStatus").value;
    const md = modal.querySelector("#mMode").value;
    modalBackStack.push(() => showExportFilter(sf, md));
    showExportReport(sf, md);
  });
}

// Scrollable preview of exactly what the chosen filters will export, with the
// actual zip download available right from the report -- so the user can
// eyeball the result set before committing to (potentially large) export. In
// side_by_side mode, both the grid thumbnails and the per-item lightbox show
// the actual source+result composite the zip will contain, not just the bare
// result -- otherwise "preview" wouldn't show what side-by-side mode does.
async function showExportReport(statusFilter, mode) {
  const modal = openModal(`<h3>Export Report</h3><p class="dup-section-hint">Loading…</p>`);
  let results = [];
  try {
    results = await api.previewExport(state.currentProjectId, statusFilter);
  } catch (e) {
    modal.innerHTML = `<h3>Export Report</h3><p class="dup-section-hint">Error: ${escapeHtml(e.message)}</p>`;
    return;
  }
  renderExportReportBody(statusFilter, mode, results);
}

// Opens the lightbox on results[index], wired with wraparound prev/next so
// arrow keys/chevrons page through the whole filtered set (see the report's
// data-view-result click handler and openImageLightbox's onPrev/onNext).
function showResultLightbox(statusFilter, mode, results, index) {
  const r = results[index];
  const isSbs = mode === "side_by_side";
  const url = isSbs ? `/api/results/${r.id}/side-by-side` : `/api/results/${r.id}/file`;
  const wrap = (i) => (i + results.length) % results.length;
  openImageLightbox(url, r.image_display_name, {
    onPrev: results.length > 1 ? () => showResultLightbox(statusFilter, mode, results, wrap(index - 1)) : undefined,
    onNext: results.length > 1 ? () => showResultLightbox(statusFilter, mode, results, wrap(index + 1)) : undefined,
    position: results.length > 1 ? `${index + 1} / ${results.length}` : undefined,
  });
}

// (Re)draws the report's body -- grid + actions -- into the modal container.
// Split out from showExportReport so that backing out of the per-result
// lightbox (which takes over the whole modal body) can redraw the
// already-fetched result set instead of refetching it.
function renderExportReportBody(statusFilter, mode, results) {
  const modal = els.modalContent;
  const isSbs = mode === "side_by_side";
  const previewUrl = (id) => (isSbs ? `/api/results/${id}/side-by-side` : `/api/results/${id}/thumbnail`);
  const itemsHtml = results.length
    ? results
        .map((r) => {
          const label = `${escapeHtml(r.image_display_name)} — ${r.evaluation} — ${new Date(r.date_generated).toLocaleString()}`;
          return `
            <div class="report-item ${r.evaluation}" data-view-result="${r.id}" title="${label}">
              <img src="${previewUrl(r.id)}" loading="lazy" />
              <div class="report-item-name">${escapeHtml(r.image_display_name)}</div>
            </div>
          `;
        })
        .join("")
    : `<p class="dup-section-hint">No results match this filter.</p>`;

  modal.innerHTML = `
    <h3>Export Report</h3>
    <div class="report-header">
      <span class="report-count">${results.length} result${results.length === 1 ? "" : "s"} — ${STATUS_FILTER_LABELS[statusFilter]} — ${EXPORT_MODE_LABELS[mode]}</span>
    </div>
    <div class="report-grid ${isSbs ? "sbs" : ""}">${itemsHtml}</div>
    <div id="mExportStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mBack" class="btn-ghost">← Back</button>
      <button id="mGo" class="btn-primary" ${results.length ? "" : "disabled"}>${results.length ? `Export ZIP (${results.length})` : "Export ZIP"}</button>
    </div>
  `;

  modal.querySelector("#mBack").addEventListener("click", modalBack);
  modal.querySelectorAll("[data-view-result]").forEach((el) => {
    el.addEventListener("click", () => {
      const index = results.findIndex((x) => x.id === el.dataset.viewResult);
      modalBackStack.push(() => renderExportReportBody(statusFilter, mode, results));
      showResultLightbox(statusFilter, mode, results, index);
    });
  });
  modal.querySelector("#mGo").addEventListener("click", async () => {
    modal.querySelector("#mExportStatus").textContent = "Building export...";
    try {
      const res = await fetch(`/api/projects/${state.currentProjectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status_filter: statusFilter, mode }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : "export.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      modal.querySelector("#mExportStatus").textContent = "Export downloaded.";
    } catch (e) {
      modal.querySelector("#mExportStatus").textContent = `Error: ${e.message}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Hotkeys & utils
// ---------------------------------------------------------------------------

// Gallery hotkeys act on the currently selected image, which sits behind
// any open modal -- without this guard, arrow keys meant for a lightbox
// (e.g. paging through the export report) would also step the background
// image selection underneath it.
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

// Formats a duration in seconds as e.g. "45s", "3m 12s", "1h 05m". Used both
// for live elapsed time (queue/job in progress) and total generation time
// stored on finished results.
function formatElapsed(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  if (m < 60) return `${m}m ${String(remSec).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return `${h}h ${String(remMin).padStart(2, "0")}m`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
// For values inside a quoted HTML attribute, where escapeHtml alone leaves `"` intact.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  abViewer.setImages(null, null);
  await loadProjects();
  await loadPrompts();
  const config = await api.getConfig();
  const savedEngine = localStorage.getItem(ENGINE_STORAGE_KEY);
  const engineKnown = (v) => [...els.engineSelect.options].some((o) => o.value === v);
  els.engineSelect.value = engineKnown(savedEngine) ? savedEngine : config.default_engine;
  updateReferenceImagesVisibility();
  updateAspectRatioVisibility();
  pollQueue();
  setInterval(pollQueue, 1200);
})();
