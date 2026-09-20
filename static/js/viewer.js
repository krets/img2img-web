/** Image review viewport: source vs. result, with several comparison modes.
 * All modes share the same two <img> elements (repositioned/restyled per mode
 * via CSS keyed off ab-stage[data-mode]) rather than duplicating image nodes.
 *
 * Modes:
 *  - wipe-lr / wipe-tb: draggable clip-path wipe (default: wipe-lr)
 *  - hold-result / hold-source: press-and-hold swaps which image is on top
 *  - side-by-side: both images adjacent, row or column orientation
 *  - diff: result layered over source with mix-blend-mode: difference
 *  - blend: opacity crossfade between the two, via a toolbar slider (not an
 *    on-image handle -- there's no natural on-image position for it)
 *
 * The left/"base" image is normally the selected image's own source. For an
 * image derived from an earlier result, the host can offer ancestors as
 * alternative bases via setCompareOptions() -- a dropdown appears in the
 * modebar, and the host swaps the base url passed to setImages() on change.
 *
 * Separate from those comparison modes (and set apart by a divider in the
 * modebar) is the crop/pre-process mode: an editor, not a comparison, for
 * choosing how the source is rotated/cropped/padded before it's sent to an
 * engine (see preprocess.js). The host enables it per image via
 * setPreprocess(), and shows the resulting processed image as the base.
 */
import { createPreprocessEditor } from "./preprocess.js";

const STORAGE_KEY = "grok_img2img.viewerMode";
const PREPROCESS_MODE = "preprocess";

const MODES = [
  { id: "wipe-lr", icon: "⬌", title: "Wipe left/right" },
  { id: "wipe-tb", icon: "⬍", title: "Wipe top/bottom" },
  { id: "hold-result", icon: "👁︎R", title: "Hold to reveal result (default: source)" },
  { id: "hold-source", icon: "👁︎S", title: "Hold to reveal original (default: result)" },
  { id: "side-by-side", icon: "▥", title: "Side by side" },
  { id: "diff", icon: "±", title: "Difference" },
  { id: "blend", icon: "◐", title: "Blend" },
];
// Modes with an on-image drag handle. Blend is deliberately excluded -- its
// crossfade slider lives in the modebar instead of overlaying the image.
const DRAG_MODES = new Set(["wipe-lr", "wipe-tb"]);
const HOLD_MODES = new Set(["hold-result", "hold-source"]);

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

