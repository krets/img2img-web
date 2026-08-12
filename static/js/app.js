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
  commentInput: document.getElementById("commentInput"),
  promptSelect: document.getElementById("promptSelect"),
  promptTextarea: document.getElementById("promptTextarea"),
  engineSelect: document.getElementById("engineSelect"),
  aspectRatioSelect: document.getElementById("aspectRatioSelect"),
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

function openModal(html) {
  els.modalContent.innerHTML = html;
  els.modalOverlay.style.display = "flex";
  return els.modalContent;
}
function closeModal() {
  els.modalOverlay.style.display = "none";
  els.modalContent.innerHTML = "";
}
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.modalOverlay.style.display !== "none") closeModal();
});

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
    await loadImages();
  }
}

els.projectSwitcher.addEventListener("change", async () => {
  state.currentProjectId = els.projectSwitcher.value;
  localStorage.setItem("lastProjectId", state.currentProjectId);
  state.currentImageId = null;
  state.currentImage = null;
  renderDetails();
  await loadImages();
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
    await loadImages();
  });
});

els.deleteProjectBtn.addEventListener("click", async () => {
  if (!state.currentProjectId) return;
  const project = state.projects.find((p) => p.id === state.currentProjectId);
  const name = project?.name || "this project";
  if (
    !confirm(`Move "${name}" (and all of its images/results) to trash? You can restore it from Trash within 2 days.`)
  )
    return;
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

function renderImageList() {
  els.imageList.innerHTML = state.images
    .map((img) => {
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
          ${renderChits(img)}
        </div>
      `;
    })
    .join("");

  if (state.multiSelectMode) {
    els.imageList.querySelectorAll(".image-item").forEach((el) => {
      el.addEventListener("click", () => toggleImageSelection(el.dataset.id));
    });
  } else {
    els.imageList.querySelectorAll(".image-item").forEach((el) => {
      el.addEventListener("click", () => selectImage(el.dataset.id));
    });
    els.imageList.querySelectorAll(".chit[data-result-id]").forEach((chitEl) => {
      chitEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const imageId = chitEl.closest(".image-item").dataset.id;
        selectImageResult(imageId, chitEl.dataset.resultId);
      });
    });
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
  if (!confirm("Move all NO-rated results in this project to trash? You can restore them from Trash within 2 days.")) return;
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
    await handleUploadedFiles(imageFiles);
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
  if (!confirm(`Move "${name}" and all of its results to trash? You can restore it from Trash within 2 days.`)) return;
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
      if (!confirm("Move this result to trash? You can restore it from Trash within 2 days.")) return;
      await api.deleteResult(resultId);
      if (state.currentImageId === targetImageId) {
        state.currentImage = await api.getImage(targetImageId);
        renderDetails();
      }
      await loadImages();
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
  const job = await api.generateResult(imageId, {
    prompt_id: promptId,
    adhoc_prompt_text: promptText,
    engine,
    aspect_ratio: aspectRatio,
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
      if (!confirm("Delete this prompt?")) return;
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

function renderFalModelOptions(config) {
  const groups = new Map();
  for (const m of FAL_MODELS) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  return [...groups.entries()]
    .map(
      ([group, models]) => `
        <optgroup label="${group}">
          ${models
            .map((m) => `<option value="${m.value}" ${config.fal_model === m.value ? "selected" : ""}>${m.label}</option>`)
            .join("")}
        </optgroup>
      `
    )
    .join("");
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
      <select id="mFalModel">
        ${renderFalModelOptions(config)}
        <option value="${FAL_MODEL_CUSTOM}" ${
          FAL_MODELS.some((m) => m.value === config.fal_model) ? "" : "selected"
        }>Custom model ID...</option>
      </select>
      <input
        id="mFalModelCustom"
        type="text"
        placeholder="e.g. fal-ai/your-model-id"
        style="display:${FAL_MODELS.some((m) => m.value === config.fal_model) ? "none" : "block"}; margin-top:6px;"
        value="${FAL_MODELS.some((m) => m.value === config.fal_model) ? "" : escapeHtml(config.fal_model || "")}"
      />
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
      if (!confirm("Move this image and all its results to trash? You can restore it from Trash within 2 days.")) return;
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
      if (
        !confirm(
          `Merge ${removeIds.length} duplicate(s) into the selected image? Their results will be combined onto it, and the duplicate copies removed.`
        )
      )
        return;
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
  const [projectTrash, trashedProjects] = await Promise.all([
    state.currentProjectId ? api.getProjectTrash(state.currentProjectId) : Promise.resolve({ images: [], results: [] }),
    api.getTrashedProjects(),
  ]);
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
      if (!confirm("Permanently delete this image and its results? This cannot be undone.")) return;
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
      if (!confirm("Permanently delete this result? This cannot be undone.")) return;
      await api.permanentlyDeleteResult(btn.dataset.purgeResult);
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
      if (!confirm("Permanently delete this project and everything in it? This cannot be undone.")) return;
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
  pollQueue();
  setInterval(pollQueue, 1200);
})();
