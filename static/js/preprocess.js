/** Source pre-process editor: rotate in 90-degree steps and pick a crop
 * region that may extend past the image (the overhang is padded with a solid
 * color or a blurred copy of the image -- the server renders that on Apply, see
 * preprocess.py). Edits are only ever *settings*: the stored source is never
 * modified, and nothing here touches the server until Apply.
 *
 * Coordinates: crop is kept in the *rotated* image's pixel space (the same
 * space the server uses), so what's on screen is what gets rendered. The
 * view re-fits around image+crop whenever a gesture ends, so the crop can be
 * walked further and further out without the image shrinking mid-drag.
 */
const FILL_STORAGE_KEY = "grok_img2img.preprocessFill";
const MIN_CROP = 8; // world px
const MAX_SIDE = 12000; // keep in sync with preprocess.py
const MAX_PIXELS = 60_000_000;
const VIEW_PAD = 0.18; // breathing room around image+crop, as a fraction of the larger side
const EDGE_INSET = 10; // screen px the crop keeps from the stage edge so handles stay grabbable

const ASPECTS = [
  { value: "free", label: "Free" },
  { value: "original", label: "Original" },
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "3:2", label: "3:2" },
  { value: "4:3", label: "4:3" },
  { value: "9:16", label: "9:16" },
  { value: "2:3", label: "2:3" },
  { value: "3:4", label: "3:4" },
];

