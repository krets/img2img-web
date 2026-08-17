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
};

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
  filterSelect: document.getElementById("filterSelect"),
  uploadDrop: document.getElementById("uploadDrop"),
  uploadInput: document.getElementById("uploadInput"),
  autoGenOnUploadToggle: document.getElementById("autoGenOnUploadToggle"),
  uploadStatus: document.getElementById("uploadStatus"),
  cleanupNoBtn: document.getElementById("cleanupNoBtn"),
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

function openModal(html) {
  els.modalContent.innerHTML = html;
  els.modalOverlay.style.display = "flex";
  return els.modalContent;
}
function closeModal() {
  els.modalOverlay.style.display = "none";
  els.modalContent.innerHTML = "";
  const onClose = modalOnClose;
  modalOnClose = null;
  if (onClose) onClose();
}
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.modalOverlay.style.display !== "none") closeModal();
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
  modal.querySelector("#mName").focus();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mCreate").addEventListener("click", async () => {
    const name = modal.querySelector("#mName").value.trim();
    if (!name) return;
    const description = modal.querySelector("#mDesc").value.trim();
    const project = await api.createProject(name, description);
    closeModal();
    await loadProjects();
    state.currentProjectId = project.id;
    localStorage.setItem("lastProjectId", project.id);
    els.projectSwitcher.value = project.id;
    await Promise.all([loadImages(), loadReferenceImages()]);
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

