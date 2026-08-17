"""Filesystem helpers: slugs, file naming, saving/deleting library images, and export builders."""

import hashlib
import io
import re
import shutil
import zipfile
from pathlib import Path

from PIL import Image, ImageOps, PngImagePlugin

import config as cfg

# Shared square thumbnail size for every list/grid preview (library sidebar,
# result grid, duplicate finder) -- 2x the 40px CSS preview box, for retina.
THUMBNAIL_SIZE = 80

# Long-edge cap for the A/B viewer's fast-loading placeholder preview. Unlike
# THUMBNAIL_SIZE, this is never cropped -- it exists purely to show correctly
# -framed (just lower-res) content while the full file loads, so it has to
# keep the source's own aspect ratio.
PREVIEW_MAX_DIM = 1024


def compute_pixel_hash(img: Image.Image):
    """MD5 of the decoded RGB pixel data, so identical-looking images hash the same
    regardless of source file format/compression.
    """
    if img.mode != "RGB":
        img = img.convert("RGB")
    return hashlib.md5(img.tobytes()).hexdigest()


RESIZED_HASH_DIM = 64


def compute_resized_hash(img: Image.Image):
    """MD5 of the pixel data after forcing to a small canonical size, so the same photo
    saved at two different resolutions still matches. Coarser than compute_pixel_hash --
    used only to surface possible duplicates for manual review, not to auto-skip at ingest.
    """
    if img.mode != "RGB":
        img = img.convert("RGB")
    small = img.resize((RESIZED_HASH_DIM, RESIZED_HASH_DIM), Image.Resampling.LANCZOS)
    return hashlib.md5(small.tobytes()).hexdigest()


def slugify(text, max_len=40):
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:max_len] or "untitled"


def save_source_image(project_id, image_id, display_name, file_bytes):
    """Normalizes an uploaded image to full-resolution PNG (flattening transparency
    onto white) and saves it under the project's source_images folder.
    Returns (relative_file_name, width, height, content_hash, resized_hash).
    """
    img = Image.open(io.BytesIO(file_bytes))
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        img_rgba = img.convert("RGBA")
        bg.paste(img_rgba, mask=img_rgba.split()[3])
        img = bg
    else:
        img = img.convert("RGB")

    content_hash = compute_pixel_hash(img)
    resized_hash = compute_resized_hash(img)

    slug = slugify(display_name)
    file_name = f"{image_id}_{slug}.png"
    dest = cfg.project_source_dir(project_id) / file_name
    img.save(dest, format="PNG")
    return file_name, img.width, img.height, content_hash, resized_hash


def save_reference_image_original(project_id, ref_id, display_name, file_bytes):
    """Normalizes an uploaded reference image to full-resolution PNG (like
    save_source_image) and saves the untouched original under the project's
    reference_images folder. The original is kept around even after cropping,
    so a reference can always be re-cropped from full quality. Returns
    (file_name, width, height).
    """
    img = Image.open(io.BytesIO(file_bytes))
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        img_rgba = img.convert("RGBA")
        bg.paste(img_rgba, mask=img_rgba.split()[3])
        img = bg
    else:
        img = img.convert("RGB")

    slug = slugify(display_name)
    file_name = f"{ref_id}_{slug}_orig.png"
    dest = cfg.project_reference_dir(project_id) / file_name
    img.save(dest, format="PNG")
    return file_name, img.width, img.height


def apply_reference_crop(project_id, ref_id, display_name, original_file_name, crop_box):
    """Crops the reference image's original file to crop_box (x, y, w, h in
    original-pixel coordinates; None means the full image) and saves the
    result as the active file used for thumbnails/generation. Always crops
    from original_file_name, never from a previous crop, so repeated
    re-cropping never compounds quality loss. Returns (file_name, width, height).
    """
    orig_path = cfg.project_reference_dir(project_id) / original_file_name
    img = Image.open(orig_path).convert("RGB")
    if crop_box is not None:
        x, y, w, h = crop_box
        img = img.crop((x, y, x + w, y + h))

    slug = slugify(display_name)
    file_name = f"{ref_id}_{slug}.png"
    dest = cfg.project_reference_dir(project_id) / file_name
    img.save(dest, format="PNG")
    return file_name, img.width, img.height


def reference_image_path(project_id, file_name):
    return cfg.project_reference_dir(project_id) / file_name


def delete_reference_image_files(project_id, original_file_name, file_name):
    reference_image_path(project_id, original_file_name).unlink(missing_ok=True)
    if file_name != original_file_name:
        reference_image_path(project_id, file_name).unlink(missing_ok=True)


def save_result_image(project_id, result_id, prompt_text, image_bytes, metadata=None):
    """Saves generated result bytes under the project's result_images folder,
    embedding the prompt (and any extra metadata) as PNG text chunks so it's
    still inspectable (e.g. via `exiftool`) if the file is exported or moved
    outside the app. Returns the relative file name.
    """
    slug = slugify(prompt_text)
    file_name = f"{result_id}_{slug}.png"
    dest = cfg.project_result_dir(project_id) / file_name

    img = Image.open(io.BytesIO(image_bytes))
    pnginfo = PngImagePlugin.PngInfo()
    pnginfo.add_text("prompt", prompt_text or "")
    for key, value in (metadata or {}).items():
        if value:
            pnginfo.add_text(key, str(value))
    img.save(dest, format="PNG", pnginfo=pnginfo)
    return file_name


