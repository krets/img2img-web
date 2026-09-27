"""Cross-library management queries: duplicate review, prompt reports, exports.

Kept out of db.py, which already holds the core schema and CRUD. Queries read
through the mgmt_index view (db.MGMT_INDEX_VIEW) and use db.get_connection().
The view treats archived projects as live, so queries here filter is_archived
themselves.
"""

import db

KINDS = ("source", "reference", "result")


def _counts_sql(include_archived):
    archived = "" if include_archived else "AND p.is_archived = 0"
    return f"""
        SELECT m.project_id AS project_id, m.kind AS kind, COUNT(*) AS n
        FROM mgmt_index m
        JOIN projects p ON p.id = m.project_id
        WHERE p.is_deleted = 0 {archived}
        GROUP BY m.project_id, m.kind
    """


def index_summary(include_archived=False):
    """Live source/reference/result counts per project, plus totals across them.
    Projects with nothing in them are listed with zeros.
    """
    conn = db.get_connection()
    archived = "" if include_archived else "AND is_archived = 0"
    projects = conn.execute(
        f"SELECT id, name FROM projects WHERE is_deleted = 0 {archived} ORDER BY name COLLATE NOCASE"
    ).fetchall()
    by_project = {p["id"]: {"project_id": p["id"], "project_name": p["name"], **dict.fromkeys(KINDS, 0)} for p in projects}
    for row in conn.execute(_counts_sql(include_archived)):
        by_project[row["project_id"]][row["kind"]] = row["n"]
    totals = {kind: sum(p[kind] for p in by_project.values()) for kind in KINDS}
    return {"projects": list(by_project.values()), "totals": totals}


# ---------------------------------------------------------------------------
# Filtered results across projects (ManageFilterIn). Queries the base tables
# rather than mgmt_index: SQLite materializes the view under the window
# function, which would scan every source and reference row too.
# ---------------------------------------------------------------------------

_RESULT_SORTS = {
    "date_desc": "date_generated DESC, id DESC",
    "date_asc": "date_generated ASC, id ASC",
    "project": "project_name COLLATE NOCASE, project_id, date_generated DESC, id DESC",
    "evaluation": (
        "CASE evaluation WHEN 'YES' THEN 0 WHEN 'MAYBE' THEN 1 WHEN 'UNRATED' THEN 2 ELSE 3 END,"
        " date_generated DESC, id DESC"
    ),
}


def _in_clause(column, values, params):
    params.extend(values)
    return f"{column} IN ({','.join('?' * len(values))})"


def _filtered_results_sql(f):
    """(sql, params) for every live result matching filter f, one row per
    result plus copy_rank/copy_count over its content_hash. Filtering happens
    before the copy window, so a copy outside the selection never hides one
    inside it.
    """
    params = []
    where = ["r.is_deleted = 0", "i.is_deleted = 0", "p.is_deleted = 0"]
    if f.project_ids:
        where.append(_in_clause("i.project_id", f.project_ids, params))
    elif not f.include_archived:
        where.append("p.is_archived = 0")
    if f.prompt_hashes:
        where.append(_in_clause("r.prompt_hash", f.prompt_hashes, params))
    if f.evaluations:
        where.append(_in_clause("COALESCE(r.evaluation, 'UNRATED')", f.evaluations, params))
    if f.engines:
        where.append(_in_clause("r.engine", f.engines, params))
    if f.active_only:
        where.append("r.is_active_result = 1")
    # date_generated is "YYYY-MM-DD HH:MM:SS" UTC, so plain string comparison
    # against day boundaries works; date_to is inclusive.
    if f.date_from:
        where.append("r.date_generated >= ?")
        params.append(f.date_from)
    if f.date_to:
        where.append("r.date_generated < date(?, '+1 day')")
        params.append(f.date_to)
    sql = f"""
        SELECT r.*, i.project_id AS project_id, p.name AS project_name,
               i.display_name AS image_display_name, i.file_name AS image_file_name,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(r.content_hash, r.id)
                                  ORDER BY r.date_generated, r.id) AS copy_rank,
               COUNT(*) OVER (PARTITION BY COALESCE(r.content_hash, r.id)) AS copy_count
        FROM results r
        JOIN images i ON i.id = r.image_id
        JOIN projects p ON p.id = i.project_id
        WHERE {' AND '.join(where)}
    """
    return sql, params


