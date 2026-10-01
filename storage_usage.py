"""Disk usage per library, and bulk downscaling of oversized source images.

Sizes come from stat()ing the files each row points at (rows whose file is
missing count as 0), split into live sources/references/results, thumbnails
(the cache directory), and trash (anything soft-deleted, or live results under
a trashed image). Nothing is persisted.

Downscaling replaces the source PNG in place (the full-resolution original is
gone afterwards). Pre-process crops are stored in pixel units, so they are
scaled with the image; the size and hash columns are recomputed. Results
already generated are unaffected: they are their own files.

Downscales run on a background thread (start_downscale), with progress held
in memory like export.py.
"""

import json
import os
import shutil
import threading
import time
import uuid

from PIL import Image

import config as cfg
import db
import storage

MIN_MAX_DIM = 256
JOB_TTL_SECONDS = 3600

_lock = threading.Lock()
_jobs = {}


def _size(path):
    try:
        return os.stat(path).st_size
    except OSError:
        return 0


def _dir_stats(path):
    """(total bytes, file count) for everything under path."""
    total = 0
    count = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            total += _size(os.path.join(root, name))
            count += 1
    return total, count


def scope_projects(project_ids, include_archived):
    """[(id, name)] for the live projects a request covers: the listed ones, or
    every live project (archived too when include_archived)."""
    conn = db.get_connection()
    if project_ids:
        marks = ",".join("?" * len(project_ids))
        rows = conn.execute(
            f"SELECT id, name FROM projects WHERE is_deleted = 0 AND id IN ({marks}) ORDER BY name COLLATE NOCASE",
            list(project_ids),
        ).fetchall()
    else:
        archived = "" if include_archived else "AND is_archived = 0"
        rows = conn.execute(
            f"SELECT id, name FROM projects WHERE is_deleted = 0 {archived} ORDER BY name COLLATE NOCASE"
        ).fetchall()
    return [(r["id"], r["name"]) for r in rows]


def usage(project_ids, include_archived=False):
    """Bytes per project by kind, totals, and free space on the workspace drive."""
    conn = db.get_connection()
    projects = []
    for pid, name in scope_projects(project_ids, include_archived):
        row = {"project_id": pid, "project_name": name, "sources": 0, "references": 0, "results": 0,
               "thumbnails": 0, "trash": 0, "source_count": 0, "reference_count": 0, "result_count": 0,
               "thumbnail_count": 0, "trash_count": 0}
        for img in conn.execute("SELECT file_name, is_deleted FROM images WHERE project_id = ?", (pid,)):
            size = _size(storage.source_image_path(pid, img["file_name"]))
            if img["is_deleted"]:
                row["trash"] += size
                row["trash_count"] += 1
            else:
                row["sources"] += size
                row["source_count"] += 1
        for ref in conn.execute(
            "SELECT original_file_name, file_name, is_deleted FROM reference_images WHERE project_id = ?", (pid,)
        ):
            names = {ref["original_file_name"], ref["file_name"]}
            size = sum(_size(storage.reference_image_path(pid, n)) for n in names)
            if ref["is_deleted"]:
                row["trash"] += size
                row["trash_count"] += 1
            else:
                row["references"] += size
                row["reference_count"] += 1
        for res in conn.execute(
            """SELECT r.file_path, r.is_deleted, i.is_deleted AS image_deleted
               FROM results r JOIN images i ON i.id = r.image_id WHERE i.project_id = ?""",
            (pid,),
        ):
            size = _size(storage.result_image_path(pid, res["file_path"]))
            dead = res["is_deleted"] or res["image_deleted"]
            if dead:
                row["trash"] += size
                row["trash_count"] += 1
            else:
                row["results"] += size
                row["result_count"] += 1
        row["thumbnails"], row["thumbnail_count"] = _dir_stats(cfg.WORKSPACE_ROOT / "thumbnails" / pid)
        row["total"] = sum(row[k] for k in ("sources", "references", "results", "thumbnails", "trash"))
        row["total_count"] = sum(
            row[k] for k in ("source_count", "reference_count", "result_count", "thumbnail_count", "trash_count")
        )
        projects.append(row)
    keys = ("sources", "references", "results", "thumbnails", "trash", "total",
            "source_count", "reference_count", "result_count", "thumbnail_count", "trash_count", "total_count")
    totals = {k: sum(p[k] for p in projects) for k in keys}
    disk = shutil.disk_usage(cfg.WORKSPACE_ROOT)
    return {"projects": projects, "totals": totals, "disk": {"free": disk.free, "total": disk.total}}


