"""Non-destructive source-image pre-processing: rotate in 90-degree steps, then
crop to a region that may extend past the image's edges (the overhang is
padded with either a solid color or a heavily blurred copy of the image).

The stored source file is never modified. An image only carries the small
parameter dict below (images.preprocess, as JSON); the processed pixels are
rendered on demand into a cache (see storage.get_or_create_processed) and
that render is what gets sent to the generation engine and shown in the viewer.

Params (all pixel values are in the *rotated* image's coordinate space, so
they mean the same thing on screen as in the render):
    {
      "rotation": 0 | 90 | 180 | 270,          # clockwise
      "crop": {"x": int, "y": int, "w": int, "h": int},
      "fill": {"mode": "blur" | "color" | "extend" | "edge_color", "color": "#rrggbb"},
    }
"""

import hashlib
import json
import math
from collections import Counter

from PIL import Image, ImageFilter

ROTATIONS = (0, 90, 180, 270)
FILL_MODES = ("blur", "color", "extend", "edge_color")
DEFAULT_FILL = {"mode": "blur", "color": "#000000"}

# Generous, but keeps a fat-fingered crop from asking PIL for a multi-GB canvas.
MAX_SIDE = 12000
MAX_PIXELS = 60_000_000

# The blurred fill is built from a downscaled copy: past a certain radius a
# gaussian blur hides all detail anyway, so blurring ~256px and scaling back
# up looks the same as blurring the full canvas but costs almost nothing.
BLUR_WORK_DIM = 256
BLUR_RADIUS_DIVISOR = 25

_ROTATE_TRANSPOSE = {
    90: Image.Transpose.ROTATE_270,  # PIL's ROTATE_* constants are counter-clockwise
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}


def rotated_size(width, height, rotation):
    return (height, width) if rotation in (90, 270) else (width, height)


def normalize(params, width, height):
    """Validates params against the source's pixel size and returns a canonical
    dict, or None when they'd be a no-op (no rotation, crop == the whole
    image). Raises ValueError with a user-presentable message otherwise.
    """
    if not params:
        return None
    rotation = int(params.get("rotation") or 0)
    if rotation not in ROTATIONS:
        raise ValueError("rotation must be 0, 90, 180, or 270")
    rw, rh = rotated_size(width, height, rotation)

    crop = params.get("crop") or {"x": 0, "y": 0, "w": rw, "h": rh}
    x, y, w, h = (int(crop[k]) for k in ("x", "y", "w", "h"))
    if w < 1 or h < 1:
        raise ValueError("crop must be at least 1x1 pixel")
    if w > MAX_SIDE or h > MAX_SIDE or w * h > MAX_PIXELS:
        raise ValueError(f"crop is too large (max {MAX_SIDE}px per side, {MAX_PIXELS // 1_000_000}MP total)")
    if x >= rw or y >= rh or x + w <= 0 or y + h <= 0:
        raise ValueError("crop must overlap the image")

    fill_in = params.get("fill") or {}
    mode = fill_in.get("mode") or DEFAULT_FILL["mode"]
    if mode not in FILL_MODES:
        raise ValueError("fill mode must be 'blur', 'color', 'extend', or 'edge_color'")
    color = (fill_in.get("color") or DEFAULT_FILL["color"]).lower()
    _parse_color(color)

    if rotation == 0 and (x, y, w, h) == (0, 0, rw, rh):
        return None
    return {
        "rotation": rotation,
        "crop": {"x": x, "y": y, "w": w, "h": h},
        "fill": {"mode": mode, "color": color},
    }


def _parse_color(color):
    if not (isinstance(color, str) and len(color) == 7 and color[0] == "#"):
        raise ValueError("fill color must look like #rrggbb")
    try:
        return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        raise ValueError("fill color must look like #rrggbb") from None


def cache_key(params):
    """Stable short id for a params dict -- the cache file name is derived from
    it, so identical params always hit the same rendered file.
    """
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


