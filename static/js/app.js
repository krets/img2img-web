import { api } from "./api.js";
import { initABViewer } from "./viewer.js";
import { initHotkeys } from "./hotkeys.js";
import { initPanels } from "./panels.js";

const state = {
  projects: [],
  currentProjectId: null,
  images: [],
  currentImageId: null,
  currentImage: null, // full detail incl. results
  prompts: [],
  promptFilter: "",
  promptPaletteCollapsed: localStorage.getItem("grok_img2img.promptPaletteCollapsed") === "1",
  sort: "recent_result",
  filter: "all",
  search: "",
  queue: [], // background generation jobs, global across projects
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
  projectSwitcher: document.getElementById("projectSwitcher"),
  newProjectBtn: document.getElementById("newProjectBtn"),
  deleteProjectBtn: document.getElementById("deleteProjectBtn"),
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
  newPromptBtn: document.getElementById("newPromptBtn"),
  promptList: document.getElementById("promptList"),
  promptCount: document.getElementById("promptCount"),
  promptFilterInput: document.getElementById("promptFilterInput"),
  promptPaletteSection: document.getElementById("promptPaletteSection"),
  promptPaletteToggleBtn: document.getElementById("promptPaletteToggleBtn"),
  viewer: document.getElementById("viewer"),
  detailsEmpty: document.getElementById("detailsEmpty"),
  detailsContent: document.getElementById("detailsContent"),
  displayNameInput: document.getElementById("displayNameInput"),
  provenanceLine: document.getElementById("provenanceLine"),
  commentInput: document.getElementById("commentInput"),
  promptSelect: document.getElementById("promptSelect"),
  promptTextarea: document.getElementById("promptTextarea"),
  engineSelect: document.getElementById("engineSelect"),
  aspectRatioSelect: document.getElementById("aspectRatioSelect"),
  aspectControlsRow: document.getElementById("aspectControlsRow"),
  aspectPinGroup: document.getElementById("aspectPinGroup"),
  aspectExpandCheckbox: document.getElementById("aspectExpandCheckbox"),
  aspectExpandLabel: document.getElementById("aspectExpandLabel"),
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

// items: [{ label, danger, onClick }]. onClose (optional) fires however the
// menu closes (item picked, outside click, Escape, scroll).
function openItemMenu(anchorEl, items, { onClose } = {}) {
  closeItemMenu();
  anchorEl.classList.add("menu-open");

  const menu = document.createElement("div");
  menu.className = "item-menu";
  menu.innerHTML = items
    .map((it, i) => `<button type="button" class="item-menu-option ${it.danger ? "danger" : ""}" data-idx="${i}">${it.label}</button>`)
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

async function loadProjects() {
  state.projects = await api.listProjects();
  els.projectSwitcher.innerHTML = state.projects
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");

  const lastId = localStorage.getItem("lastProjectId");
  const match = state.projects.find((p) => p.id === lastId);
  state.currentProjectId = match ? match.id : state.projects[0]?.id || null;

  if (state.currentProjectId) {
    els.projectSwitcher.value = state.currentProjectId;
    await Promise.all([loadImages(), loadReferenceImages()]);
  }
}

els.projectSwitcher.addEventListener("change", async () => {
  state.currentProjectId = els.projectSwitcher.value;
  localStorage.setItem("lastProjectId", state.currentProjectId);
  state.currentImageId = null;
  state.currentImage = null;
  state.referenceImageIds = [];
  renderReferenceImages();
  renderDetails();
  await Promise.all([loadImages(), loadReferenceImages()]);
});

els.newProjectBtn.addEventListener("click", () => {
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
    await loadProjects();
    state.currentProjectId = project.id;
    localStorage.setItem("lastProjectId", project.id);
    els.projectSwitcher.value = project.id;
    await Promise.all([loadImages(), loadReferenceImages()]);
  };
  modal.querySelector("#mCreate").addEventListener("click", createProject);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
  });
});

