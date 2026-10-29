"""Non-destructive source-image pre-processing: rotate by an arbitrary angle,
then crop to a region that may extend past the rotated image's edges (the
overhang -- and, for a non-90-degree angle, the small transparent corner gaps
the rotation itself opens up -- is padded with either a solid color or a
heavily blurred copy of the image).

The browser renders this now (see static/js/preprocess_render.js) and uploads
the result directly, so the normal edit/apply path never touches this module
-- an image only carries the small parameter dict below (images.preprocess,
as JSON), and storage.save_processed_render just persists whatever bytes the
browser sent. render() below exists as a server-side fallback for when there's
no browser render to fall back on: a cache miss (storage.get_or_create_processed),
or reconstructing a historical result's exact source from its source_preprocess
snapshot. Keeping both implementations behaving the same is the point of this
module's docstring and the one at the top of preprocess_render.js.

Params (all pixel values are in the *rotated* image's coordinate space, so
they mean the same thing on screen as in the render):
    {
      "rotation": float,          # clockwise degrees, any value
      "crop": {"x": int, "y": int, "w": int, "h": int},
      "fill": {"mode": "blur" | "color" | "extend" | "edge_color", "color": "#rrggbb"},
    }
"""

import hashlib
import json
import math
from collections import Counter

from PIL import Image, ImageFilter

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
    """The bounding box of width x height rotated by `rotation` degrees (like
    PIL's Image.rotate(expand=True)). Exact for multiples of 90 -- the usual
    cos/sin float error rounds away cleanly -- and otherwise the same formula
    any renderer (this module, preprocess_render.js) needs to agree on, since
    it's what crop coordinates are validated against.
    """
    rad = math.radians(rotation)
    c, s = abs(math.cos(rad)), abs(math.sin(rad))
    return round(width * c + height * s), round(width * s + height * c)


def normalize(params, width, height):
    """Validates params against the source's pixel size and returns a canonical
    dict, or None when they'd be a no-op (no rotation, crop == the whole
    image). Raises ValueError with a user-presentable message otherwise.
    """
    if not params:
        return None
    try:
        rotation = round(float(params.get("rotation") or 0) % 360, 2)
    except (TypeError, ValueError):
        raise ValueError("rotation must be a number") from None
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
    """Applies params to a PIL image and returns the processed RGB image.
    Multiples of 90 use a lossless transpose, same as always; any other angle
    resamples via rotate(expand=True), which (unlike a transpose) also opens
    small transparent gaps at the rotated canvas's corners -- those get filled
    exactly like crop overhang, since visually they're the same kind of
    "nothing here" region. See preprocess_render.js for the client-side
    equivalent this exists as a fallback for.
    """
    img = img.convert("RGBA")
    rotation = params["rotation"] % 360
    if rotation % 90 == 0:
        transpose = _ROTATE_TRANSPOSE.get(int(rotation))
        rotated = img.transpose(transpose) if transpose is not None else img
    else:
        rotated = img.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)

    c = params["crop"]
    x, y, w, h = c["x"], c["y"], c["w"], c["h"]
    rw, rh = rotated.size

    # The part of the crop that actually lands on the rotated canvas, in its coords.
    ix0, iy0 = max(x, 0), max(y, 0)
    ix1, iy1 = min(x + w, rw), min(y + h, rh)
    region = rotated.crop((ix0, iy0, ix1, iy1))
    dest = (ix0 - x, iy0 - y)
    if region.size == (w, h) and not _has_transparency(region):
        return region.convert("RGB")  # crop sits entirely inside solid pixels: no padding to fill

    fill = params["fill"]
    mode = fill["mode"]
    # Border-sampling fill modes read region.convert("RGB"): a transparent
    # corner-gap pixel converts to whatever RGB value PIL carried under the
    # dropped alpha (not meaningful), so a crop whose border happens to land
    # exactly on a gap can pick up a slightly off sample there -- a narrow
    # edge case, same risk the client-side renderer accepts for the same reason.
    region_rgb = region.convert("RGB")
    if mode == "color":
        canvas = Image.new("RGB", (w, h), _parse_color(fill["color"]))
    elif mode == "extend":
        # Backstop for a transparent gap inside the region itself -- an
        # off-90° rotation can open small ones at the corners, and
        # _edge_extend below only paints the outer margin, not those.
        base = Image.new("RGB", (w, h), _predominant_edge_color(region_rgb, dest[0], dest[1], w, h))
        canvas = _edge_extend(region_rgb, dest[0], dest[1], w, h, base=base)
    elif mode == "edge_color":
        canvas = Image.new("RGB", (w, h), _predominant_edge_color(region_rgb, dest[0], dest[1], w, h))
    else:
        canvas = _blurred_cover(_flatten_white(rotated), (w, h))
    canvas = canvas.convert("RGBA")
    canvas.alpha_composite(region, dest=dest)
    return canvas.convert("RGB")


def _has_transparency(region):
    return region.mode == "RGBA" and region.getextrema()[3][0] < 255


def _flatten_white(img_rgba):
    bg = Image.new("RGB", img_rgba.size, (255, 255, 255))
    bg.paste(img_rgba, mask=img_rgba.split()[3])
    return bg


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


def _edge_extend(region, left, top, w, h, base=None):
    """Pads region out to (w, h) by replicating its boundary pixels outward:
    each strip of padding is stretched from the single row/column of region
    pixels it borders, and the four corners from region's corner pixel. base,
    if given, is painted onto instead of a fresh (black) canvas -- a backstop
    for any transparent gap inside region itself, which this only ever covers
    at its outer margin.
    """
    rw, rh = region.size
    right, bottom = w - left - rw, h - top - rh
    canvas = base if base is not None else Image.new("RGB", (w, h))
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
