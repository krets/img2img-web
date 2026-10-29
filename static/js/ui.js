// Shared UI helpers used by both the generation page (app.js) and the
// management page (manage.js): HTML escaping, small formatters, the modal
// stack, the image lightbox and the kebab item menu. Both pages carry the same
// #modalOverlay / #modalContent markup, which this module looks up itself.

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

const modalOverlay = document.getElementById("modalOverlay");
const modalContent = document.getElementById("modalContent");

// Accessors for the module-local modal state above, which importers can read
// through live bindings but not assign.
export function setModalOnClose(fn) {
  modalOnClose = fn;
}
export function pushModalBack(step) {
  modalBackStack.push(step);
}
export function clearModalBackStack() {
  modalBackStack = [];
}
export function isModalOpen() {
  return modalOverlay.style.display !== "none";
}

export function openModal(html) {
  modalContent.innerHTML = html;
  modalOverlay.style.display = "flex";
  return modalContent;
}
export function closeModal() {
  modalOverlay.style.display = "none";
  modalContent.innerHTML = "";
  modalBackStack = [];
  lightboxNav = null;
  const onClose = modalOnClose;
  modalOnClose = null;
  if (onClose) onClose();
}
export function modalBack() {
  lightboxNav = null;
  const step = modalBackStack.pop();
  if (step) step();
  else closeModal();
}
// Only close when the click (mousedown + mouseup) both started on the overlay,
// not when the user drag-selects text inside the modal and releases outside.
let overlayMousedownTarget = null;
modalOverlay.addEventListener("mousedown", (e) => {
  overlayMousedownTarget = e.target;
});
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay && overlayMousedownTarget === modalOverlay) modalBack();
  overlayMousedownTarget = null;
});
document.addEventListener("keydown", (e) => {
  if (modalOverlay.style.display === "none") return;
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
// With secondaryLabel a third button sits before it and resolves "secondary".
export function openConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, secondaryLabel = null }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="dup-section-hint">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button id="mCancel" class="btn-ghost" type="button">${escapeHtml(cancelLabel)}</button>
        ${secondaryLabel ? `<button id="mSecondary" class="${danger ? "btn-danger" : "btn-primary"}" type="button">${escapeHtml(secondaryLabel)}</button>` : ""}
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
    modal.querySelector("#mSecondary")?.addEventListener("click", () => {
      settled = true;
      closeModal();
      resolve("secondary");
    });
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

export function closeItemMenu() {
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
export function openItemMenu(anchorEl, items, { onClose } = {}) {
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

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC, with no zone marker.
export function parseDbTime(ts) {
  return ts ? new Date(ts.replace(" ", "T") + "Z").getTime() : 0;
}

export function formatRelativeTime(ms) {
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

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
//
// crop, if given ({x, y, w, h, naturalWidth, naturalHeight}, all in the
// original image's own pixel space), outlines that region over the full
// image with the surrounding area dimmed -- the lightbox otherwise shows the
// untouched original, with no way to tell what's actually cropped in for
// generation. Expressed as percentages of the natural size, so it lines up
// with the displayed image at any scale without extra JS on resize.
//
// onEditCrop, if given, adds an "Edit crop" action that hands off to the
// crop editor; callers push a "redraw me" step onto modalBackStack first
// (see pushModalBack) so cancelling the crop editor returns to this view.
export function openImageLightbox(url, title, { onPrev, onNext, position, crop, onEditCrop } = {}) {
  const hasBack = modalBackStack.length > 0;
  const navBtns =
    onPrev || onNext
      ? `
      <button class="lightbox-nav-btn lightbox-nav-prev" id="mPrev" title="Previous (←)" ${onPrev ? "" : "disabled"}>‹</button>
      <button class="lightbox-nav-btn lightbox-nav-next" id="mNext" title="Next (→)" ${onNext ? "" : "disabled"}>›</button>
    `
      : "";
  const cropBoxHtml = crop
    ? `<div class="lightbox-crop-box" style="left:${(crop.x / crop.naturalWidth) * 100}%;top:${(crop.y / crop.naturalHeight) * 100}%;width:${(crop.w / crop.naturalWidth) * 100}%;height:${(crop.h / crop.naturalHeight) * 100}%" title="Applied crop"></div>`
    : "";
  const modal = openModal(`
    <div class="lightbox-stage">
      ${navBtns}
      <div class="lightbox-img-wrap">
        <img class="lightbox-img" src="${url}" alt="${escapeHtml(title || "")}" />
        ${cropBoxHtml}
      </div>
    </div>
    <div class="modal-actions">
      ${position ? `<span class="lightbox-position">${escapeHtml(position)}</span>` : ""}
      ${onEditCrop ? `<button id="mEditCrop" class="btn-ghost" type="button">✂ Edit crop</button>` : ""}
      <a class="btn-ghost" href="${url}" target="_blank" rel="noopener">↗ Open</a>
      <button id="mCancel" class="btn-ghost">${hasBack ? "← Back" : "Close"}</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", modalBack);
  if (onPrev) modal.querySelector("#mPrev").addEventListener("click", onPrev);
  if (onNext) modal.querySelector("#mNext").addEventListener("click", onNext);
  if (onEditCrop) modal.querySelector("#mEditCrop").addEventListener("click", onEditCrop);
  lightboxNav = onPrev || onNext ? { prev: onPrev, next: onNext } : null;
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
// For values inside a quoted HTML attribute, where escapeHtml alone leaves `"` intact.
export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Formats a duration in seconds as e.g. "45s", "3m 12s", "1h 05m". Used both
// for live elapsed time (queue/job in progress) and total generation time
// stored on finished results.
export function formatElapsed(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  if (m < 60) return `${m}m ${String(remSec).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return `${h}h ${String(remMin).padStart(2, "0")}m`;
}

// Cache-busts the thumbnail URL whenever the crop box changes, so a recrop
// is reflected immediately instead of the browser reusing whatever it last
// fetched for that same URL -- this also doubles as a visual confirmation
// that a crop was actually saved (the thumbnail visibly updates).
export function refThumbUrl(ref) {
  const crop = ref.crop_x != null ? `${ref.crop_x}-${ref.crop_y}-${ref.crop_w}-${ref.crop_h}` : "full";
  return `/api/reference-images/${ref.id}/thumbnail?v=${crop}`;
}