def _candidates(project_ids, include_archived, max_dim):
    """Live source rows (with file size and pixel size) whose long edge exceeds max_dim."""
    conn = db.get_connection()
    out = []
    for pid, name in scope_projects(project_ids, include_archived):
        for img in conn.execute(
            """SELECT id, file_name, display_name, width, height, preprocess,
                      (SELECT COUNT(*) FROM results r WHERE r.image_id = images.id AND r.is_deleted = 0) AS result_count
               FROM images WHERE project_id = ? AND is_deleted = 0""",
            (pid,),
        ):
            w, h = img["width"], img["height"]
            path = storage.source_image_path(pid, img["file_name"])
            if not (w and h):
                try:
                    with Image.open(path) as im:
                        w, h = im.size
                except OSError:
                    continue
            if max(w, h) > max_dim:
                out.append({"project_id": pid, "project_name": name, "image_id": img["id"],
                            "file_name": img["file_name"], "display_name": img["display_name"],
                            "width": w, "height": h, "preprocess": img["preprocess"],
                            "result_count": img["result_count"], "bytes": _size(path)})
    return out


def downscale_preview(project_ids, include_archived, max_dim):
    """The source images a downscale to max_dim could shrink, one entry each,
    biggest saving first. has_crop marks images with a stored crop/rotation
    (likely meant to be cropped in on, so the caller should treat them with
    care). The saving is an estimate: PNG size is taken to scale with pixel
    count.
    """
    items = []
    for c in _candidates(project_ids, include_archived, max_dim):
        scale = max_dim / max(c["width"], c["height"])
        items.append({
            "image_id": c["image_id"], "project_id": c["project_id"], "project_name": c["project_name"],
            "display_name": c["display_name"], "width": c["width"], "height": c["height"],
            "new_width": max(1, round(c["width"] * scale)), "new_height": max(1, round(c["height"] * scale)),
            "bytes": c["bytes"], "est_saved": int(c["bytes"] * (1 - scale * scale)),
            "has_crop": bool(c["preprocess"]), "result_count": c["result_count"],
        })
    items.sort(key=lambda i: -i["est_saved"])
    return {"max_dim": max_dim, "items": items, "count": len(items),
            "bytes": sum(i["bytes"] for i in items), "est_saved": sum(i["est_saved"] for i in items)}


def _scale_preprocess(raw, scale):
    if not raw:
        return None
    params = json.loads(raw) if isinstance(raw, str) else raw
    crop = params.get("crop")
    if crop:
        params["crop"] = {
            "x": round(crop["x"] * scale), "y": round(crop["y"] * scale),
            "w": max(1, round(crop["w"] * scale)), "h": max(1, round(crop["h"] * scale)),
        }
    return json.dumps(params)


def downscale_source(project_id, image_id, file_name, preprocess_raw, max_dim):
    """Shrinks one source file to max_dim on its long edge, in place. Returns
    bytes saved (0 when it was already small enough)."""
    path = storage.source_image_path(project_id, file_name)
    with Image.open(path) as im:
        im.load()
        img = im.convert("RGB")
    long_edge = max(img.size)
    if long_edge <= max_dim:
        return 0
    scale = max_dim / long_edge
    new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    small = img.resize(new_size, Image.Resampling.LANCZOS)
    before = _size(path)
    tmp = path.with_name(path.name + ".tmp")
    small.save(tmp, format="PNG", optimize=True)
    os.replace(tmp, path)
    phash, dhash = storage.compute_perceptual(small)
    conn = db.get_connection()
    conn.execute(
        "UPDATE images SET width = ?, height = ?, content_hash = ?, resized_hash = ?, phash = ?, dhash = ?,"
        " aspect = ?, preprocess = ? WHERE id = ?",
        (small.width, small.height, storage.compute_pixel_hash(small), storage.compute_resized_hash(small),
         phash, dhash, storage.compute_aspect(small.width, small.height),
         _scale_preprocess(preprocess_raw, scale), image_id),
    )
    conn.commit()
    storage.clear_thumbnail("images", project_id, image_id)  # also drops the processed-render cache
    return max(0, before - _size(path))


def _update(job_id, **fields):
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def _prune():
    cutoff = time.time() - JOB_TTL_SECONDS
    for job_id in [j for j, v in _jobs.items() if v["finished_at"] and v["finished_at"] < cutoff]:
        del _jobs[job_id]


def start_downscale(project_ids, include_archived, max_dim, image_ids):
    """Downscales only the images in image_ids (and in scope, and over max_dim)."""
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "status": "running", "done": 0, "total": 0, "failed": 0, "saved": 0,
           "error": None, "started_at": time.time(), "finished_at": None}
    with _lock:
        _prune()
        _jobs[job_id] = job

    def run():
        try:
            wanted = set(image_ids)
            todo = [c for c in _candidates(project_ids, include_archived, max_dim) if c["image_id"] in wanted]
            _update(job_id, total=len(todo))
            for c in todo:
                try:
                    saved = downscale_source(c["project_id"], c["image_id"], c["file_name"], c["preprocess"], max_dim)
                except Exception:  # one unreadable file shouldn't stop the batch
                    with _lock:
                        _jobs[job_id]["failed"] += 1
                else:
                    with _lock:
                        _jobs[job_id]["saved"] += saved
                with _lock:
                    _jobs[job_id]["done"] += 1
            _update(job_id, status="done", finished_at=time.time())
        except Exception as e:
            _update(job_id, status="error", error=str(e), finished_at=time.time())

    threading.Thread(target=run, name=f"downscale-{job_id[:8]}", daemon=True).start()
    return dict(job)


def job_status(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None