async function loadImages() {
  if (!state.currentProjectId) return;
  state.images = await api.listImages(state.currentProjectId, {
    sort: state.sort,
    filter: state.filter,
    search: state.search,
  });
  applyQueueOrdering();
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

function renderImageItemHtml(img) {
  const selected = img.id === state.currentImageId ? "selected" : "";
  const checked = state.selectedImageIds.has(img.id) ? "checked" : "";
  const checkbox = state.multiSelectMode
    ? `<input type="checkbox" class="image-item-check" data-id="${img.id}" ${checked} />`
    : "";
  return `
    <div class="image-item ${selected}" data-id="${img.id}">
      ${checkbox}
      <img src="/api/images/${img.id}/thumbnail" loading="lazy" />
      <div class="meta">
        <div class="name">${escapeHtml(img.display_name)}</div>
      </div>
      <span class="chits-slot">${renderChits(img)}</span>
      <button class="image-item-ref-btn" data-use-ref-image="${img.id}" title="Copy as reference image">📎</button>
      <button class="image-item-ref-btn" data-move-ref-image="${img.id}" title="Move to reference library">✂</button>
    </div>
  `;
}

// Single delegated listener, bound once -- lets renderImageList() patch
// existing rows in place (see below) without having to re-attach handlers
// on every poll tick.
let imageListHandlersBound = false;
function bindImageListDelegation() {
  if (imageListHandlersBound) return;
  imageListHandlersBound = true;
  els.imageList.addEventListener("click", (e) => {
    const useRefBtn = e.target.closest("[data-use-ref-image]");
    if (useRefBtn) {
      e.stopPropagation();
      const img = state.images.find((i) => i.id === useRefBtn.dataset.useRefImage);
      if (img) useAsReferenceFromUrl(`/api/images/${img.id}/file`, img.display_name);
      return;
    }
    const moveRefBtn = e.target.closest("[data-move-ref-image]");
    if (moveRefBtn) {
      e.stopPropagation();
      moveImageToReference(moveRefBtn.dataset.moveRefImage);
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
  const ids = state.images.map((img) => img.id);
  const signature = `${state.multiSelectMode}|${ids.join(",")}`;

  if (signature !== lastImageListSignature) {
    els.imageList.innerHTML = state.images.map(renderImageItemHtml).join("");
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
  await api.activateResult(resultId);
  await loadImages();
  if (state.currentImageId === imageId) {
    state.currentImage = await api.getImage(imageId);
    renderDetails();
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

els.multiSelectMoveBtn.addEventListener("click", () => {
  const otherProjects = state.projects.filter((p) => p.id !== state.currentProjectId);
  const modal = openModal(`
    <h3>Move ${state.selectedImageIds.size} image(s)</h3>
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
      <button id="mGo" class="btn-primary">Move</button>
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
    statusEl.textContent = "Moving...";
    try {
      await api.moveImages(Array.from(state.selectedImageIds), targetProjectId);
      closeModal();
      if (state.currentImage && state.selectedImageIds.has(state.currentImageId)) {
        state.currentImageId = null;
        state.currentImage = null;
        renderDetails();
      }
      state.selectedImageIds.clear();
      state.multiSelectMode = false;
      els.multiSelectToggleBtn.classList.remove("active");
      updateMultiSelectBar();
      await loadProjects();
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  });
});

// Chit grid: one chit per completed result (colored by evaluation), plus a
// pulsing chit for each in-flight job and an error chit for recently-failed
// ones, so the sidebar row doubles as a quick per-image progress readout.
function renderChits(img) {
  const completedChits = (img.result_evaluations || []).map(
    (r) => `<span class="chit ${r.evaluation}" data-result-id="${r.id}" title="${r.evaluation}"></span>`
  );
  const jobsForImage = state.queue.filter((j) => j.image_id === img.id);
  const pendingChits = jobsForImage
    .filter((j) => j.status === "queued" || j.status === "running")
    .map((j) => `<span class="chit pending" title="Generating... (${formatElapsed(jobElapsedSeconds(j))})"></span>`);
  const errorChits = jobsForImage
    .filter((j) => j.status === "error")
    .map((j) => `<span class="chit error" title="${escapeHtml(j.error || "Generation failed")}"></span>`);
  const cancelledChits = jobsForImage
    .filter((j) => j.status === "cancelled")
    .map(() => `<span class="chit cancelled" title="Cancelled"></span>`);

  const chits = [...completedChits, ...pendingChits, ...errorChits, ...cancelledChits];
  if (!chits.length) return `<span class="badge NONE">NEW</span>`;
  return `<div class="chit-grid">${chits.join("")}</div>`;
}

els.searchInput.addEventListener("input", debounce(() => {
  state.search = els.searchInput.value.trim();
  loadImages();
}, 250));
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
  state.currentImageId = id;
  els.generateStatus.textContent = "";
  updateGenerateStatusForCurrentImage();
  // The source image only depends on `id`, not on the metadata fetch below --
  // kick off its (progressive) load right away instead of making the viewer
  // wait on a network round-trip it doesn't need. renderDetails() below will
  // fill in the result image once metadata resolves.
  abViewer.setImages(`/api/images/${id}/file`, null);
  const image = await api.getImage(id);
  if (state.currentImageId !== id) return; // user navigated away before this resolved
  state.currentImage = image;
  renderImageList();
  renderDetails();
}

function stepImage(direction) {
  const ids = state.images.map((i) => i.id);
  const idx = ids.indexOf(state.currentImageId);
  if (idx === -1) {
    if (ids.length) selectImage(ids[0]);
    return;
  }
  const nextIdx = (idx + direction + ids.length) % ids.length;
  selectImage(ids[nextIdx]);
}

els.deleteImageBtn.addEventListener("click", async () => {
  const targetImageId = state.currentImageId;
  if (!targetImageId) return;
  const name = state.currentImage?.display_name || "this image";
  const ok = await openConfirmModal({
    title: "Move to Trash",
    message: `Move "${name}" and all of its results to Trash? You can restore it within 2 days.`,
    confirmLabel: "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  await api.deleteImage(targetImageId);
  if (state.currentImageId === targetImageId) {
    state.currentImageId = null;
    state.currentImage = null;
    renderDetails();
  }
  await loadImages();
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

  renderResultGrid(results, active?.id);

  const sourceUrl = `/api/images/${img.id}/file`;
  const resultUrl = active ? `/api/results/${active.id}/file` : null;
  abViewer.setImages(sourceUrl, resultUrl);

  const revisedPromptText = active?.revised_prompt ? `Grok revised prompt: "${active.revised_prompt}"` : "";
  const durationText = active?.duration_seconds ? `Generated in ${formatElapsed(active.duration_seconds)}` : "";
  els.revisedPrompt.textContent = [revisedPromptText, durationText].filter(Boolean).join(" — ");
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
  els.provenanceLine.innerHTML = `↳ Derived from a result of ${sourceLink}${promptText}`;
  els.provenanceLine.style.display = "block";
  const link = els.provenanceLine.querySelector("[data-jump-to-image]");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      selectImage(link.dataset.jumpToImage);
    });
  }
}

// Renders the results grid, followed by a dashed upload-dropzone card pinned
// as the last item (secondary to the actual results, which stay newest-first).
// Each result tile carries three hover-revealed corners: a copy-prompt icon
// (top-left), delete (top-right), and thumbs-down/neutral/thumbs-up rating
// controls (bottom-right; the tile's border color already shows the current
// rating) -- so rating and pruning results no longer needs the old dedicated
// sidebar buttons.
function renderResultGrid(results, activeId) {
  const uploadCardHtml = `
    <div class="result-upload-card" id="resultUploadCard" title="Upload a result image">
      <span class="result-upload-card-icon">+</span>
      <span class="result-upload-card-label">Upload</span>
    </div>
  `;

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
          <button class="result-tile-reference" data-use-ref-result="${r.id}" title="Use as reference image">📎</button>
          <button class="result-tile-promote" data-promote-result="${r.id}" title="Use as new source image (keeps a link back to this result)">🔗</button>
          ${copyBtn}
          <button class="result-tile-delete" data-delete-result="${r.id}" title="Delete result">✕</button>
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

  els.resultGrid.innerHTML = tilesHtml + uploadCardHtml;

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
      await api.activateResult(resultId);
      await loadImages();
      if (state.currentImageId === targetImageId) {
        state.currentImage = await api.getImage(targetImageId);
        renderDetails();
      }
    });
  });
  els.resultGrid.querySelectorAll("[data-delete-result]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetImageId = state.currentImageId;
      const resultId = btn.dataset.deleteResult;
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
    });
  });
  els.resultGrid.querySelectorAll("[data-use-ref-result]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const resultId = btn.dataset.useRefResult;
      const name = state.currentImage ? `${state.currentImage.display_name} result` : "result";
      useAsReferenceFromUrl(`/api/results/${resultId}/file`, name);
    });
  });
  els.resultGrid.querySelectorAll("[data-promote-result]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await promoteResultToSource(btn.dataset.promoteResult);
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
      await loadImages();
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

els.promptSelect.addEventListener("change", () => {
  const prompt = state.prompts.find((p) => p.id === els.promptSelect.value);
  if (prompt) els.promptTextarea.value = prompt.prompt_text;
});

// ---------------------------------------------------------------------------
// Reference images (ComfyUI only) -- up to MAX_REFERENCE_IMAGES images picked
// from this project's reference-image library (the References sidebar tab,
// a separate pool from source images) and sent alongside the source image on
// generate. Selection persists across image switches, same as the
// engine/aspect-ratio selects.
// ---------------------------------------------------------------------------
const MAX_REFERENCE_IMAGES = 2;

function updateReferenceImagesVisibility() {
  els.referenceImagesField.style.display = els.engineSelect.value === "comfyui" ? "flex" : "none";
}

function renderReferenceImages() {
  els.referenceImageList.innerHTML = state.referenceImageIds
    .map((id) => {
      const ref = state.referenceImages.find((r) => r.id === id);
      const label = escapeHtml(ref ? ref.display_name : "");
      return `
        <div class="reference-image-thumb" title="${label}">
          <img src="/api/reference-images/${id}/thumbnail" loading="lazy" />
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
          <img src="/api/reference-images/${ref.id}/thumbnail" loading="lazy" />
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
          <img src="/api/reference-images/${ref.id}/thumbnail" loading="lazy" />
          <div class="reference-library-item-actions">
            <button class="reference-library-item-btn" data-crop-ref="${ref.id}" title="Crop">✂</button>
            <button class="reference-library-item-btn danger" data-delete-ref="${ref.id}" title="Delete">✕</button>
          </div>
          <div class="reference-library-item-name">${escapeHtml(ref.display_name)}</div>
        </div>
      `
    )
    .join("");
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
  const referenceImageIds = engine === "comfyui" ? state.referenceImageIds : [];
  const job = await api.generateResult(imageId, {
    prompt_id: promptId,
    adhoc_prompt_text: promptText,
    engine,
    aspect_ratio: aspectRatio,
    reference_image_ids: referenceImageIds.length ? referenceImageIds : undefined,
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

  if (anyNewlyFinished) {
    await loadImages();
    if (touchedCurrentImage && state.currentImageId) {
      state.currentImage = await api.getImage(state.currentImageId);
      renderDetails();
    }
  } else {
    applyQueueOrdering();
    renderImageList();
  }

  updateGenerateStatusForCurrentImage();
  renderQueueOverlay();
}

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

function formatJobStatus(job) {
  if (job.status === "done") return "Done.";
  if (job.status === "cancelled") return "Cancelled.";
  if (job.status === "error") return `Error: ${job.error || ""}`;
  const elapsed = ` (${formatElapsed(jobElapsedSeconds(job))})`;
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
  await loadImages();
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
      els.promptTextarea.value = prompt.prompt_text;
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
    <div class="field">
      <label>xAI API Key ${config.has_api_key ? `(current: ${config.xai_api_key})` : ""}</label>
      <input id="mKey" type="password" placeholder="Enter to replace..." />
    </div>
    <div class="field"><label>Default Model</label><input id="mModel" type="text" value="${config.default_model}" /></div>
    <div class="field"><label>Default Max Dimension</label><input id="mMaxDim" type="number" value="${config.default_max_dim}" /></div>
    <div id="mConnStatus" class="status-line"></div>
    <hr />
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
    <div id="mComfyConnStatus" class="status-line"></div>
    <hr />
    <div class="field">
      <label>fal.ai API Key ${config.has_fal_api_key ? `(current: ${config.fal_api_key})` : ""}</label>
      <input id="mFalKey" type="password" placeholder="Enter to replace..." />
    </div>
    <div class="field">
      <label>fal.ai Model</label>
      <div style="display:flex; gap:6px; align-items:center;">
        <select id="mFalModel" style="flex:1;">
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
    <div id="mFalConnStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCheck" class="btn-ghost">Check Grok Connection</button>
      <button id="mCheckComfy" class="btn-ghost">Check ComfyUI Connection</button>
      <button id="mCheckFal" class="btn-ghost">Check fal.ai Connection</button>
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
        <img src="/api/reference-images/${ref.id}/thumbnail" loading="lazy" />
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

els.exportBtn.addEventListener("click", () => {
  const modal = openModal(`
    <h3>Export Results</h3>
    <div class="field">
      <label>Status Filter</label>
      <select id="mStatus">
        <option value="YES">Approved (YES)</option>
        <option value="ALL">All evaluated</option>
        <option value="MAYBE">Maybe</option>
        <option value="NO">Rejected</option>
      </select>
    </div>
    <div class="field">
      <label>Format</label>
      <select id="mMode">
        <option value="clean">Clean (result images only)</option>
        <option value="side_by_side">Side-by-Side (A/B pairs)</option>
      </select>
    </div>
    <div id="mExportStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Cancel</button>
      <button id="mGo" class="btn-primary">Export</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mGo").addEventListener("click", async () => {
    const status_filter = modal.querySelector("#mStatus").value;
    const mode = modal.querySelector("#mMode").value;
    modal.querySelector("#mExportStatus").textContent = "Building export...";
    try {
      const res = await fetch(`/api/projects/${state.currentProjectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status_filter, mode }),
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
      closeModal();
    } catch (e) {
      modal.querySelector("#mExportStatus").textContent = `Error: ${e.message}`;
    }
  });
});

// ---------------------------------------------------------------------------
// Hotkeys & utils
// ---------------------------------------------------------------------------

initHotkeys({
  onYes: () => setEvaluation("YES"),
  onNo: () => setEvaluation("NO"),
  onMaybe: () => setEvaluation("MAYBE"),
  onPrev: () => stepImage(-1),
  onNext: () => stepImage(1),
  onFocusPrompt: () => els.promptTextarea.focus(),
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
  pollQueue();
  setInterval(pollQueue, 1200);
})();