def backfill_missing_content_hashes():
    """Computes content_hash/resized_hash for any images ingested before those columns existed."""
    import db

    for image in db.list_images_missing_hashes():
        path = source_image_path(image["project_id"], image["file_name"])
        if not path.exists():
            continue
        img = Image.open(path)
        db.set_image_hashes(image["id"], compute_pixel_hash(img), compute_resized_hash(img))


def _thumbnail_dir(kind, project_id):
    d = cfg.WORKSPACE_ROOT / "thumbnails" / project_id / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_or_create_thumbnail(kind, project_id, item_id, source_path):
    """Returns the path to a cached square thumbnail for source_path, generating
    it on first request. `kind` ('images' or 'results') namespaces the cache
    so image and result thumbnails never collide.
    """
    thumb_path = _thumbnail_dir(kind, project_id) / f"{item_id}.jpg"
    if not thumb_path.exists():
        img = Image.open(source_path).convert("RGB")
        thumb = ImageOps.fit(img, (THUMBNAIL_SIZE, THUMBNAIL_SIZE), Image.Resampling.LANCZOS)
        thumb.save(thumb_path, format="JPEG", quality=82)
    return thumb_path


def get_or_create_preview(kind, project_id, item_id, source_path):
    """Returns the path to a cached, aspect-ratio-preserving JPEG preview for
    source_path (long edge capped at PREVIEW_MAX_DIM, never cropped/upscaled).
    Used by the A/B viewer as a fast-loading placeholder while the full-res
    file loads -- unlike the square thumbnail, it keeps the source's own
    framing so swapping to the full image doesn't visibly jump.
    """
    preview_path = _thumbnail_dir(kind, project_id) / f"{item_id}_preview.jpg"
    if not preview_path.exists():
        img = Image.open(source_path).convert("RGB")
        img.thumbnail((PREVIEW_MAX_DIM, PREVIEW_MAX_DIM), Image.Resampling.LANCZOS)
        img.save(preview_path, format="JPEG", quality=85)
    return preview_path


def source_image_path(project_id, file_name):
    return cfg.project_source_dir(project_id) / file_name


def result_image_path(project_id, file_name):
    return cfg.project_result_dir(project_id) / file_name


def delete_source_image(project_id, file_name):
    path = source_image_path(project_id, file_name)
    path.unlink(missing_ok=True)


def delete_result_image(project_id, file_name):
    path = result_image_path(project_id, file_name)
    path.unlink(missing_ok=True)


def move_source_image(old_project_id, new_project_id, file_name):
    src = source_image_path(old_project_id, file_name)
    if src.exists():
        shutil.move(str(src), str(cfg.project_source_dir(new_project_id) / file_name))


def move_result_image(old_project_id, new_project_id, file_name):
    src = result_image_path(old_project_id, file_name)
    if src.exists():
        shutil.move(str(src), str(cfg.project_result_dir(new_project_id) / file_name))


def clear_thumbnail(kind, project_id, item_id):
    (_thumbnail_dir(kind, project_id) / f"{item_id}.jpg").unlink(missing_ok=True)
    (_thumbnail_dir(kind, project_id) / f"{item_id}_preview.jpg").unlink(missing_ok=True)


def delete_project_dirs(project_id):
    shutil.rmtree(cfg.project_source_dir(project_id), ignore_errors=True)
    shutil.rmtree(cfg.project_result_dir(project_id), ignore_errors=True)
    shutil.rmtree(cfg.project_reference_dir(project_id), ignore_errors=True)
    shutil.rmtree(cfg.WORKSPACE_ROOT / "thumbnails" / project_id, ignore_errors=True)


def build_export_zip(project_slug, status_filter, mode, results, source_paths):
    """Builds a zip file containing either clean result images or side-by-side
    composites for the given list of result dicts (each augmented with
    image_display_name / image_file_name / project_id), and returns its path.

    source_paths: dict mapping result_id -> Path to the corresponding source image file.
    """
    cfg.EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_name = f"{timestamp}_{project_slug}_{status_filter.lower()}_{mode}.zip"
    zip_path = cfg.EXPORTS_DIR / zip_name

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for result in results:
            result_path = result_image_path(result["project_id"], result["file_path"])
            if not result_path.exists():
                continue
            display = slugify(result.get("image_display_name") or "result")

            if mode == "clean":
                arcname = f"{display}_{result['id'][:8]}.png"
                zf.write(result_path, arcname)
            else:  # side_by_side
                source_path = source_paths.get(result["id"])
                composite = _make_side_by_side(source_path, result_path)
                if composite is None:
                    continue
                arcname = f"{display}_{result['id'][:8]}_ab.png"
                buf = io.BytesIO()
                composite.save(buf, format="PNG")
                zf.writestr(arcname, buf.getvalue())

    return zip_path


def _make_side_by_side(source_path, result_path):
    if source_path is None or not Path(source_path).exists():
        return None
    src = Image.open(source_path).convert("RGB")
    res = Image.open(result_path).convert("RGB")

    height = max(src.height, res.height)
    src_w = int(src.width * (height / src.height))
    res_w = int(res.width * (height / res.height))
    src_resized = src.resize((src_w, height))
    res_resized = res.resize((res_w, height))

    canvas = Image.new("RGB", (src_w + res_w, height), (255, 255, 255))
    canvas.paste(src_resized, (0, 0))
    canvas.paste(res_resized, (src_w, 0))
    return canvas
