"""SQLite schema bootstrap and query helpers for the image library."""

import json
import sqlite3
import uuid
from pathlib import Path

TABLES_SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    description   TEXT,
    date_created  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_archived   INTEGER DEFAULT 0,
    is_deleted    INTEGER DEFAULT 0,
    deleted_at    TIMESTAMP
);

CREATE TABLE IF NOT EXISTS images (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL,
    file_name              TEXT NOT NULL,
    display_name           TEXT NOT NULL,
    comment                TEXT,
    width                  INTEGER,
    height                 INTEGER,
    content_hash           TEXT,
    resized_hash           TEXT,
    derived_from_result_id TEXT,
    date_added             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_deleted             INTEGER DEFAULT 0,
    deleted_at             TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reference_images (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    display_name        TEXT NOT NULL,
    original_file_name  TEXT NOT NULL,
    file_name           TEXT NOT NULL,
    crop_x              INTEGER,
    crop_y              INTEGER,
    crop_w              INTEGER,
    crop_h              INTEGER,
    orig_width          INTEGER,
    orig_height         INTEGER,
    width               INTEGER,
    height              INTEGER,
    date_added          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_deleted          INTEGER DEFAULT 0,
    deleted_at          TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompts (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    prompt_text   TEXT NOT NULL,
    date_created  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS results (
    id                TEXT PRIMARY KEY,
    image_id          TEXT NOT NULL,
    prompt_id         TEXT,
    adhoc_prompt_text TEXT,
    file_path         TEXT NOT NULL,
    media_type        TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video')),
    engine            TEXT NOT NULL DEFAULT 'grok',
    model             TEXT,
    aspect_ratio      TEXT,
    max_dim           INTEGER,
    revised_prompt    TEXT,
    duration_seconds  REAL,
    evaluation        TEXT CHECK (evaluation IN ('YES','NO','MAYBE','UNRATED')) DEFAULT 'UNRATED',
    is_active_result  INTEGER DEFAULT 0,
    date_generated    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_deleted        INTEGER DEFAULT 0,
    deleted_at        TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE SET NULL
);
"""

# Applied after _migrate() so columns added by hand-rolled migrations already exist.
INDEXES_SCHEMA = """
CREATE INDEX IF NOT EXISTS idx_images_project      ON images(project_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_images_display_name ON images(display_name);
CREATE INDEX IF NOT EXISTS idx_images_date_added   ON images(date_added);
CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(project_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_images_resized_hash  ON images(project_id, resized_hash);
CREATE INDEX IF NOT EXISTS idx_images_deleted_at    ON images(is_deleted, deleted_at);
CREATE INDEX IF NOT EXISTS idx_results_image       ON results(image_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_results_prompt       ON results(prompt_id);
CREATE INDEX IF NOT EXISTS idx_results_evaluation   ON results(evaluation);
CREATE INDEX IF NOT EXISTS idx_results_active       ON results(image_id, is_active_result);
CREATE INDEX IF NOT EXISTS idx_results_deleted_at   ON results(is_deleted, deleted_at);
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at  ON projects(is_deleted, deleted_at);
CREATE INDEX IF NOT EXISTS idx_reference_images_project ON reference_images(project_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_reference_images_deleted_at ON reference_images(is_deleted, deleted_at);
"""

_connection = None


def new_id():
    return uuid.uuid4().hex


def init_db(db_path: Path):
    """Opens (creating if needed) the SQLite DB at db_path and applies the schema."""
    global _connection
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.executescript(TABLES_SCHEMA)
    _migrate(conn)
    conn.executescript(INDEXES_SCHEMA)
    conn.commit()
    _connection = conn
    return conn


def _migrate(conn):
    """Hand-rolled column migrations for DBs created before a given column existed."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
    if "content_hash" not in columns:
        conn.execute("ALTER TABLE images ADD COLUMN content_hash TEXT")
    if "resized_hash" not in columns:
        conn.execute("ALTER TABLE images ADD COLUMN resized_hash TEXT")
    if "is_deleted" not in columns:
        conn.execute("ALTER TABLE images ADD COLUMN is_deleted INTEGER DEFAULT 0")
    if "deleted_at" not in columns:
        conn.execute("ALTER TABLE images ADD COLUMN deleted_at TIMESTAMP")
    if "derived_from_result_id" not in columns:
        conn.execute("ALTER TABLE images ADD COLUMN derived_from_result_id TEXT")

    reference_columns = {row["name"] for row in conn.execute("PRAGMA table_info(reference_images)").fetchall()}
    if "is_deleted" not in reference_columns:
        conn.execute("ALTER TABLE reference_images ADD COLUMN is_deleted INTEGER DEFAULT 0")
    if "deleted_at" not in reference_columns:
        conn.execute("ALTER TABLE reference_images ADD COLUMN deleted_at TIMESTAMP")

    result_columns = {row["name"] for row in conn.execute("PRAGMA table_info(results)").fetchall()}
    if "engine" not in result_columns:
        conn.execute("ALTER TABLE results ADD COLUMN engine TEXT NOT NULL DEFAULT 'grok'")
    if "is_deleted" not in result_columns:
        conn.execute("ALTER TABLE results ADD COLUMN is_deleted INTEGER DEFAULT 0")
    if "deleted_at" not in result_columns:
        conn.execute("ALTER TABLE results ADD COLUMN deleted_at TIMESTAMP")
    if "duration_seconds" not in result_columns:
        conn.execute("ALTER TABLE results ADD COLUMN duration_seconds REAL")

    project_columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)").fetchall()}
    if "is_deleted" not in project_columns:
        conn.execute("ALTER TABLE projects ADD COLUMN is_deleted INTEGER DEFAULT 0")
    if "deleted_at" not in project_columns:
        conn.execute("ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMP")

    # idx_images_project's definition grew an is_deleted column; drop the old
    # single-column version so INDEXES_SCHEMA's CREATE INDEX IF NOT EXISTS
    # actually recreates it instead of leaving pre-existing DBs on the old one.
    conn.execute("DROP INDEX IF EXISTS idx_images_project")
    conn.execute("DROP INDEX IF EXISTS idx_reference_images_project")

    _migrate_unrated_evaluation(conn)


def _migrate_unrated_evaluation(conn):
    """SQLite can't ALTER a CHECK constraint in place, so DBs created before
    'UNRATED' was added to the evaluation enum need the results table rebuilt.
    Existing 'MAYBE' rows become 'UNRATED', since that default previously
    doubled as "never reviewed" — there's no way to tell those apart retroactively.
    """
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='results'").fetchone()
    if row is None or "UNRATED" in row["sql"]:
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE results RENAME TO results_old")
    conn.execute("""
        CREATE TABLE results (
            id                TEXT PRIMARY KEY,
            image_id          TEXT NOT NULL,
            prompt_id         TEXT,
            adhoc_prompt_text TEXT,
            file_path         TEXT NOT NULL,
            media_type        TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video')),
            engine            TEXT NOT NULL DEFAULT 'grok',
            model             TEXT,
            aspect_ratio      TEXT,
            max_dim           INTEGER,
            revised_prompt    TEXT,
            evaluation        TEXT CHECK (evaluation IN ('YES','NO','MAYBE','UNRATED')) DEFAULT 'UNRATED',
            is_active_result  INTEGER DEFAULT 0,
            date_generated    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_deleted        INTEGER DEFAULT 0,
            deleted_at        TIMESTAMP,
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
            FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE SET NULL
        )
    """)
    conn.execute("""
        INSERT INTO results (id, image_id, prompt_id, adhoc_prompt_text, file_path, media_type,
                              engine, model, aspect_ratio, max_dim, revised_prompt, evaluation,
                              is_active_result, date_generated, is_deleted, deleted_at)
        SELECT id, image_id, prompt_id, adhoc_prompt_text, file_path, media_type,
               engine, model, aspect_ratio, max_dim, revised_prompt,
               CASE WHEN evaluation = 'MAYBE' THEN 'UNRATED' ELSE evaluation END,
               is_active_result, date_generated, is_deleted, deleted_at
        FROM results_old
    """)
    conn.execute("DROP TABLE results_old")
    conn.execute("PRAGMA foreign_keys = ON")


def get_connection():
    if _connection is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return _connection


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

def create_project(name, description=None):
    conn = get_connection()
    project_id = new_id()
    slug = _unique_project_slug(conn, name)
    conn.execute(
        "INSERT INTO projects (id, name, slug, description) VALUES (?, ?, ?, ?)",
        (project_id, name, slug, description),
    )
    conn.commit()
    return get_project(project_id)


def _unique_project_slug(conn, name):
    from storage import slugify
    base = slugify(name) or "project"
    slug = base
    n = 2
    while conn.execute("SELECT 1 FROM projects WHERE slug = ?", (slug,)).fetchone():
        slug = f"{base}-{n}"
        n += 1
    return slug


def list_projects(include_archived=False):
    conn = get_connection()
    if include_archived:
        rows = conn.execute(
            "SELECT * FROM projects WHERE is_deleted = 0 ORDER BY date_created ASC"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM projects WHERE is_archived = 0 AND is_deleted = 0 ORDER BY date_created ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def list_deleted_projects():
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM projects WHERE is_deleted = 1 ORDER BY deleted_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def list_expired_projects(retention_days):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM projects WHERE is_deleted = 1 AND deleted_at <= datetime('now', ?)",
        (f"-{retention_days} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_project(project_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return dict(row) if row else None


def update_project(project_id, name=None, description=None):
    conn = get_connection()
    fields = []
    values = []
    if name is not None:
        fields.append("name = ?")
        values.append(name)
    if description is not None:
        fields.append("description = ?")
        values.append(description)
    if fields:
        values.append(project_id)
        conn.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    return get_project(project_id)


def set_project_archived(project_id, archived: bool):
    conn = get_connection()
    conn.execute("UPDATE projects SET is_archived = ? WHERE id = ?", (1 if archived else 0, project_id))
    conn.commit()
    return get_project(project_id)


def delete_project(project_id):
    conn = get_connection()
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()


def soft_delete_project(project_id):
    conn = get_connection()
    conn.execute(
        "UPDATE projects SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (project_id,)
    )
    conn.commit()
    return get_project(project_id)


def restore_project(project_id):
    conn = get_connection()
    conn.execute("UPDATE projects SET is_deleted = 0, deleted_at = NULL WHERE id = ?", (project_id,))
    conn.commit()
    return get_project(project_id)


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

def create_image(project_id, file_name, display_name, width=None, height=None, comment=None,
                  content_hash=None, resized_hash=None, derived_from_result_id=None):
    conn = get_connection()
    image_id = new_id()
    conn.execute(
        """INSERT INTO images (id, project_id, file_name, display_name, comment, width, height,
                                content_hash, resized_hash, derived_from_result_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (image_id, project_id, file_name, display_name, comment, width, height, content_hash, resized_hash,
         derived_from_result_id),
    )
    conn.commit()
    return get_image(image_id)


def find_image_by_hash(project_id, content_hash):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM images WHERE project_id = ? AND content_hash = ? AND is_deleted = 0",
        (project_id, content_hash),
    ).fetchone()
    return dict(row) if row else None


def list_images_missing_hashes():
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM images WHERE (content_hash IS NULL OR resized_hash IS NULL) AND is_deleted = 0"
    ).fetchall()
    return [dict(r) for r in rows]


def set_image_hashes(image_id, content_hash, resized_hash):
    conn = get_connection()
    conn.execute(
        "UPDATE images SET content_hash = ?, resized_hash = ? WHERE id = ?",
        (content_hash, resized_hash, image_id),
    )
    conn.commit()


def _with_results(image_rows):
    """Attaches each image's results (id + evaluation only) so duplicate-review
    UI can show which copy actually has rated work worth keeping.
    """
    out = []
    for row in image_rows:
        d = dict(row)
        d["results"] = list_results_for_image(d["id"])
        out.append(d)
    return out


def list_duplicate_groups(project_id):
    """Exact groups: 2+ images sharing the same content_hash (safe to auto-skip at ingest).
    Possible groups: 2+ images sharing the same resized_hash but NOT all sharing one content_hash
    (e.g. the same photo at different resolutions) -- surfaced for manual review only.
    """
    conn = get_connection()

    exact = []
    exact_hashes = conn.execute(
        """SELECT content_hash FROM images
           WHERE project_id = ? AND content_hash IS NOT NULL AND is_deleted = 0
           GROUP BY content_hash HAVING COUNT(*) > 1""",
        (project_id,),
    ).fetchall()
    for row in exact_hashes:
        content_hash = row["content_hash"]
        members = conn.execute(
            "SELECT * FROM images WHERE project_id = ? AND content_hash = ? AND is_deleted = 0 ORDER BY date_added ASC",
            (project_id, content_hash),
        ).fetchall()
        exact.append({"content_hash": content_hash, "images": _with_results(members)})

    possible = []
    resized_hashes = conn.execute(
        """SELECT resized_hash FROM images
           WHERE project_id = ? AND resized_hash IS NOT NULL AND is_deleted = 0
           GROUP BY resized_hash HAVING COUNT(*) > 1""",
        (project_id,),
    ).fetchall()
    for row in resized_hashes:
        resized_hash = row["resized_hash"]
        members = conn.execute(
            "SELECT * FROM images WHERE project_id = ? AND resized_hash = ? AND is_deleted = 0 ORDER BY date_added ASC",
            (project_id, resized_hash),
        ).fetchall()
        if len({m["content_hash"] for m in members}) <= 1:
            continue  # already fully covered by an exact group above
        possible.append({"resized_hash": resized_hash, "images": _with_results(members)})

    return {"exact": exact, "possible": possible}


_SORT_COLUMNS = {
    "name": "images.display_name COLLATE NOCASE ASC",
    "date": "images.date_added DESC",
    "evaluation": "eval_rank ASC, images.date_added DESC",
    "recent_result": "latest_activity DESC",
}


def list_images(project_id, sort="recent_result", filter="all", search=None):
    conn = get_connection()
    order_clause = _SORT_COLUMNS.get(sort, _SORT_COLUMNS["recent_result"])

    query = f"""
        SELECT images.*,
               active.id AS active_result_id,
               active.evaluation AS active_evaluation,
               active.file_path AS active_file_path,
               CASE active.evaluation
                   WHEN 'UNRATED' THEN 0
                   WHEN 'YES' THEN 1
                   WHEN 'MAYBE' THEN 2
                   WHEN 'NO' THEN 3
                   ELSE 4
               END AS eval_rank,
               (SELECT COUNT(*) FROM results WHERE results.image_id = images.id AND results.is_deleted = 0) AS result_count,
               COALESCE(
                   (SELECT MAX(date_generated) FROM results WHERE results.image_id = images.id AND results.is_deleted = 0),
                   images.date_added
               ) AS latest_activity,
               (SELECT json_group_array(json_object('id', re.id, 'evaluation', re.evaluation))
                FROM (SELECT id, evaluation FROM results
                      WHERE results.image_id = images.id AND results.is_deleted = 0
                      ORDER BY date_generated ASC) re
               ) AS result_evaluations_json
        FROM images
        LEFT JOIN results active
            ON active.image_id = images.id AND active.is_active_result = 1 AND active.is_deleted = 0
        WHERE images.project_id = ? AND images.is_deleted = 0
    """
    params = [project_id]

    if filter == "unprocessed":
        query += " AND (SELECT COUNT(*) FROM results WHERE results.image_id = images.id AND results.is_deleted = 0) = 0"
    elif filter in ("YES", "NO", "MAYBE", "UNRATED"):
        query += " AND active.evaluation = ?"
        params.append(filter)

    if search:
        query += " AND (images.display_name LIKE ? OR images.comment LIKE ?)"
        like = f"%{search}%"
        params.extend([like, like])

    query += f" ORDER BY {order_clause}"

    rows = conn.execute(query, params).fetchall()
    results = []
    for row in rows:
        d = dict(row)
        d["result_evaluations"] = json.loads(d.pop("result_evaluations_json") or "[]")
        results.append(d)
    return results


def get_image(image_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    return dict(row) if row else None


def update_image(image_id, display_name=None, comment=None):
    conn = get_connection()
    fields = []
    values = []
    if display_name is not None:
        fields.append("display_name = ?")
        values.append(display_name)
    if comment is not None:
        fields.append("comment = ?")
        values.append(comment)
    if fields:
        values.append(image_id)
        conn.execute(f"UPDATE images SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    return get_image(image_id)


def delete_image(image_id):
    conn = get_connection()
    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    conn.commit()


def soft_delete_image(image_id):
    conn = get_connection()
    conn.execute(
        "UPDATE images SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (image_id,)
    )
    conn.commit()
    return get_image(image_id)


def restore_image(image_id):
    conn = get_connection()
    conn.execute("UPDATE images SET is_deleted = 0, deleted_at = NULL WHERE id = ?", (image_id,))
    conn.commit()
    return get_image(image_id)


def list_deleted_images(project_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM images WHERE project_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_expired_images(retention_days):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM images WHERE is_deleted = 1 AND deleted_at <= datetime('now', ?)",
        (f"-{retention_days} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def set_image_project(image_id, project_id):
    conn = get_connection()
    conn.execute("UPDATE images SET project_id = ? WHERE id = ?", (project_id, image_id))
    conn.commit()


def merge_images(keep_id, remove_id):
    """Reassigns all of remove_id's results onto keep_id, collapses the merged
    set down to a single active result (most recently generated), then deletes
    the now-empty remove_id image row. Caller is responsible for deleting
    remove_id's source file/thumbnail on disk.
    """
    conn = get_connection()
    conn.execute(
        "UPDATE results SET image_id = ?, is_active_result = 0 WHERE image_id = ?",
        (keep_id, remove_id),
    )
    latest = conn.execute(
        "SELECT id FROM results WHERE image_id = ? ORDER BY date_generated DESC LIMIT 1",
        (keep_id,),
    ).fetchone()
    if latest:
        conn.execute("UPDATE results SET is_active_result = 0 WHERE image_id = ?", (keep_id,))
        conn.execute("UPDATE results SET is_active_result = 1 WHERE id = ?", (latest["id"],))
    conn.execute("DELETE FROM images WHERE id = ?", (remove_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Reference images (per-project prep material, distinct from library images)
# ---------------------------------------------------------------------------

def create_reference_image(project_id, display_name, original_file_name, file_name,
                            crop_x, crop_y, crop_w, crop_h, orig_width, orig_height, width, height, ref_id=None):
    conn = get_connection()
    ref_id = ref_id or new_id()
    conn.execute(
        """INSERT INTO reference_images (id, project_id, display_name, original_file_name, file_name,
                                          crop_x, crop_y, crop_w, crop_h, orig_width, orig_height, width, height)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (ref_id, project_id, display_name, original_file_name, file_name,
         crop_x, crop_y, crop_w, crop_h, orig_width, orig_height, width, height),
    )
    conn.commit()
    return get_reference_image(ref_id)


def list_reference_images(project_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM reference_images WHERE project_id = ? AND is_deleted = 0 ORDER BY date_added DESC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_deleted_reference_images(project_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM reference_images WHERE project_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_expired_reference_images(retention_days):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM reference_images WHERE is_deleted = 1 AND deleted_at <= datetime('now', ?)",
        (f"-{retention_days} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_reference_image(ref_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM reference_images WHERE id = ?", (ref_id,)).fetchone()
    return dict(row) if row else None


def update_reference_image(ref_id, display_name=None):
    conn = get_connection()
    if display_name is not None:
        conn.execute("UPDATE reference_images SET display_name = ? WHERE id = ?", (display_name, ref_id))
        conn.commit()
    return get_reference_image(ref_id)


def update_reference_image_crop(ref_id, file_name, crop_x, crop_y, crop_w, crop_h, width, height):
    conn = get_connection()
    conn.execute(
        """UPDATE reference_images
           SET file_name = ?, crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?, width = ?, height = ?
           WHERE id = ?""",
        (file_name, crop_x, crop_y, crop_w, crop_h, width, height, ref_id),
    )
    conn.commit()
    return get_reference_image(ref_id)


def soft_delete_reference_image(ref_id):
    conn = get_connection()
    conn.execute(
        "UPDATE reference_images SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (ref_id,)
    )
    conn.commit()
    return get_reference_image(ref_id)


def restore_reference_image(ref_id):
    conn = get_connection()
    conn.execute("UPDATE reference_images SET is_deleted = 0, deleted_at = NULL WHERE id = ?", (ref_id,))
    conn.commit()
    return get_reference_image(ref_id)


def delete_reference_image(ref_id):
    """Hard delete -- only for permanent removal (after it's already trashed)
    or the retention purge job. Callers are responsible for the files on disk.
    """
    conn = get_connection()
    conn.execute("DELETE FROM reference_images WHERE id = ?", (ref_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Prompts (global, not project-scoped)
# ---------------------------------------------------------------------------

def create_prompt(title, prompt_text):
    conn = get_connection()
    prompt_id = new_id()
    conn.execute(
        "INSERT INTO prompts (id, title, prompt_text) VALUES (?, ?, ?)",
        (prompt_id, title, prompt_text),
    )
    conn.commit()
    return get_prompt(prompt_id)


def list_prompts():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM prompts ORDER BY date_updated DESC").fetchall()
    return [dict(r) for r in rows]


def get_prompt(prompt_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
    return dict(row) if row else None


def update_prompt(prompt_id, title=None, prompt_text=None):
    conn = get_connection()
    fields = []
    values = []
    if title is not None:
        fields.append("title = ?")
        values.append(title)
    if prompt_text is not None:
        fields.append("prompt_text = ?")
        values.append(prompt_text)
    if fields:
        fields.append("date_updated = CURRENT_TIMESTAMP")
        values.append(prompt_id)
        conn.execute(f"UPDATE prompts SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    return get_prompt(prompt_id)


def delete_prompt(prompt_id):
    conn = get_connection()
    conn.execute("DELETE FROM prompts WHERE id = ?", (prompt_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def create_result(image_id, file_path, prompt_id=None, adhoc_prompt_text=None,
                   engine="grok", model=None, aspect_ratio=None, max_dim=None, revised_prompt=None,
                   media_type="image", result_id=None, duration_seconds=None):
    conn = get_connection()
    result_id = result_id or new_id()
    conn.execute(
        """INSERT INTO results (id, image_id, prompt_id, adhoc_prompt_text, file_path,
                                 media_type, engine, model, aspect_ratio, max_dim, revised_prompt,
                                 duration_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (result_id, image_id, prompt_id, adhoc_prompt_text, file_path,
         media_type, engine, model, aspect_ratio, max_dim, revised_prompt, duration_seconds),
    )
    # Newly generated results become the active one for review.
    conn.execute("UPDATE results SET is_active_result = 0 WHERE image_id = ?", (image_id,))
    conn.execute("UPDATE results SET is_active_result = 1 WHERE id = ?", (result_id,))
    conn.commit()
    return get_result(result_id)


def list_results_for_image(image_id, include_deleted=False):
    conn = get_connection()
    query = "SELECT * FROM results WHERE image_id = ?"
    if not include_deleted:
        query += " AND is_deleted = 0"
    query += " ORDER BY date_generated DESC"
    rows = conn.execute(query, (image_id,)).fetchall()
    return [dict(r) for r in rows]


def get_result(result_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM results WHERE id = ?", (result_id,)).fetchone()
    return dict(row) if row else None


def set_active_result(result_id):
    conn = get_connection()
    result = get_result(result_id)
    if not result:
        return None
    conn.execute("UPDATE results SET is_active_result = 0 WHERE image_id = ?", (result["image_id"],))
    conn.execute("UPDATE results SET is_active_result = 1 WHERE id = ?", (result_id,))
    conn.commit()
    return get_result(result_id)


def update_evaluation(result_id, evaluation):
    conn = get_connection()
    conn.execute("UPDATE results SET evaluation = ? WHERE id = ?", (evaluation, result_id))
    conn.commit()
    return get_result(result_id)


def delete_result(result_id):
    conn = get_connection()
    conn.execute("DELETE FROM results WHERE id = ?", (result_id,))
    conn.commit()


def soft_delete_result(result_id):
    conn = get_connection()
    conn.execute(
        "UPDATE results SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (result_id,)
    )
    conn.commit()
    return get_result(result_id)


def restore_result(result_id):
    conn = get_connection()
    conn.execute("UPDATE results SET is_deleted = 0, deleted_at = NULL WHERE id = ?", (result_id,))
    conn.commit()
    return get_result(result_id)


def list_deleted_results(project_id):
    """Individually-trashed results whose image is still active -- results whose
    whole parent image is also trashed are represented by that image's own
    trash entry instead, to avoid double-accounting the same content.
    """
    conn = get_connection()
    rows = conn.execute(
        """SELECT results.*, images.display_name AS image_display_name
           FROM results JOIN images ON images.id = results.image_id
           WHERE images.project_id = ? AND results.is_deleted = 1 AND images.is_deleted = 0
           ORDER BY results.deleted_at DESC""",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_expired_results(retention_days):
    """Independently-trashed results past their retention window, excluding
    ones whose parent image is also trashed (those get purged as a unit when
    the image itself expires, via list_expired_images).
    """
    conn = get_connection()
    rows = conn.execute(
        """SELECT results.*
           FROM results JOIN images ON images.id = results.image_id
           WHERE results.is_deleted = 1 AND images.is_deleted = 0
             AND results.deleted_at <= datetime('now', ?)""",
        (f"-{retention_days} days",),
    ).fetchall()
    return [dict(r) for r in rows]


def trash_no_results(project_id):
    """Bulk-soft-deletes every currently NO-rated, non-deleted result whose
    image is still active. Returns the affected result ids.
    """
    conn = get_connection()
    rows = conn.execute(
        """SELECT results.id FROM results JOIN images ON images.id = results.image_id
           WHERE images.project_id = ? AND images.is_deleted = 0
             AND results.is_deleted = 0 AND results.evaluation = 'NO'""",
        (project_id,),
    ).fetchall()
    ids = [r["id"] for r in rows]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE results SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
            ids,
        )
        conn.commit()
    return ids


def list_results_by_status(project_id, status="ALL"):
    """Active results for a project, optionally filtered by evaluation status. Used by export."""
    conn = get_connection()
    query = """
        SELECT results.*, images.display_name AS image_display_name, images.file_name AS image_file_name
        FROM results
        JOIN images ON images.id = results.image_id
        WHERE images.project_id = ? AND results.is_active_result = 1
              AND results.is_deleted = 0 AND images.is_deleted = 0
    """
    params = [project_id]
    if status != "ALL":
        query += " AND results.evaluation = ?"
        params.append(status)
    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]