export function initABViewer(container) {
  container.innerHTML = `
    <div class="viewer-modebar" id="viewerModebar">
      ${MODES.map((m) => `<button class="viewer-mode-btn" data-mode="${m.id}" title="${m.title}">${m.icon}</button>`).join("")}
      <input type="range" id="blendSlider" class="viewer-blend-slider" min="0" max="100" value="50" title="Blend crossfade" style="display:none" />
      <span class="viewer-mode-sep" aria-hidden="true"></span>
      <button class="viewer-mode-btn viewer-preprocess-btn" id="preprocessBtn" data-mode="${PREPROCESS_MODE}" title="Crop / pre-process the source image (rotate, crop, pad) before it's sent to the service" disabled>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 1v14h14M1 5h14v14" /></svg>
      </button>
      <span class="viewer-preprocess-controls" id="preprocessControls" style="display:none"></span>
      <span class="viewer-modebar-right">
        <label class="viewer-compare" id="compareWrap" style="display:none" title="Choose which earlier version of this image to compare the result against">
          Compare with
          <select id="compareSelect" class="viewer-compare-select"></select>
        </label>
        <button class="viewer-mode-btn viewer-orientation-btn" id="orientationToggleBtn" title="Toggle row/column layout" style="display:none">⟳</button>
      </span>
    </div>
    <div class="viewer-stage-wrap">
      <div class="ab-stage" id="abStage" data-mode="wipe-lr">
        <img class="ab-base" id="abBase" alt="Source" />
        <div class="ab-overlay" id="abOverlay">
          <img class="ab-result" id="abResult" alt="Result" />
        </div>
        <div class="ab-handle" id="abHandle"><div class="ab-handle-grip"></div></div>
        <div class="ab-badge" id="abBadge" style="display:none" title="The image on the left is the pre-processed source that gets sent to the service. The stored original is unchanged.">✂ Pre-processed source</div>
        <div class="ab-actions" id="abActions">
          <button class="ab-action-btn" id="abCopyBtn" title="Copy result image to clipboard">📋 Copy</button>
          <button class="ab-action-btn" id="abOpenBtn" title="Open result image in a new tab">↗ Open</button>
        </div>
      </div>
      <div class="pp-stage" id="ppStage" style="display:none"></div>
      <div class="ab-empty" id="abEmpty">Select an image to begin.</div>
    </div>
  `;

  const modebar = container.querySelector("#viewerModebar");
  const stage = container.querySelector("#abStage");
  const base = container.querySelector("#abBase");
  const resultImg = container.querySelector("#abResult");
  const overlay = container.querySelector("#abOverlay");
  const handle = container.querySelector("#abHandle");
  const empty = container.querySelector("#abEmpty");
  const actions = container.querySelector("#abActions");
  const copyBtn = container.querySelector("#abCopyBtn");
  const openBtn = container.querySelector("#abOpenBtn");
  const orientationBtn = container.querySelector("#orientationToggleBtn");
  const blendSlider = container.querySelector("#blendSlider");
  const compareWrap = container.querySelector("#compareWrap");
  const compareSelect = container.querySelector("#compareSelect");
  const preprocessBtn = container.querySelector("#preprocessBtn");
  const preprocessControls = container.querySelector("#preprocessControls");
  const preprocessStage = container.querySelector("#ppStage");
  const badge = container.querySelector("#abBadge");
  let onCompareChange = null;

  // { imageId, rawUrl, params, onApply(params) } for the selected image, or
  // null while there's nothing editable (no image, or its details haven't
  // loaded yet). See setPreprocess().
  let preprocessCtx = null;
  const editor = createPreprocessEditor({
    stage: preprocessStage,
    controlsHost: preprocessControls,
    onApply: async (params) => {
      const ctx = preprocessCtx;
      if (!ctx) return;
      await ctx.onApply(params);
      if (mode === PREPROCESS_MODE && preprocessCtx?.imageId === ctx.imageId) setMode(compareMode);
    },
    onCancel: () => setMode(compareMode),
  });
  compareSelect.addEventListener("change", () => onCompareChange?.(compareSelect.value || null));

  // navigator.clipboard is only exposed in secure contexts (localhost or HTTPS);
  // over plain LAN HTTP it's undefined, so hide the button rather than let it
  // silently fail -- side-by-side mode lets the browser's native right-click
  // "Copy image" work on the plain <img> instead.
  const clipboardAvailable = !!(navigator.clipboard && window.isSecureContext);
  if (!clipboardAvailable) copyBtn.style.display = "none";

  let currentResultUrl = null;
  let hasResult = false;
  let hasSource = false;
  // Tracks what's actually loaded into the base/result <img> elements, so
  // repeated setImages() calls with unchanged urls (e.g. a metadata refresh
  // after a background job finishes on the currently-viewed image) don't
  // needlessly re-trigger the progressive load below.
  let loadedSourceUrl = null;
  let loadedResultUrl = null;

  // The /preview endpoint mirrors /file's URL shape but returns a small,
  // aspect-ratio-preserving JPEG (unlike /thumbnail, which is cropped to a
  // square for list/grid use and would jump the framing when swapped for
  // the full image).
  function previewUrlFor(fullUrl) {
    return fullUrl && /\/file$/.test(fullUrl) ? fullUrl.replace(/\/file$/, "/preview") : null; // e.g. /processed has no lower-res twin
  }

  // Immediately shows a small same-framed preview so the viewer reflects the
  // newly-selected image right away, then swaps in the full-res version once
  // it's loaded. Without this, the <img> keeps rendering whatever it last
  // displayed until the new full-res file finishes loading -- which reads as
  // "the original still shows the previous image" when switching images.
  //
  // imgEl.dataset.pendingFull records the most recently requested full url
  // for this element; the upgrade only applies if it's still current, so a
  // slow load for an image the user has since navigated away from can't
  // clobber whatever loaded after it.
  //
  // onGiveUp fires if the full-res load keeps failing after retries (e.g. a
  // transient network hiccup, or the browser's per-host connection limit
  // starving it behind other in-flight thumbnail/preview requests). Without
  // it, setImages()'s loadedSourceUrl/loadedResultUrl tracking -- set
  // optimistically before the load actually succeeds -- would mark this url
  // as "loaded" even though the <img> never got a real image, leaving it
  // stuck showing nothing (the panel's dark background, i.e. "black") until
  // the user happened to navigate to a different image and back.
  function loadProgressive(imgEl, fullUrl, onGiveUp) {
    imgEl.dataset.pendingFull = fullUrl;
    const previewUrl = previewUrlFor(fullUrl);
    if (previewUrl) imgEl.src = previewUrl;
    let attempt = 0;
    const tryLoad = () => {
      const upgrade = new Image();
      upgrade.onload = () => {
        if (imgEl.dataset.pendingFull === fullUrl) imgEl.src = fullUrl;
      };
      upgrade.onerror = () => {
        if (imgEl.dataset.pendingFull !== fullUrl) return; // superseded; drop it
        attempt += 1;
        if (attempt <= 2) {
          setTimeout(tryLoad, 500 * attempt);
        } else {
          onGiveUp?.();
        }
      };
      upgrade.src = fullUrl;
    };
    tryLoad();
  }

  function updateStageDisplay() {
    if (!hasSource) {
      stage.style.display = "none";
      return;
    }
    stage.style.display = mode === PREPROCESS_MODE ? "none" : mode === "side-by-side" ? "flex" : "block";
  }

  const saved = loadState();
  // `compareMode` is the last comparison mode chosen; `mode` is what's active
  // and additionally can be PREPROCESS_MODE, which is never persisted or
  // restored (it needs an image to edit) -- leaving it returns to compareMode.
  let compareMode = MODES.some((m) => m.id === saved.mode) ? saved.mode : "wipe-lr";
  let mode = compareMode;
  let orientation = saved.orientation === "column" ? "column" : "row";
  let percent = 50; // wipe-lr / wipe-tb position, and blend crossfade, 0-100

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: compareMode, orientation }));
  }

  // Re-encodes as PNG via canvas since the Clipboard API only reliably
  // accepts image/png across browsers, regardless of the source file's format.
  async function copyImageToClipboard(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  }

  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentResultUrl) return;
    const original = copyBtn.textContent;
    try {
      await copyImageToClipboard(currentResultUrl);
      copyBtn.textContent = "✓ Copied";
    } catch (err) {
      copyBtn.textContent = "✕ Failed";
    } finally {
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    }
  });

  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!currentResultUrl) return;
    window.open(currentResultUrl, "_blank", "noopener");
  });

  function applyPercent(p) {
    percent = Math.min(100, Math.max(0, p));
    stage.style.setProperty("--wipe-pct", `${percent}%`);
    stage.style.setProperty("--blend-opacity", percent / 100);
  }

  function percentFromEvent(evt) {
    const rect = stage.getBoundingClientRect();
    if (mode === "wipe-tb") return ((evt.clientY - rect.top) / rect.height) * 100;
    return ((evt.clientX - rect.left) / rect.width) * 100;
  }

  let dragging = false;
  handle.addEventListener("pointerdown", (evt) => {
    if (!DRAG_MODES.has(mode)) return;
    dragging = true;
    handle.setPointerCapture(evt.pointerId);
  });
  stage.addEventListener("pointermove", (evt) => {
    if (dragging && DRAG_MODES.has(mode)) {
      applyPercent(percentFromEvent(evt));
    }
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
  stage.addEventListener("pointerdown", (evt) => {
    if (DRAG_MODES.has(mode)) {
      if (evt.target === handle || handle.contains(evt.target)) return;
      applyPercent(percentFromEvent(evt));
      return;
    }
    if (HOLD_MODES.has(mode) && hasResult) {
      stage.classList.add("ab-holding");
      stage.setPointerCapture(evt.pointerId);
    }
  });
  function releaseHold() {
    stage.classList.remove("ab-holding");
  }
  stage.addEventListener("pointerup", releaseHold);
  stage.addEventListener("pointerleave", releaseHold);
  stage.addEventListener("pointercancel", releaseHold);

  // <img> elements are natively draggable, which fights with the wipe handle
  // and hold-to-reveal pointer interactions (starts a browser image-drag ghost
  // mid-gesture instead of moving the wipe line / holding the reveal). Only
  // block it for modes that rely on mouse dragging -- side-by-side/diff/blend
  // have no drag interaction, so their images keep normal native behavior
  // (e.g. right-click "Copy image").
  stage.addEventListener("dragstart", (evt) => {
    if (DRAG_MODES.has(mode) || HOLD_MODES.has(mode)) evt.preventDefault();
  });

  function setMode(nextMode) {
    if (nextMode === PREPROCESS_MODE) {
      if (!preprocessCtx) return;
      if (mode === PREPROCESS_MODE) return setMode(compareMode); // clicking the active crop button again backs out
    } else {
      compareMode = nextMode;
    }
    const wasPreprocess = mode === PREPROCESS_MODE;
    mode = nextMode;
    const inPreprocess = mode === PREPROCESS_MODE;
    stage.dataset.mode = compareMode; // the (hidden) comparison stage keeps its last layout
    stage.classList.remove("ab-holding");
    modebar.querySelectorAll(".viewer-mode-btn[data-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    modebar.classList.toggle("pp-active", inPreprocess);
    preprocessControls.style.display = inPreprocess ? "inline-flex" : "none";
    preprocessStage.style.display = inPreprocess ? "block" : "none";
    orientationBtn.style.display = mode === "side-by-side" ? "inline-flex" : "none";
    blendSlider.style.display = mode === "blend" ? "block" : "none";
    if (mode === "blend") blendSlider.value = percent;
    applyPercent(percent);
    updateStageDisplay();
    if (hasSource) {
      handle.style.display = hasResult && DRAG_MODES.has(mode) ? "block" : "none";
    }
    if (wasPreprocess && !inPreprocess) editor.close();
    if (inPreprocess) {
      preprocessBtn.blur(); // so the editor's Enter/Esc shortcuts aren't swallowed by the button that opened it
      const ctx = preprocessCtx;
      editor.open(ctx.rawUrl, ctx.params).catch((err) => {
        if (preprocessCtx?.imageId !== ctx.imageId) return;
        setMode(compareMode);
        ctx.onError?.(err.message);
      });
    }
    persist();
  }

  function setOrientation(next) {
    orientation = next;
    stage.classList.toggle("orientation-column", orientation === "column");
    persist();
  }

  modebar.querySelectorAll(".viewer-mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  orientationBtn.addEventListener("click", () => setOrientation(orientation === "row" ? "column" : "row"));
  blendSlider.addEventListener("input", (e) => applyPercent(Number(e.target.value)));

  setMode(mode);
  setOrientation(orientation);
  applyPercent(50);

  return {
    // options: [{ id, label }] of alternative base images (empty hides the
    // dropdown); selectedId null means "this image's own source".
    setCompareOptions(options, selectedId, onChange) {
      onCompareChange = onChange || null;
      compareWrap.style.display = options.length ? "inline-flex" : "none";
      compareSelect.innerHTML = "";
      if (!options.length) return;
      const own = document.createElement("option");
      own.value = "";
      own.textContent = "This image's source";
      compareSelect.appendChild(own);
      for (const opt of options) {
        const el = document.createElement("option");
        el.value = opt.id;
        el.textContent = opt.label;
        compareSelect.appendChild(el);
      }
      compareSelect.value = selectedId || "";
    },
    // ctx: { imageId, rawUrl, params, onApply(params) => Promise, onError(msg) } for the
    // image the crop/pre-process mode edits, or null to disable it. rawUrl is
    // the untouched source; params are its current settings (null = none).
    // Called again with the same imageId after every save -- an open editor is
    // left alone unless the image itself changed.
    setPreprocess(ctx) {
      const previousId = preprocessCtx?.imageId;
      preprocessCtx = ctx;
      preprocessBtn.disabled = !ctx;
      preprocessBtn.classList.toggle("has-edits", !!ctx?.params);
      if (mode === PREPROCESS_MODE && (!ctx || ctx.imageId !== previousId)) setMode(compareMode);
    },
    // opts.baseProcessed: the base image is the pre-processed render of the
    // source rather than the source itself -- flagged with a badge.
    setImages(sourceUrl, resultUrl, opts = {}) {
      hasSource = !!sourceUrl;
      if (!sourceUrl) {
        if (mode === PREPROCESS_MODE) setMode(compareMode);
        updateStageDisplay();
        modebar.style.display = "none";
        empty.style.display = "flex";
        return;
      }
      badge.style.display = opts.baseProcessed ? "block" : "none";
      updateStageDisplay();
      modebar.style.display = "flex";
      empty.style.display = "none";
      if (sourceUrl !== loadedSourceUrl) {
        loadedSourceUrl = sourceUrl;
        loadProgressive(base, sourceUrl, () => {
          if (loadedSourceUrl === sourceUrl) loadedSourceUrl = null;
        });
      }
      currentResultUrl = resultUrl || null;
      hasResult = !!resultUrl;
      if (resultUrl) {
        if (resultUrl !== loadedResultUrl) {
          loadedResultUrl = resultUrl;
          loadProgressive(resultImg, resultUrl, () => {
            if (loadedResultUrl === resultUrl) loadedResultUrl = null;
          });
        }
        overlay.style.visibility = "visible";
        handle.style.display = DRAG_MODES.has(mode) ? "block" : "none";
        actions.style.display = "flex";
      } else {
        loadedResultUrl = null;
        overlay.style.visibility = "hidden";
        handle.style.display = "none";
        actions.style.display = "none";
      }
    },
  };
}
