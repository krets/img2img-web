"""Background hash worker: fills in the hash columns for rows that lack them.

Ingest computes every hash up front (see storage.save_source_image and
save_reference_image_original), so this only has work to do for rows that predate
a hash column -- perceptual hashes on existing images/references, and the
content_hash of existing results. It runs once per startup on a daemon thread,
committing per batch, so startup never waits on ~10k PNG decodes. Rows whose
file is missing or unreadable are logged, counted in status()["failed"] and left
NULL (retried next startup).
"""

import logging
import threading

from PIL import Image

import manage_db
import storage

logger = logging.getLogger(__name__)

BATCH_SIZE = 50

progress = {"running": False, "failed": 0}
_run_lock = threading.Lock()


def status():
    return {"pending": manage_db.count_missing_hashes(), "running": progress["running"],
            "failed": progress["failed"]}


def _load_rgb(path):
    with Image.open(path) as opened:
        return opened.convert("RGB")


def _source_fields(row):
    # The stored PNG, not images.preprocess: cropping is non-destructive metadata.
    img = _load_rgb(storage.source_image_path(row["project_id"], row["file_name"]))
    phash, dhash = storage.compute_perceptual(img)
    return {"content_hash": storage.compute_pixel_hash(img), "resized_hash": storage.compute_resized_hash(img),
            "phash": phash, "dhash": dhash, "aspect": storage.compute_aspect(*img.size)}


def _reference_fields(row):
    # The untouched original, not the cropped active file.
    img = _load_rgb(storage.reference_image_path(row["project_id"], row["original_file_name"]))
    phash, dhash = storage.compute_perceptual(img)
    return {"content_hash": storage.compute_pixel_hash(img), "phash": phash, "dhash": dhash,
            "aspect": storage.compute_aspect(*img.size)}


def _result_content_hash(row):
    return storage.compute_pixel_hash(_load_rgb(storage.result_image_path(row["project_id"], row["file_path"])))


def _run_pass(kind, list_missing, compute, save):
    after_id = ""
    while True:
        rows = list_missing(after_id, BATCH_SIZE)
        if not rows:
            return
        updates = []
        for row in rows:
            try:
                updates.append((row["id"], compute(row)))
            except FileNotFoundError as e:
                progress["failed"] += 1
                logger.warning("Could not hash %s %s: file missing (%s)", kind, row["id"], e.filename)
            except Exception:
                progress["failed"] += 1
                logger.warning("Could not hash %s %s", kind, row["id"], exc_info=True)
        if updates:
            save(updates)
        after_id = rows[-1]["id"]


def run_once():
    """One full pass over sources, references and results. Blocking; skipped if
    another pass is already running.
    """
    if not _run_lock.acquire(blocking=False):
        return
    progress.update(running=True, failed=0)
    try:
        _run_pass("source", manage_db.list_sources_missing_hashes, _source_fields, manage_db.set_source_hashes)
        _run_pass("reference", manage_db.list_references_missing_hashes, _reference_fields, manage_db.set_reference_hashes)
        _run_pass("result", manage_db.list_results_missing_hashes, _result_content_hash, manage_db.set_result_content_hashes)
    except Exception:
        logger.exception("Hash backfill pass failed")
    finally:
        progress["running"] = False
        _run_lock.release()


def start_background_hasher():
    progress["running"] = True  # set before the thread starts so status() can't race it to "idle"
    threading.Thread(target=run_once, name="hash-worker", daemon=True).start()