function loadFillPref() {
  try {
    const f = JSON.parse(localStorage.getItem(FILL_STORAGE_KEY));
    if (f && (f.mode === "blur" || f.mode === "color") && /^#[0-9a-f]{6}$/i.test(f.color)) return f;
  } catch {}
  return { mode: "blur", color: "#000000" };
}

function saveFillPref(fill) {
  try {
    localStorage.setItem(FILL_STORAGE_KEY, JSON.stringify(fill));
  } catch {}
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** stage: element the editor fills (positioned, sized by the host).
 * controlsHost: modebar element that receives the toolbar controls.
 * Returns { open, close, isOpen, refit }.
 */
export function createPreprocessEditor({ stage, controlsHost, onApply, onCancel }) {
  stage.innerHTML = `
    <div class="pp-fill" data-role="fill"></div>
    <img class="pp-img" data-role="img" draggable="false" alt="" />
    <div class="pp-crop" data-role="crop">
      <div class="pp-grid"></div>
      ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `<div class="pp-handle pp-handle-${h}" data-handle="${h}"></div>`).join("")}
      <div class="pp-readout" data-role="readout"></div>
    </div>
  `;
  controlsHost.innerHTML = `
    <button type="button" class="viewer-mode-btn" data-act="rotate-ccw" title="Rotate 90° counter-clockwise">↺</button>
    <button type="button" class="viewer-mode-btn" data-act="rotate-cw" title="Rotate 90° clockwise">↻</button>
    <select class="pp-select" data-role="aspect" title="Lock the crop region to an aspect ratio">
      ${ASPECTS.map((a) => `<option value="${a.value}">${a.label}</option>`).join("")}
    </select>
    <select class="pp-select" data-role="fill-mode" title="What to put in the parts of the crop that extend past the image">
      <option value="blur">Fill: blurred original</option>
      <option value="color">Fill: solid color</option>
    </select>
    <input type="color" class="pp-color" data-role="fill-color" title="Fill color" />
    <span class="pp-size" data-role="size"></span>
    <span class="pp-error" data-role="error"></span>
    <button type="button" class="viewer-mode-btn" data-act="reset" title="Back to the whole, unrotated image">Reset</button>
    <button type="button" class="viewer-mode-btn" data-act="cancel" title="Discard these edits (Esc)">Cancel</button>
    <button type="button" class="viewer-mode-btn pp-apply" data-act="apply" title="Save and use this pre-processed source for generation (Enter)">Apply</button>
  `;

  const q = (root, role) => root.querySelector(`[data-role="${role}"]`);
  const fillEl = q(stage, "fill");
  const imgEl = q(stage, "img");
  const cropEl = q(stage, "crop");
  const readoutEl = q(stage, "readout");
  const aspectSel = q(controlsHost, "aspect");
  const fillModeSel = q(controlsHost, "fill-mode");
  const fillColorInput = q(controlsHost, "fill-color");
  const sizeEl = q(controlsHost, "size");
  const errorEl = q(controlsHost, "error");
  const applyBtn = controlsHost.querySelector('[data-act="apply"]');

  let opened = false;
  let natW = 0;
  let natH = 0;
  let rotation = 0; // clockwise degrees
  let crop = { x: 0, y: 0, w: 0, h: 0 }; // rotated-image pixel space, floats while dragging
  let fill = loadFillPref();
  let lock = "free";
  // world -> screen: screen = world * scale + off
  let scale = 1;
  let offX = 0;
  let offY = 0;

  const rotW = () => (rotation % 180 === 0 ? natW : natH);
  const rotH = () => (rotation % 180 === 0 ? natH : natW);

  function lockRatio() {
    if (lock === "free") return null;
    if (lock === "original") return rotW() / rotH();
    const [w, h] = lock.split(":").map(Number);
    return w / h;
  }

  // --- view -----------------------------------------------------------------

  function visibleWorld() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    return {
      minX: (EDGE_INSET - offX) / scale,
      minY: (EDGE_INSET - offY) / scale,
      maxX: (sw - EDGE_INSET - offX) / scale,
      maxY: (sh - EDGE_INSET - offY) / scale,
    };
  }

  function fitView() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!sw || !sh) return;
    const x0 = Math.min(0, crop.x);
    const y0 = Math.min(0, crop.y);
    const x1 = Math.max(rotW(), crop.x + crop.w);
    const y1 = Math.max(rotH(), crop.y + crop.h);
    const pad = VIEW_PAD * Math.max(x1 - x0, y1 - y0);
    const vw = x1 - x0 + pad * 2;
    const vh = y1 - y0 + pad * 2;
    scale = Math.min(sw / vw, sh / vh);
    offX = (sw - (x1 - x0) * scale) / 2 - x0 * scale;
    offY = (sh - (y1 - y0) * scale) / 2 - y0 * scale;
    render();
  }

  function render() {
    // The <img> is laid out at its natural aspect and rotated about its own
    // center, which is pinned to the center of the rotated image's rect.
    const cx = offX + (rotW() / 2) * scale;
    const cy = offY + (rotH() / 2) * scale;
    const w = natW * scale;
    const h = natH * scale;
    Object.assign(imgEl.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${cx - w / 2}px`,
      top: `${cy - h / 2}px`,
      transform: `rotate(${rotation}deg)`,
    });
    const box = {
      left: `${offX + crop.x * scale}px`,
      top: `${offY + crop.y * scale}px`,
      width: `${crop.w * scale}px`,
      height: `${crop.h * scale}px`,
    };
    Object.assign(cropEl.style, box);
    Object.assign(fillEl.style, box);
    fillEl.classList.toggle("pp-fill-blur", fill.mode === "blur");
    fillEl.style.background = fill.mode === "color" ? fill.color : "";
    const label = `${Math.round(crop.w)} × ${Math.round(crop.h)}`;
    readoutEl.textContent = label;
    sizeEl.textContent = `${label} px`;
  }

  // --- crop constraints -------------------------------------------------------

  // Must overlap the image at least a little (the server rejects a crop that
  // misses it entirely), and stay within the size limits.
  function isValid(r) {
    if (r.w < MIN_CROP || r.h < MIN_CROP) return false;
    if (r.w > MAX_SIDE || r.h > MAX_SIDE || r.w * r.h > MAX_PIXELS) return false;
    return Math.min(r.x + r.w, rotW()) - Math.max(r.x, 0) >= 1 && Math.min(r.y + r.h, rotH()) - Math.max(r.y, 0) >= 1;
  }

  function moveCrop(start, dx, dy) {
    const v = visibleWorld();
    const xMin = Math.max(v.minX, -(start.w - 1));
    const xMax = Math.min(v.maxX - start.w, rotW() - 1);
    const yMin = Math.max(v.minY, -(start.h - 1));
    const yMax = Math.min(v.maxY - start.h, rotH() - 1);
    return {
      x: xMax < xMin ? start.x : clamp(start.x + dx, xMin, xMax),
      y: yMax < yMin ? start.y : clamp(start.y + dy, yMin, yMax),
      w: start.w,
      h: start.h,
    };
  }

  function resizeCrop(start, handle, dx, dy) {
    const v = visibleWorld();
    const ratio = lockRatio();
    const west = handle.includes("w");
    const east = handle.includes("e");
    const north = handle.includes("n");
    const south = handle.includes("s");
    const isCorner = (west || east) && (north || south);

    if (!ratio) {
      let l = start.x;
      let r = start.x + start.w;
      let t = start.y;
      let b = start.y + start.h;
      if (west) l = clamp(l + dx, v.minX, r - MIN_CROP);
      if (east) r = clamp(r + dx, l + MIN_CROP, v.maxX);
      if (north) t = clamp(t + dy, v.minY, b - MIN_CROP);
      if (south) b = clamp(b + dy, t + MIN_CROP, v.maxY);
      return { x: l, y: t, w: r - l, h: b - t };
    }

    if (isCorner) {
      // Anchored at the opposite corner; grows to whichever axis the pointer went further on.
      const ax = west ? start.x + start.w : start.x;
      const ay = north ? start.y + start.h : start.y;
      const px = (west ? start.x : start.x + start.w) + dx;
      const py = (north ? start.y : start.y + start.h) + dy;
      let w = Math.abs(px - ax);
      let h = Math.abs(py - ay);
      if (w / ratio > h) h = w / ratio;
      else w = h * ratio;
      const maxW = Math.min(west ? ax - v.minX : v.maxX - ax, (north ? ay - v.minY : v.maxY - ay) * ratio);
      w = clamp(w, MIN_CROP, Math.max(MIN_CROP, maxW));
      h = w / ratio;
      return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
    }

    if (west || east) {
      const ax = west ? start.x + start.w : start.x;
      const cy = start.y + start.h / 2;
      const halfRoom = Math.min(cy - v.minY, v.maxY - cy);
      const maxW = Math.min(west ? ax - v.minX : v.maxX - ax, halfRoom * 2 * ratio);
      const w = clamp(start.w + (west ? -dx : dx), MIN_CROP, Math.max(MIN_CROP, maxW));
      const h = w / ratio;
      return { x: west ? ax - w : ax, y: cy - h / 2, w, h };
    }

    const ay = north ? start.y + start.h : start.y;
    const cx = start.x + start.w / 2;
    const halfRoom = Math.min(cx - v.minX, v.maxX - cx);
    const maxH = Math.min(north ? ay - v.minY : v.maxY - ay, (halfRoom * 2) / ratio);
    const h = clamp(start.h + (north ? -dy : dy), MIN_CROP, Math.max(MIN_CROP, maxH));
    const w = h * ratio;
    return { x: cx - w / 2, y: north ? ay - h : ay, w, h };
  }

  // Shrinks the current crop (about its center) to the target ratio, so
  // choosing a ratio never grows the region or pushes it off-screen.
  function conformCropToLock() {
    const ratio = lockRatio();
    if (!ratio) return;
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    let w = crop.w;
    let h = crop.h;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    crop = { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  // --- gestures ---------------------------------------------------------------

  let drag = null; // { handle | null, startPointer: {x,y}, startCrop }
  cropEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    drag = { handle: evt.target.dataset.handle || null, startPointer: { x: evt.clientX, y: evt.clientY }, startCrop: { ...crop } };
    cropEl.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });
  cropEl.addEventListener("pointermove", (evt) => {
    if (!drag) return;
    const dx = (evt.clientX - drag.startPointer.x) / scale;
    const dy = (evt.clientY - drag.startPointer.y) / scale;
    const next = drag.handle ? resizeCrop(drag.startCrop, drag.handle, dx, dy) : moveCrop(drag.startCrop, dx, dy);
    if (isValid(next)) {
      crop = next;
      render();
    }
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    fitView();
  }
  cropEl.addEventListener("pointerup", endDrag);
  cropEl.addEventListener("pointercancel", endDrag);

  // --- toolbar ---------------------------------------------------------------

  // A 90-degree turn is a rotation of the whole plane about the image, so the
  // crop keeps covering the same image content (padding included).
  function rotate(clockwise) {
    const W = rotW();
    const H = rotH();
    const { x, y, w, h } = crop;
    crop = clockwise ? { x: H - (y + h), y: x, w: h, h: w } : { x: y, y: W - (x + w), w: h, h: w };
    rotation = (rotation + (clockwise ? 90 : 270)) % 360;
    if (lock === "original") conformCropToLock();
    fitView();
  }

  function reset() {
    rotation = 0;
    crop = { x: 0, y: 0, w: natW, h: natH };
    lock = "free";
    aspectSel.value = lock;
    fitView();
  }

  function syncFillControls() {
    fillModeSel.value = fill.mode;
    fillColorInput.value = fill.color;
    fillColorInput.style.display = fill.mode === "color" ? "" : "none";
  }

  aspectSel.addEventListener("change", () => {
    lock = aspectSel.value;
    conformCropToLock();
    fitView();
  });
  fillModeSel.addEventListener("change", () => {
    fill = { ...fill, mode: fillModeSel.value };
    syncFillControls();
    saveFillPref(fill);
    render();
  });
  fillColorInput.addEventListener("input", () => {
    fill = { ...fill, color: fillColorInput.value };
    saveFillPref(fill);
    render();
  });

  function currentParams() {
    return {
      rotation,
      crop: { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) },
      fill: { mode: fill.mode, color: fill.color },
    };
  }

  async function apply() {
    applyBtn.disabled = true;
    const label = applyBtn.textContent;
    applyBtn.textContent = "Applying…";
    errorEl.textContent = "";
    try {
      await onApply(currentParams());
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = label;
    }
  }

  controlsHost.addEventListener("click", (evt) => {
    const act = evt.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "rotate-cw") rotate(true);
    else if (act === "rotate-ccw") rotate(false);
    else if (act === "reset") reset();
    else if (act === "cancel") onCancel();
    else if (act === "apply") apply();
  });

  document.addEventListener("keydown", (evt) => {
    if (!opened) return;
    const tag = evt.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (evt.key === "Escape") onCancel();
    else if (evt.key === "Enter" && tag !== "BUTTON") apply(); // a focused button already handles Enter itself
    else return;
    evt.preventDefault();
  });

  new ResizeObserver(() => {
    if (opened) fitView();
  }).observe(stage);

  // --- lifecycle -------------------------------------------------------------

  return {
    isOpen: () => opened,
    /** imageUrl: the untouched source. params: existing settings, or null. */
    async open(imageUrl, params) {
      opened = true;
      errorEl.textContent = "";
      imgEl.style.visibility = "hidden";
      await new Promise((resolve, reject) => {
        imgEl.onload = resolve;
        imgEl.onerror = () => reject(new Error("Could not load the source image"));
        imgEl.src = imageUrl;
      });
      if (!opened) return; // closed while the image was loading
      natW = imgEl.naturalWidth;
      natH = imgEl.naturalHeight;
      if (params) {
        rotation = params.rotation || 0;
        crop = { ...params.crop };
        fill = { ...params.fill };
      } else {
        rotation = 0;
        crop = { x: 0, y: 0, w: natW, h: natH };
        fill = loadFillPref();
      }
      lock = "free";
      aspectSel.value = lock;
      syncFillControls();
      imgEl.style.visibility = "";
      fitView();
    },
    close() {
      opened = false;
      drag = null;
    },
    refit: fitView,
  };
}