def render(img, params):
    """Applies params to a PIL image and returns the processed RGB image."""
    img = img.convert("RGB")
    transpose = _ROTATE_TRANSPOSE.get(params["rotation"])
    if transpose is not None:
        img = img.transpose(transpose)

    c = params["crop"]
    x, y, w, h = c["x"], c["y"], c["w"], c["h"]
    iw, ih = img.size

    # The part of the crop that actually lands on image pixels, in image coords.
    ix0, iy0 = max(x, 0), max(y, 0)
    ix1, iy1 = min(x + w, iw), min(y + h, ih)
    region = img.crop((ix0, iy0, ix1, iy1))
    if (ix1 - ix0, iy1 - iy0) == (w, h):
        return region  # crop sits entirely inside the image: no padding to fill

    fill = params["fill"]
    mode = fill["mode"]
    if mode == "color":
        canvas = Image.new("RGB", (w, h), _parse_color(fill["color"]))
    elif mode == "extend":
        canvas = _edge_extend(region, ix0 - x, iy0 - y, w, h)
    elif mode == "edge_color":
        canvas = Image.new("RGB", (w, h), _predominant_edge_color(region, ix0 - x, iy0 - y, w, h))
    else:
        canvas = _blurred_cover(img, (w, h))
    canvas.paste(region, (ix0 - x, iy0 - y))
    return canvas


def _blurred_cover(img, size):
    """A heavily blurred copy of img scaled (aspect preserved, center-cropped)
    to fully cover `size` -- no letterboxing left for the blur to expose.
    """
    w, h = size
    k = min(1.0, BLUR_WORK_DIM / max(w, h))
    sw, sh = max(1, round(w * k)), max(1, round(h * k))
    scale = max(sw / img.width, sh / img.height)
    cw, ch = max(sw, math.ceil(img.width * scale)), max(sh, math.ceil(img.height * scale))
    small = img.resize((cw, ch), Image.Resampling.LANCZOS)
    left, top = (cw - sw) // 2, (ch - sh) // 2
    small = small.crop((left, top, left + sw, top + sh))
    small = small.filter(ImageFilter.GaussianBlur(radius=max(sw, sh) / BLUR_RADIUS_DIVISOR))
    return small.resize((w, h), Image.Resampling.BICUBIC)


def _edge_extend(region, left, top, w, h):
    """Pads region out to (w, h) by replicating its boundary pixels outward:
    each strip of padding is stretched from the single row/column of region
    pixels it borders, and the four corners from region's corner pixel.
    """
    rw, rh = region.size
    right, bottom = w - left - rw, h - top - rh
    canvas = Image.new("RGB", (w, h))
    if left > 0:
        canvas.paste(region.crop((0, 0, 1, rh)).resize((left, rh), Image.Resampling.NEAREST), (0, top))
    if right > 0:
        canvas.paste(region.crop((rw - 1, 0, rw, rh)).resize((right, rh), Image.Resampling.NEAREST), (left + rw, top))
    if top > 0:
        canvas.paste(region.crop((0, 0, rw, 1)).resize((rw, top), Image.Resampling.NEAREST), (left, 0))
    if bottom > 0:
        canvas.paste(region.crop((0, rh - 1, rw, rh)).resize((rw, bottom), Image.Resampling.NEAREST), (left, top + rh))
    if left > 0 and top > 0:
        canvas.paste(region.crop((0, 0, 1, 1)).resize((left, top), Image.Resampling.NEAREST), (0, 0))
    if right > 0 and top > 0:
        canvas.paste(region.crop((rw - 1, 0, rw, 1)).resize((right, top), Image.Resampling.NEAREST), (left + rw, 0))
    if left > 0 and bottom > 0:
        canvas.paste(region.crop((0, rh - 1, 1, rh)).resize((left, bottom), Image.Resampling.NEAREST), (0, top + rh))
    if right > 0 and bottom > 0:
        canvas.paste(
            region.crop((rw - 1, rh - 1, rw, rh)).resize((right, bottom), Image.Resampling.NEAREST),
            (left + rw, top + rh),
        )
    return canvas


def _predominant_edge_color(region, left, top, w, h):
    """The most common color among the boundary pixels of region that face
    padding -- the same rows/columns an "extend" fill would stretch outward,
    collapsed here into a single solid color instead of stretched individually.
    """
    rw, rh = region.size
    right, bottom = w - left - rw, h - top - rh
    pixels = []
    if left > 0:
        pixels.extend(region.crop((0, 0, 1, rh)).getdata())
    if right > 0:
        pixels.extend(region.crop((rw - 1, 0, rw, rh)).getdata())
    if top > 0:
        pixels.extend(region.crop((0, 0, rw, 1)).getdata())
    if bottom > 0:
        pixels.extend(region.crop((0, rh - 1, rw, rh)).getdata())
    if not pixels:
        pixels = list(region.getdata())
    return Counter(pixels).most_common(1)[0][0]
