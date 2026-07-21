"""Background retention pruner: permanently removes trashed images, results,
and projects once they've sat in the trash past RETENTION_DAYS, freeing their
files on disk. Soft-deletion itself (moving something into the trash) happens
inline in the request handlers -- this module only handles the delayed,
irreversible cleanup step.
"""

import logging
import threading
import time

import db
import storage

logger = logging.getLogger(__name__)

RETENTION_DAYS = 2
CHECK_INTERVAL_SECONDS = 60 * 60  # hourly is plenty for a 2-day retention window


def prune_expired():
    """Permanently deletes anything past its retention window. Order matters:
    expired projects go first so their images/results (cascaded in the DB, and
    already covered by storage.delete_project_dirs) aren't redundantly walked
    by the image/result passes below.
    """
    for project in db.list_expired_projects(RETENTION_DAYS):
        db.delete_project(project["id"])
        storage.delete_project_dirs(project["id"])
        logger.info("Pruned expired project %s (%s)", project["id"], project["name"])

    for image in db.list_expired_images(RETENTION_DAYS):
        for result in db.list_results_for_image(image["id"], include_deleted=True):
            storage.delete_result_image(image["project_id"], result["file_path"])
            storage.clear_thumbnail("results", image["project_id"], result["id"])
        storage.delete_source_image(image["project_id"], image["file_name"])
        storage.clear_thumbnail("images", image["project_id"], image["id"])
        db.delete_image(image["id"])
        logger.info("Pruned expired image %s (%s)", image["id"], image["display_name"])

    for result in db.list_expired_results(RETENTION_DAYS):
        image = db.get_image(result["image_id"])
        if image:
            storage.delete_result_image(image["project_id"], result["file_path"])
            storage.clear_thumbnail("results", image["project_id"], result["id"])
        db.delete_result(result["id"])
        logger.info("Pruned expired result %s", result["id"])


def _loop():
    while True:
        try:
            prune_expired()
        except Exception:
            logger.exception("Trash pruning pass failed")
        time.sleep(CHECK_INTERVAL_SECONDS)


def start_background_pruner():
    threading.Thread(target=_loop, daemon=True).start()
