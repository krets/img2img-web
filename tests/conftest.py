"""Shared fixtures: every test gets its own workspace (config.set_db_path) and
a TestClient on the app. The client is not entered as a context manager, so
the startup hooks (hash worker, pruner, backfills) don't run; tests create
exactly the rows they need.
"""

import pytest
from fastapi.testclient import TestClient

import config as cfg
import db
import dupes
import storage


@pytest.fixture
def ws(tmp_path):
    cfg.set_db_path(tmp_path / "library.db")
    cfg.ensure_workspace()
    db.init_db(cfg.DB_PATH)
    dupes._cache.clear()  # keyed by data version, which can repeat across fresh DBs
    yield tmp_path


@pytest.fixture
def client(ws):
    import server

    return TestClient(server.app)


class Lib:
    """Terse row builders for tests. Files are not written; routes that only
    delete files tolerate their absence."""

    def __init__(self):
        self.c = db.get_connection()

    def project(self, name, archived=False):
        p = db.create_project(name)
        pid = p if isinstance(p, str) else p["id"]
        if archived:
            self.c.execute("UPDATE projects SET is_archived = 1 WHERE id = ?", (pid,))
            self.c.commit()
        return pid

    def source(self, project, name, img=None, content=None, when="2026-09-01 10:00:00", parent_result=None,
               write=False):
        ph = dh = aspect = None
        if img is not None:
            ph, dh = storage.compute_perceptual(img)
            aspect = img.width / img.height
            if write:
                img.save(storage.source_image_path(project, f"{name}.png"))
        i = db.create_image(project, f"{name}.png", name, getattr(img, "width", None), getattr(img, "height", None),
                            content_hash=content or f"c-{name}", phash=ph, dhash=dh, aspect=aspect,
                            derived_from_result_id=parent_result)
        iid = i if isinstance(i, str) else i["id"]
        self.c.execute("UPDATE images SET date_added = ? WHERE id = ?", (when, iid))
        self.c.commit()
        return iid

    def reference(self, project, name, img=None, content=None, when="2026-09-01 10:00:00", write=False):
        ph = dh = aspect = None
        if img is not None:
            ph, dh = storage.compute_perceptual(img)
            aspect = img.width / img.height
            if write:
                img.save(storage.reference_image_path(project, "f.png"))
        rid = db.new_id()
        self.c.execute(
            """INSERT INTO reference_images (id, project_id, display_name, original_file_name, file_name,
                   orig_width, orig_height, content_hash, phash, dhash, aspect, date_added)
               VALUES (?, ?, ?, 'o.png', 'f.png', ?, ?, ?, ?, ?, ?, ?)""",
            (rid, project, name, getattr(img, "width", None), getattr(img, "height", None),
             content or f"c-{name}", ph, dh, aspect, when),
        )
        self.c.commit()
        return rid

    def result(self, image, evaluation="UNRATED", prompt=None, content=None, when="2026-09-01 10:00:00",
               active=0, engine="grok", revised=None, img=None, source_preprocess=None):
        """img, if given, is written as the result's file (named after its id)."""
        import json

        import prompt_utils

        rid = db.new_id()
        file_path = f"{rid}.png" if img is not None else "r.png"
        if img is not None:
            project = db.get_image(image)["project_id"]
            img.save(storage.result_image_path(project, file_path))
        self.c.execute(
            """INSERT INTO results (id, image_id, file_path, adhoc_prompt_text, prompt_hash, content_hash,
                   evaluation, is_active_result, date_generated, engine, revised_prompt, source_preprocess)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (rid, image, file_path, prompt, prompt_utils.prompt_hash(prompt), content, evaluation, active, when,
             engine, revised, json.dumps(source_preprocess) if source_preprocess else None),
        )
        self.c.commit()
        return rid

    def use_reference(self, result, ref, position=0):
        self.c.execute("INSERT INTO result_references (result_id, reference_image_id, position) VALUES (?, ?, ?)",
                       (result, ref, position))
        self.c.commit()

    def soft_delete(self, table, row_id):
        self.c.execute(f"UPDATE {table} SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (row_id,))
        self.c.commit()


@pytest.fixture
def lib(ws):
    return Lib()
