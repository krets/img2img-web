"""Local aspect-ratio fitting for engines that don't accept an aspect_ratio
request parameter (ComfyUI, fal.ai). Unlike the Grok API, which reframes the
output itself, those engines only ever return an image shaped like whatever
they're given -- so to make the aspect-ratio picker do something useful for
them, the source image is crop- or expand-fit to the target ratio locally
before it's uploaded.

Two modes:
  - "crop": cuts the image down to the target ratio, measuring the kept
    region from the pinned corner/center (see _pin_offsets).
  - "expand": grows the canvas to the target ratio and fills the new space
    with a heavily blurred, stretched copy of the image, then overlays the
    original (untouched, uncropped) at the pinned position.
"""

import os
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

PIN_POSITIONS = ("center", "top-left", "top-right", "bottom-left", "bottom-right")
DEFAULT_PIN = "center"
DEFAULT_MODE = "crop"


def parse_ratio(aspect_ratio):
    w, h = aspect_ratio.split(":")
    return float(w) / float(h)


def _pin_offsets(pin, slack_x, slack_y):
    """slack_x/slack_y are the leftover space (canvas minus content) along
    each axis. Returns the (x, y) offset of the content's top-left corner.
    """
    if pin not in PIN_POSITIONS:
        pin = DEFAULT_PIN
    x = 0 if "left" in pin else slack_x if "right" in pin else slack_x / 2
    y = 0 if "top" in pin else slack_y if "bottom" in pin else slack_y / 2
    return x, y


def fit_to_aspect_ratio(img, aspect_ratio, mode=DEFAULT_MODE, pin=DEFAULT_PIN):
    """Returns an image matching aspect_ratio ("W:H"), either by cropping into
    img (mode="crop") or by expanding the canvas and filling the new space
    with a blurred copy of img (mode="expand"). Returns img unchanged if it
    already matches the target ratio closely enough.
    """
    target_ratio = parse_ratio(aspect_ratio)
    orig_w, orig_h = img.size
    orig_ratio = orig_w / orig_h
    if abs(orig_ratio - target_ratio) < 1e-3:
        return img
    if mode == "expand":
        return _expand(img, target_ratio, pin)
    return _crop(img, target_ratio, pin)


def _crop(img, target_ratio, pin):
    orig_w, orig_h = img.size
    orig_ratio = orig_w / orig_h
    if orig_ratio > target_ratio:
        crop_h = orig_h
        crop_w = round(orig_h * target_ratio)
    else:
        crop_w = orig_w
        crop_h = round(orig_w / target_ratio)
    x, y = _pin_offsets(pin, orig_w - crop_w, orig_h - crop_h)
    x, y = round(x), round(y)
    return img.crop((x, y, x + crop_w, y + crop_h))


def _expand(img, target_ratio, pin):
    orig_w, orig_h = img.size
    orig_ratio = orig_w / orig_h
    if target_ratio > orig_ratio:
        canvas_w, canvas_h = round(orig_h * target_ratio), orig_h
    else:
        canvas_w, canvas_h = orig_w, round(orig_w / target_ratio)

    # Stretch-fill the whole canvas so there's no letterboxing left behind
    # for the blur to expose, then blur it heavily -- the distortion from
    # stretching a non-matching ratio is imperceptible once blurred this hard.
    background = img.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
    blur_radius = max(canvas_w, canvas_h) / 25
    background = background.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    x, y = _pin_offsets(pin, canvas_w - orig_w, canvas_h - orig_h)
    background.paste(img, (round(x), round(y)))
    return background


def prepare_source_file(source_path, aspect_ratio, mode=DEFAULT_MODE, pin=DEFAULT_PIN):
    """Fits the image at source_path to aspect_ratio and writes the result to
    a new temp PNG file, returning its Path. Returns None if the image
    already matches the target ratio (caller should keep using source_path).
    Caller owns the returned file and must delete it once done.
    """
    with Image.open(source_path) as img:
        img.load()
        fitted = fit_to_aspect_ratio(img, aspect_ratio, mode, pin)
        if fitted is img:
            return None
        if fitted.mode not in ("RGB", "RGBA"):
            fitted = fitted.convert("RGB")
        fd, tmp_name = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        tmp_path = Path(tmp_name)
        fitted.save(tmp_path, format="PNG")
        return tmp_path
