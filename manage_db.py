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