def list_filtered_results(f, offset=0, limit=100):
    """{total, items} for one page of results matching ManageFilterIn f.
    With f.dedupe_copies, results sharing a content_hash collapse to the
    earliest generated one; copy_count on each item says how many it stands for.
    """
    conn = db.get_connection()
    base_sql, params = _filtered_results_sql(f)
    keep = "WHERE copy_rank = 1" if f.dedupe_copies else ""
    # The total rides along on each row so the window pass runs once; only a
    # page past the end (no rows) needs a separate count.
    rows = conn.execute(
        f"SELECT *, COUNT(*) OVER () AS total FROM ({base_sql}) {keep}"
        f" ORDER BY {_RESULT_SORTS[f.sort]} LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    if rows:
        total = rows[0]["total"]
    else:
        total = conn.execute(f"SELECT COUNT(*) FROM ({base_sql}) {keep}", params).fetchone()[0]
    items = [db._decode_result(dict(r)) for r in rows]
    for item in items:
        del item["copy_rank"], item["total"]
    return {"total": total, "items": db._attach_reference_ids(conn, items)}


# ---------------------------------------------------------------------------
# Hash maintenance, driven by hash_worker.py. Covers every row whose file might
# still be on disk, trashed ones included, so restoring from the trash never
# leaves an unhashed row behind.
# ---------------------------------------------------------------------------

_MISSING = {
    "sources": "content_hash IS NULL OR resized_hash IS NULL OR phash IS NULL OR dhash IS NULL OR aspect IS NULL",
    "references": "content_hash IS NULL OR phash IS NULL OR dhash IS NULL OR aspect IS NULL",
    "results": "content_hash IS NULL AND media_type = 'image'",
}


def count_missing_hashes():
    conn = db.get_connection()
    return {
        "sources": conn.execute(f"SELECT COUNT(*) FROM images WHERE {_MISSING['sources']}").fetchone()[0],
        "references": conn.execute(f"SELECT COUNT(*) FROM reference_images WHERE {_MISSING['references']}").fetchone()[0],
        "results": conn.execute(f"SELECT COUNT(*) FROM results WHERE {_MISSING['results']}").fetchone()[0],
    }


# The list_* functions page by id (id > after_id) instead of re-querying "what's
# still missing", so a row whose file is gone or corrupt is stepped over once
# rather than refetched forever.

def list_sources_missing_hashes(after_id, limit):
    rows = db.get_connection().execute(
        f"SELECT id, project_id, file_name FROM images WHERE ({_MISSING['sources']}) AND id > ? ORDER BY id LIMIT ?",
        (after_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def list_references_missing_hashes(after_id, limit):
    rows = db.get_connection().execute(
        f"SELECT id, project_id, original_file_name FROM reference_images WHERE ({_MISSING['references']}) AND id > ? ORDER BY id LIMIT ?",
        (after_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def list_results_missing_hashes(after_id, limit):
    rows = db.get_connection().execute(
        "SELECT r.id, r.file_path, i.project_id FROM results r JOIN images i ON i.id = r.image_id"
        f" WHERE r.{_MISSING['results']} AND r.id > ? ORDER BY r.id LIMIT ?",
        (after_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def set_source_hashes(updates):
    """updates: [(image_id, {content_hash, resized_hash, phash, dhash, aspect}), ...] -- one commit."""
    conn = db.get_connection()
    conn.executemany(
        "UPDATE images SET content_hash = :content_hash, resized_hash = :resized_hash, phash = :phash,"
        " dhash = :dhash, aspect = :aspect WHERE id = :id",
        [{**fields, "id": image_id} for image_id, fields in updates],
    )
    conn.commit()


def set_reference_hashes(updates):
    """updates: [(reference_id, {content_hash, phash, dhash, aspect}), ...] -- one commit."""
    conn = db.get_connection()
    conn.executemany(
        "UPDATE reference_images SET content_hash = :content_hash, phash = :phash, dhash = :dhash,"
        " aspect = :aspect WHERE id = :id",
        [{**fields, "id": ref_id} for ref_id, fields in updates],
    )
    conn.commit()


def set_result_content_hashes(updates):
    """updates: [(result_id, content_hash), ...] -- one commit."""
    conn = db.get_connection()
    conn.executemany("UPDATE results SET content_hash = ? WHERE id = ?", [(h, rid) for rid, h in updates])
    conn.commit()
