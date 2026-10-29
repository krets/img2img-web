/** Client-side equivalent of preprocess.py's render(): rotates imgEl by an
 * arbitrary angle, crops to a region that may extend past the rotated
 * image's edges (and, for a non-90-degree angle, past the small transparent
 * corner gaps the rotation itself opens up), and fills that overhang with
 * whichever mode is selected. Returns a PNG Blob, ready to upload as the
 * processed render -- see api.js's setImagePreprocess.
 *
 * Kept in step with preprocess.py's render() (the server-side fallback for
 * when there's no browser render to fall back on): same four fill modes,
 * same "fill shows through wherever the rotated image is transparent"
 * compositing idea. Not pixel-identical (canvas and Pillow resample/blur
 * differently) -- that's fine, nothing depends on the two matching exactly,
 * only on both looking right.
 */
const BLUR_WORK_DIM = 256;
const BLUR_RADIUS_DIVISOR = 25;

export function rotatedBoundingSize(width, height, rotationDeg) {
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { w: width * c + height * s, h: width * s + height * c };
}

export async function renderPreprocessed(imgEl, params) {
  const { rotation, crop, fill } = params;
  const iw = imgEl.naturalWidth;
  const ih = imgEl.naturalHeight;

  // 1. Rotate onto a transparent canvas sized to the rotated bounding box.
  const { w: rwF, h: rhF } = rotatedBoundingSize(iw, ih, rotation);
  const rw = Math.round(rwF);
  const rh = Math.round(rhF);
  const rotCanvas = document.createElement("canvas");
  rotCanvas.width = rw;
  rotCanvas.height = rh;
  const rctx = rotCanvas.getContext("2d");
  rctx.translate(rw / 2, rh / 2);
  rctx.rotate((rotation * Math.PI) / 180);
  rctx.drawImage(imgEl, -iw / 2, -ih / 2);

  // 2. Crop (x, y, w, h) out of that canvas, filling whatever doesn't land on it.
  const { x, y, w, h } = crop;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");

  const ix0 = Math.max(x, 0);
  const iy0 = Math.max(y, 0);
  const ix1 = Math.min(x + w, rw);
  const iy1 = Math.min(y + h, rh);
  const regionW = Math.max(0, ix1 - ix0);
  const regionH = Math.max(0, iy1 - iy0);
  const destX = ix0 - x;
  const destY = iy0 - y;

  const needsFill = regionW !== w || regionH !== h || hasTransparency(rctx, ix0, iy0, regionW, regionH);
  if (needsFill) {
    if (fill.mode === "color") {
      ctx.fillStyle = fill.color;
      ctx.fillRect(0, 0, w, h);
    } else if (fill.mode === "extend") {
      edgeExtendFill(ctx, rotCanvas, ix0, iy0, regionW, regionH, destX, destY, w, h);
    } else if (fill.mode === "edge_color") {
      ctx.fillStyle = predominantEdgeColor(rctx, ix0, iy0, regionW, regionH, destX, destY, w, h);
      ctx.fillRect(0, 0, w, h);
    } else {
      await blurredCoverFill(ctx, rotCanvas, w, h);
    }
  }
  if (regionW > 0 && regionH > 0) {
    ctx.drawImage(rotCanvas, ix0, iy0, regionW, regionH, destX, destY, regionW, regionH);
  }

  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

function hasTransparency(srcCtx, sx, sy, sw, sh) {
  if (sw <= 0 || sh <= 0) return false;
  const data = srcCtx.getImageData(sx, sy, sw, sh).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

// Pads the overhang by replicating region's own boundary pixels outward --
// each strip stretched (nearest-neighbor) from the single row/column of the
// rotated canvas it borders, and the four corners from its corner pixel.
// Mirrors preprocess.py's _edge_extend.
function edgeExtendFill(ctx, src, ix0, iy0, regionW, regionH, left, top, w, h) {
  if (regionW <= 0 || regionH <= 0) return;
  const right = w - left - regionW;
  const bottom = h - top - regionH;
  const ix1 = ix0 + regionW;
  const iy1 = iy0 + regionH;
  ctx.imageSmoothingEnabled = false;
  if (left > 0) ctx.drawImage(src, ix0, iy0, 1, regionH, 0, top, left, regionH);
  if (right > 0) ctx.drawImage(src, ix1 - 1, iy0, 1, regionH, left + regionW, top, right, regionH);
  if (top > 0) ctx.drawImage(src, ix0, iy0, regionW, 1, left, 0, regionW, top);
  if (bottom > 0) ctx.drawImage(src, ix0, iy1 - 1, regionW, 1, left, top + regionH, regionW, bottom);
  if (left > 0 && top > 0) ctx.drawImage(src, ix0, iy0, 1, 1, 0, 0, left, top);
  if (right > 0 && top > 0) ctx.drawImage(src, ix1 - 1, iy0, 1, 1, left + regionW, 0, right, top);
  if (left > 0 && bottom > 0) ctx.drawImage(src, ix0, iy1 - 1, 1, 1, 0, top + regionH, left, bottom);
  if (right > 0 && bottom > 0) ctx.drawImage(src, ix1 - 1, iy1 - 1, 1, 1, left + regionW, top + regionH, right, bottom);
  ctx.imageSmoothingEnabled = true;
}

// The most common opaque color among the same boundary strips edgeExtendFill
// stretches -- mirrors preprocess.py's _predominant_edge_color.
function predominantEdgeColor(srcCtx, ix0, iy0, regionW, regionH, left, top, w, h) {
  const right = w - left - regionW;
  const bottom = h - top - regionH;
  const counts = new Map();
  const tally = (sx, sy, sw, sh) => {
    if (sw <= 0 || sh <= 0) return;
    const data = srcCtx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) continue; // skip transparent (corner-gap) pixels
      const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  };
  if (left > 0) tally(ix0, iy0, 1, regionH);
  if (right > 0) tally(ix0 + regionW - 1, iy0, 1, regionH);
  if (top > 0) tally(ix0, iy0, regionW, 1);
  if (bottom > 0) tally(ix0, iy0 + regionH - 1, regionW, 1);
  if (counts.size === 0) tally(ix0, iy0, regionW, regionH);
  let best = "0,0,0";
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  return `rgb(${best})`;
}

// A heavily blurred copy of src (the whole rotated canvas, flattened onto
// white where transparent) scaled to cover (w, h) -- aspect preserved,
// center-cropped, no letterboxing left for the blur to expose. Mirrors
// preprocess.py's _blurred_cover.
async function blurredCoverFill(ctx, src, w, h) {
  const k = Math.min(1, BLUR_WORK_DIM / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  const scale = Math.max(sw / src.width, sh / src.height);
  const cw = Math.max(sw, Math.ceil(src.width * scale));
  const ch = Math.max(sh, Math.ceil(src.height * scale));

  const flat = document.createElement("canvas");
  flat.width = src.width;
  flat.height = src.height;
  const fctx = flat.getContext("2d");
  fctx.fillStyle = "#ffffff";
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(src, 0, 0);

  const scaled = document.createElement("canvas");
  scaled.width = cw;
  scaled.height = ch;
  scaled.getContext("2d").drawImage(flat, 0, 0, cw, ch);

  const left = Math.floor((cw - sw) / 2);
  const top = Math.floor((ch - sh) / 2);
  const blurRadius = Math.max(sw, sh) / BLUR_RADIUS_DIVISOR;
  const blurred = document.createElement("canvas");
  blurred.width = sw;
  blurred.height = sh;
  const bctx = blurred.getContext("2d");
  bctx.filter = `blur(${blurRadius}px)`;
  bctx.drawImage(scaled, left, top, sw, sh, 0, 0, sw, sh);

  ctx.drawImage(blurred, 0, 0, sw, sh, 0, 0, w, h);
}