els.deleteProjectBtn.addEventListener("click", async () => {
  if (!state.currentProjectId) return;
  const project = state.projects.find((p) => p.id === state.currentProjectId);
  const name = project?.name || "this project";
  const ok = await openConfirmModal({
    title: "Move to Trash",
    message: `Move "${name}" (and all of its images/results) to Trash? You can restore it within 2 days.`,
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  await api.deleteProject(state.currentProjectId);
  state.currentImageId = null;
  state.currentImage = null;
  renderDetails();
  await loadProjects();
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// Bumped on every write to state.images -- a full reload (loadImages) or a
// local patch (applyRatingToSidebar) alike. loadImages() captures this before
// its fetch and checks it again after: if a local patch (or another load)
// landed while the fetch was in flight, its response is now stale relative
// to what the user already sees, so it's discarded instead of clobbering the
// newer state. Without this, a rating applied while an unrelated loadImages()
// call (e.g. the queue poller noticing a finished job) was still in flight
// could be silently overwritten the moment that older fetch resolved --
// intermittently, since it depends on request timing.
let imagesEpoch = 0;

async function loadImages() {
  if (!state.currentProjectId) return;
  const epoch = ++imagesEpoch;
  const images = await api.listImages(state.currentProjectId, {
    sort: state.sort,
    filter: state.filter,
    search: state.search,
  });
  if (epoch !== imagesEpoch) return; // superseded by a newer load or local patch; discard
  state.images = images;
  applyQueueOrdering();
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
    const entry = (img.result_evaluations || []).find((r) => r.id === resultId);
    if (entry) entry.evaluation = value;
    if (img.active_result_id === resultId) img.active_evaluation = value;
    imagesEpoch++; // invalidate any in-flight loadImages() fetch older than this patch
    renderImageList();
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
  img.active_result_id = resultId;
  const entry = (img.result_evaluations || []).find((r) => r.id === resultId);
  if (entry) img.active_evaluation = entry.evaluation;
  imagesEpoch++;
  renderImageList();
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

function openImageItemMenu(anchorBtn, imageId) {
  const img = state.images.find((i) => i.id === imageId);
  if (!img) return;
  openItemMenu(anchorBtn, [
    { label: "📎 Copy as reference image", onClick: () => useAsReferenceFromUrl(`/api/images/${imageId}/file`, img.display_name) },
    { label: "✂ Move to reference library", onClick: () => moveImageToReference(imageId) },
    { label: "➜ Move to other library…", onClick: () => openMoveOrCopyImagesModal([imageId], "move") },
    { label: "⧉ Copy to other library…", onClick: () => openMoveOrCopyImagesModal([imageId], "copy") },
    { label: "🗑 Delete (and its results)", danger: true, onClick: () => deleteImageWithConfirm(imageId, img.display_name) },
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
    if (chitsEl) chitsEl.innerHTML = renderChits(img);
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
  await api.activateResult(resultId);
  await applyActivateResultToSidebar(imageId, resultId);
  if (state.currentImageId === imageId) {
    state.currentImage = await api.getImage(imageId);
    renderDetails();
    els.detailsContent.classList.remove("loading");
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
// per-image progress readout. A cancelled job gets no chit of its own: once
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
  const errorChits = jobsForImage
    .filter((j) => j.status === "error")
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
  if (state.currentImageId !== id) state.compareAgainstId = null;
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
  abViewer.setImages(`/api/images/${id}/file`, null);
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
    abViewer.setImages(null, null);
    return;
  }
  els.detailsEmpty.style.display = "none";
  els.detailsContent.style.display = "block";

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
  const baseUrl = `/api/images/${state.compareAgainstId || img.id}/file`;
  const resultUrl = active ? `/api/results/${active.id}/file` : null;
  abViewer.setImages(baseUrl, resultUrl);
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

  els.provenanceLine.innerHTML = `↳ Derived from a result of ${sourceLink}${promptText}${compareHtml}${lineageHtml}`;
  els.provenanceLine.style.display = "block";
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

function pendingTilesSignature(jobs) {
  return jobs.map((j) => `${j.id}:${jobDisplayState(j)}`).join(",");
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

// Marks the job cancelling in local state and re-renders its chit/tile
// immediately (unique color, no more cancel button) instead of leaving the
// click looking like it did nothing until the next ~1.2s poll happens to
// notice. Server confirmation (or a failure, which reverts the flag) still
// arrives the normal way through polling.
function wirePendingTileCancelButtons(container) {
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
  const pendingTilesHtml = `<div id="pendingTiles">${pendingJobs.map(renderPendingTileHtml).join("")}</div>`;
  lastPendingTilesImageId = imageId;
  lastPendingTilesSignature = pendingTilesSignature(pendingJobs);

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

  els.resultGrid.querySelectorAll(".result-tile").forEach((el) => {
    el.addEventListener("click", async () => {
      const targetImageId = state.currentImageId;
      const resultId = el.dataset.id;
      // Instant feedback: highlight the clicked tile and dim the panel right
      // away, rather than leaving the click looking like it did nothing while
      // activate/reload/refetch run in sequence below.
      els.resultGrid.querySelectorAll(".result-tile.active").forEach((t) => t.classList.remove("active"));
      el.classList.add("active");
      els.detailsContent.classList.add("loading");
      await api.activateResult(resultId);
      await applyActivateResultToSidebar(targetImageId, resultId);
      if (state.currentImageId === targetImageId) {
        state.currentImage = await api.getImage(targetImageId);
        renderDetails();
        els.detailsContent.classList.remove("loading");
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
          label: "📎 Use as reference image",
          onClick: () => {
            const name = state.currentImage ? `${state.currentImage.display_name} result` : "result";
            useAsReferenceFromUrl(`/api/results/${resultId}/file`, name);
          },
        },
        {
          label: "🔗 Use as new source image",
          onClick: () => promoteResultToSource(resultId),
        },
        ...(promptText
          ? [
              {
                label: "📝 Use as current prompt",
                onClick: () => useResultPromptAsCurrent(promptText),
              },
            ]
          : []),
        {
          label: "🗑 Delete result",
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
});

const savedPromptText = localStorage.getItem(PROMPT_TEXT_STORAGE_KEY);
if (savedPromptText) els.promptTextarea.value = savedPromptText;

els.promptSelect.addEventListener("change", () => {
  const prompt = state.prompts.find((p) => p.id === els.promptSelect.value);
  if (prompt) setPromptText(prompt.prompt_text);
});

// "Use as current prompt" (result tile menu): pulls a past result's actual
// prompt back into the draft textarea for re-running/tweaking. Resets the
// saved-prompt dropdown to ad-hoc, since the result's prompt text may not
// match that prompt's current saved text (or may not have come from a saved
// prompt at all).
function useResultPromptAsCurrent(promptText) {
  els.promptSelect.value = "";
  setPromptText(promptText);
}

// ---------------------------------------------------------------------------
// Reference images -- up to MAX_REFERENCE_IMAGES images picked from this
// project's reference-image library (the References sidebar tab, a separate
// pool from source images) and sent alongside the source image on generate.
// Supported by all engines (ComfyUI, Grok, and fal.ai models whose request
// shape takes an image array -- an unsupported fal model errors out at
// generate time with a message naming the model). Selection persists across
// image switches, same as the engine/aspect-ratio selects.
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
updateReferenceImagesVisibility();
renderReferenceImages();

// ---------------------------------------------------------------------------
// Aspect-ratio crop/expand controls -- only meaningful for engines that don't
// accept an aspect_ratio request param natively (ComfyUI, fal.ai). Grok
// reframes the output itself via the API's own param, so these stay hidden
// for it. "Crop" (default) cuts into the image from the pinned spot; "Expand"
// grows the canvas instead and fills the new space with a blurred copy of
// the image, pinned the same way -- see aspect_fit.py for the actual math.
// ---------------------------------------------------------------------------
function updateAspectControlsVisibility() {
  const hasAspect = !!els.aspectRatioSelect.value;
  const engine = els.engineSelect.value;
  els.aspectControlsRow.style.display = hasAspect && engine !== "grok" ? "flex" : "none";
}

function getAspectPin() {
  const active = els.aspectPinGroup.querySelector(".aspect-pin-btn.active");
  return active ? active.dataset.pin : "center";
}

els.aspectPinGroup.querySelectorAll(".aspect-pin-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.aspectPinGroup.querySelectorAll(".aspect-pin-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});
els.aspectExpandCheckbox.addEventListener("change", () => {
  els.aspectExpandLabel.classList.toggle("active", els.aspectExpandCheckbox.checked);
});
els.aspectRatioSelect.addEventListener("change", updateAspectControlsVisibility);
els.engineSelect.addEventListener("change", updateAspectControlsVisibility);
updateAspectControlsVisibility();

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
  const promptId = els.promptSelect.value || null;
  const aspectRatio = els.aspectRatioSelect.value || null;
  const engine = els.engineSelect.value;
  const job = await api.generateResult(imageId, {
    prompt_id: promptId,
    adhoc_prompt_text: promptText,
    engine,
    aspect_ratio: aspectRatio,
    aspect_mode: aspectRatio ? (els.aspectExpandCheckbox.checked ? "expand" : "crop") : null,
    aspect_pin: aspectRatio ? getAspectPin() : null,
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
      state.currentImage = await api.getImage(state.currentImageId);
      renderDetails();
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
  const signature = pendingTilesSignature(pendingJobs);
  if (imageId === lastPendingTilesImageId && signature === lastPendingTilesSignature) return;
  lastPendingTilesImageId = imageId;
  lastPendingTilesSignature = signature;

  const container = document.getElementById("pendingTiles");
  if (!container) return; // results panel isn't showing this image right now
  container.innerHTML = pendingJobs.map(renderPendingTileHtml).join("");
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

function updateGenerateStatusForCurrentImage() {
  if (!state.currentImageId) return;
  const jobsForImage = state.queue.filter((j) => j.image_id === state.currentImageId);
  const activeJobs = jobsForImage.filter((j) => j.status === "queued" || j.status === "running");
  if (activeJobs.length) {
    const label = formatJobStatus(activeJobs[0]);
    els.generateStatus.textContent = activeJobs.length > 1 ? `${activeJobs.length} generating — ${label}` : label;
    return;
  }
  const errored = jobsForImage.find((j) => j.status === "error");
  if (errored) els.generateStatus.textContent = `Error: ${errored.error || "Generation failed"}`;
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

async function loadPrompts() {
  state.prompts = await api.listPrompts();
  renderPromptList();
  renderPromptSelectOptions();
}

function renderPromptSelectOptions() {
  const previous = els.promptSelect.value;
  els.promptSelect.innerHTML =
    `<option value="">— ad-hoc —</option>` +
    state.prompts.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("");
  if (state.prompts.some((p) => p.id === previous)) els.promptSelect.value = previous;
}

function filteredPrompts() {
  const q = state.promptFilter.trim().toLowerCase();
  if (!q) return state.prompts;
  return state.prompts.filter(
    (p) => p.title.toLowerCase().includes(q) || p.prompt_text.toLowerCase().includes(q)
  );
}

function renderPromptList() {
  const filtered = filteredPrompts();
  els.promptCount.textContent =
    filtered.length === state.prompts.length ? `(${state.prompts.length})` : `(${filtered.length}/${state.prompts.length})`;

  els.promptList.innerHTML = filtered
    .map(
      (p) => `
      <div class="prompt-item" data-id="${p.id}">
        <span class="title" title="${escapeHtml(p.prompt_text)}">${escapeHtml(p.title)}</span>
        <span class="prompt-item-actions">
          <button class="prompt-item-btn edit" data-edit="${p.id}" title="Edit prompt">✎</button>
          <button class="prompt-item-btn del" data-del="${p.id}" title="Delete prompt">✕</button>
        </span>
      </div>`
    )
    .join("");

  els.promptList.querySelectorAll(".prompt-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit], [data-del]")) return;
      const prompt = state.prompts.find((p) => p.id === el.dataset.id);
      if (!prompt) return;
      els.promptSelect.value = prompt.id;
      setPromptText(prompt.prompt_text);
    });
  });
  els.promptList.querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const prompt = state.prompts.find((p) => p.id === el.dataset.edit);
      if (prompt) openPromptModal(prompt);
    });
  });
  els.promptList.querySelectorAll("[data-del]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await openConfirmModal({
        title: "Delete Prompt",
        message: "Delete this prompt? This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await api.deletePrompt(el.dataset.del);
      await loadPrompts();
    });
  });
}

function applyPromptPaletteCollapsed() {
  els.promptPaletteSection.classList.toggle("collapsed", state.promptPaletteCollapsed);
  els.promptPaletteToggleBtn.textContent = state.promptPaletteCollapsed ? "▸" : "▾";
}
els.promptPaletteToggleBtn.addEventListener("click", () => {
  state.promptPaletteCollapsed = !state.promptPaletteCollapsed;
  localStorage.setItem("grok_img2img.promptPaletteCollapsed", state.promptPaletteCollapsed ? "1" : "0");
  applyPromptPaletteCollapsed();
});
applyPromptPaletteCollapsed();

els.promptFilterInput.addEventListener("input", (e) => {
  state.promptFilter = e.target.value;
  renderPromptList();
});

// Shared New/Edit modal -- textarea sized generously (15 rows x 80 cols,
// monospace, vertically resizable) since real prompts run long.
function openPromptModal(existing) {
  const modal = openModal(`
    <h3>${existing ? "Edit Prompt" : "New Prompt"}</h3>
    <div class="field"><label>Title</label><input id="mTitle" type="text" value="${existing ? escapeHtml(existing.title) : ""}" /></div>
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

els.newPromptBtn.addEventListener("click", () => openPromptModal(null));

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
        ${config.has_api_key ? `<div class="field-hint">Current: ${config.xai_api_key}</div>` : ""}
        <input id="mKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="field"><label>Default Model</label><input id="mModel" type="text" value="${config.default_model}" /></div>
      <div class="field"><label>Default Max Dimension</label><input id="mMaxDim" type="number" value="${config.default_max_dim}" /></div>
      <div class="settings-section-actions">
        <button id="mCheck" class="btn-ghost small">Check Connection</button>
        <div id="mConnStatus" class="status-line"></div>
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
        ${config.has_fal_api_key ? `<div class="field-hint">Current: ${config.fal_api_key}</div>` : ""}
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
  modal.querySelector("#mSave").addEventListener("click", async () => {
    const falModelSelected = modal.querySelector("#mFalModel").value;
    const falModel =
      falModelSelected === FAL_MODEL_CUSTOM
        ? modal.querySelector("#mFalModelCustom").value.trim()
        : falModelSelected;
    const updated = await api.updateConfig({
      xai_api_key: modal.querySelector("#mKey").value || undefined,
      default_model: modal.querySelector("#mModel").value,
      default_max_dim: parseInt(modal.querySelector("#mMaxDim").value, 10),
      default_engine: modal.querySelector("#mEngine").value,
      comfyui_url: modal.querySelector("#mComfyUrl").value,
      comfyui_workflow_path: modal.querySelector("#mComfyWorkflow").value,
      fal_api_key: modal.querySelector("#mFalKey").value || undefined,
      fal_model: falModel,
    });
    els.engineSelect.value = updated.default_engine;
    updateReferenceImagesVisibility();
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
  els.engineSelect.value = config.default_engine;
  updateReferenceImagesVisibility();
  updateAspectControlsVisibility();
  pollQueue();
  setInterval(pollQueue, 1200);
})();
