"""Synthetic fixtures for tuning near-duplicate detection (dupes.py).

Generates structured "scenes" (gradients, overlapping shapes, blur, noise) and
the edits a real library accumulates: recompression, resizes, small crops,
colour shifts, and a 90 degree rotation, which perceptual hashes are not meant
to survive. Deterministic for a given seed.

Run directly for the distance report used to pick dupes.DEFAULT_THRESHOLD:

    python -m tests.hash_fixtures [n_bases]
"""

import io
import math
import random
import sys
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SIZES = [(512, 512), (416, 608), (608, 416), (384, 672), (512, 384)]


def scene(rnd, w, h):
    img = Image.new("RGB", (w, h), tuple(rnd.randint(0, 255) for _ in range(3)))
    arr = np.asarray(img, dtype=float)
    ramp = np.linspace(0, 1, w)[None, :, None] if rnd.random() < 0.5 else np.linspace(0, 1, h)[:, None, None]
    img = Image.fromarray((arr * (0.5 + 0.5 * ramp) + rnd.randint(0, 60)).clip(0, 255).astype("uint8"))
    d = ImageDraw.Draw(img)
    for _ in range(rnd.randint(6, 25)):
        x0, y0 = rnd.randint(-w // 4, w), rnd.randint(-h // 4, h)
        x1, y1 = x0 + rnd.randint(w // 12, w // 2), y0 + rnd.randint(h // 12, h // 2)
        col = tuple(rnd.randint(0, 255) for _ in range(3))
        shape = rnd.choice(["ellipse", "rect", "line", "poly"])
        if shape == "ellipse":
            d.ellipse([x0, y0, x1, y1], fill=col)
        elif shape == "rect":
            d.rectangle([x0, y0, x1, y1], fill=col)
        elif shape == "line":
            d.line([x0, y0, x1, y1], fill=col, width=rnd.randint(3, 20))
        else:
            d.polygon([(rnd.randint(0, w), rnd.randint(0, h)) for _ in range(rnd.randint(3, 6))], fill=col)
    img = img.filter(ImageFilter.GaussianBlur(rnd.uniform(0.5, 3)))
    noise = np.random.default_rng(rnd.randint(0, 1 << 30)).normal(0, 8, (h, w, 3))
    return Image.fromarray((np.asarray(img, dtype=float) + noise).clip(0, 255).astype("uint8"))


def jpeg(img, quality):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def crop_edges(img, frac, sides="all"):
    dx, dy = max(1, round(img.width * frac)), max(1, round(img.height * frac))
    if sides == "all":
        return img.crop((dx, dy, img.width - dx, img.height - dy))
    return img.crop((0, 0, img.width - dx, img.height))  # one edge: aspect changes by ~frac


def hue_shift(img, degrees):
    hsv = np.asarray(img.convert("HSV")).copy()
    hsv[..., 0] = (hsv[..., 0].astype(int) + round(degrees * 255 / 360)) % 256
    return Image.fromarray(hsv, "HSV").convert("RGB")


# name -> (transform, expectation at dupes.DEFAULT_THRESHOLD):
#   "all"  every edited copy pairs with its original
#   "most" at least 90% do, and all are within the slider's maximum (16)
#   None   a different picture as far as the hash is concerned
TRANSFORMS = {
    "jpeg_q90": (lambda im: jpeg(im, 90), "all"),
    "jpeg_q60": (lambda im: jpeg(im, 60), "all"),
    "jpeg_q30": (lambda im: jpeg(im, 30), "all"),
    "resize_50": (lambda im: im.resize((im.width // 2, im.height // 2), Image.LANCZOS), "all"),
    "resize_25": (lambda im: im.resize((im.width // 4, im.height // 4), Image.LANCZOS), "all"),
    "crop_1px": (lambda im: im.crop((1, 1, im.width - 1, im.height - 1)), "all"),
    "crop_1pct_all": (lambda im: crop_edges(im, 0.01), "all"),
    "crop_1pct_edge": (lambda im: crop_edges(im, 0.01, "one"), "all"),
    "brightness_+10": (lambda im: ImageEnhance.Brightness(im).enhance(1.1), "all"),
    "crop_2pct_all": (lambda im: crop_edges(im, 0.02), "most"),
    "crop_2pct_edge": (lambda im: crop_edges(im, 0.02, "one"), "most"),
    "hue_+10deg": (lambda im: hue_shift(im, 10), "most"),
    "rotate_90": (lambda im: im.transpose(Image.ROTATE_90), None),
}


def build(n_bases=40, seed=7):
    """(bases, variants): bases is a list of images; variants maps transform
    name to a list aligned with bases."""
    rnd = random.Random(seed)
    bases = [scene(rnd, *rnd.choice(SIZES)) for _ in range(n_bases)]
    variants = {name: [fn(b) for b in bases] for name, (fn, _) in TRANSFORMS.items()}
    return bases, variants


def aspect_bucket_gap(a, b):
    """How many 0.01 log-aspect buckets apart two images land (dupes._bucket)."""
    return abs(round(math.log(a.width / a.height), 2) - round(math.log(b.width / b.height), 2)) / 0.01


def report(n_bases=60):
    import storage
    from dupes import hamming

    bases, variants = build(n_bases)
    bh = [storage.compute_perceptual(b) for b in bases]

    def stats(v):
        v = sorted(v)
        return f"min {v[0]:2d}  p50 {v[len(v) // 2]:2d}  p95 {v[int(len(v) * 0.95)]:2d}  max {v[-1]:2d}"

    print(f"{n_bases} base images\n\nsame picture, edited:        phash                          | dhash")
    for name, imgs in variants.items():
        ph, dh, gaps = [], [], []
        for (bp, bd), base, v in zip(bh, bases, imgs):
            p, d = storage.compute_perceptual(v)
            ph.append(hamming(bp, p))
            dh.append(hamming(bd, d))
            gaps.append(aspect_bucket_gap(base, v))
        expect = {"all": "", "most": "  (most)", None: "  (should not match)"}[TRANSFORMS[name][1]]
        print(f"  {name:15s} {stats(ph)} | {stats(dh)}  bucket gap max {max(gaps):.0f}{expect}")
    neg_p, neg_d = [], []
    for i in range(len(bases)):
        for j in range(i + 1, len(bases)):
            neg_p.append(hamming(bh[i][0], bh[j][0]))
            neg_d.append(hamming(bh[i][1], bh[j][1]))
    print(f"unrelated ({len(neg_p)} pairs): phash {stats(neg_p)} | dhash {stats(neg_d)}")


if __name__ == "__main__":
    report(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
