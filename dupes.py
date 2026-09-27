"""Near-duplicate clustering of source and reference images across projects.

Sources and references are pooled (the same photo is often a source in one
project and a reference in another) and paired when their perceptual hashes
(storage.compute_perceptual) are within a Hamming distance, or when their
content hashes match exactly. Pairs are joined into clusters with union-find.

Only images of similar aspect ratio are compared: items are bucketed by
round(log(aspect), 2) and checked against buckets up to two away, which
absorbs resize rounding and a crop of about 2% off one edge (tests/
hash_fixtures.py measures both). That keeps the pairwise pass cheap for
libraries in the low tens of thousands.

Clusters are cached in memory per (selection, thresholds, data version);
dup_decisions are applied on top of the cached clusters on every call, so
marking an image doesn't recompute anything.
"""

import math
import threading
from collections import defaultdict

import db

MASK64 = (1 << 64) - 1
# Max phash bit distance still treated as the same picture. From
# tests/hash_fixtures.py: JPEG q30, 25% resize, 1% crops and +10% brightness
# always stay within 8; 2% crops and a 10 degree hue shift do ~97% of the time
# (all within 14). Unrelated images start at 16 and a 90 degree rotation at 26.
# On the live library (5.2k images) 6 and 8 give the same 427 clusters, while
# 10 already merges two of them into one of 26, so 8 it is; the UI slider goes
# to 16. (imagehash's phash distances only come out even.)
DEFAULT_THRESHOLD = 8
BUCKET_REACH = 2  # compare against buckets this many 0.01 log-aspect steps away
_CACHE_SIZE = 8

_cache = {}
_cache_lock = threading.Lock()


def hamming(a, b):
    """Bit distance between two hashes stored as signed 64-bit ints."""
    return ((a & MASK64) ^ (b & MASK64)).bit_count()


def _bucket(aspect):
    return round(math.log(aspect), 2)


def _project_clause(project_ids, include_archived, alias, params):
    if project_ids:
        params.extend(project_ids)
        return f"AND {alias}.project_id IN ({','.join('?' * len(project_ids))})"
    return "" if include_archived else "AND p.is_archived = 0"


def _load_items(conn, project_ids, include_archived, kinds):
    """Live sources/references in the selection, hashed or not."""
    items = []
    if "source" in kinds:
        params = []
        where = _project_clause(project_ids, include_archived, "i", params)
        rows = conn.execute(
            f"""
            SELECT 'source' AS kind, i.id, i.project_id, p.name AS project_name, i.display_name,
                   i.width, i.height, i.aspect, i.phash, i.dhash, i.content_hash, i.date_added,
                   pr.image_id AS parent_image_id
            FROM images i JOIN projects p ON p.id = i.project_id
            LEFT JOIN results pr ON pr.id = i.derived_from_result_id
            WHERE i.is_deleted = 0 AND p.is_deleted = 0 {where}
            """,
            params,
        ).fetchall()
        items.extend(dict(r) for r in rows)
    if "reference" in kinds:
        params = []
        where = _project_clause(project_ids, include_archived, "ri", params)
        # Reference hashes and aspect describe the uncropped original, so show
        # its size too rather than the crop's.
        rows = conn.execute(
            f"""
            SELECT 'reference' AS kind, ri.id, ri.project_id, p.name AS project_name, ri.display_name,
                   COALESCE(ri.orig_width, ri.width) AS width, COALESCE(ri.orig_height, ri.height) AS height,
                   ri.aspect, ri.phash, ri.dhash, ri.content_hash, ri.date_added,
                   NULL AS parent_image_id
            FROM reference_images ri JOIN projects p ON p.id = ri.project_id
            WHERE ri.is_deleted = 0 AND p.is_deleted = 0 {where}
            """,
            params,
        ).fetchall()
        items.extend(dict(r) for r in rows)
    return items


def cluster_items(items, threshold=DEFAULT_THRESHOLD, dhash_threshold=None, exclude_lineage=True):
    """Clusters (lists of item indexes, size >= 2) among items, each a dict with
    kind, id, phash, dhash, aspect, content_hash and parent_image_id. Items
    missing phash or aspect only pair through an exact content_hash match.

    exclude_lineage skips the perceptual pairing of a source with the image it
    was promoted from (parent_image_id): an edit of an image resembles it on
    purpose. The two can still meet in one cluster through other members.
    """
    parent = list(range(len(items)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_content = defaultdict(list)
    buckets = defaultdict(list)
    for idx, it in enumerate(items):
        if it["content_hash"]:
            by_content[it["content_hash"]].append(idx)
        if it["phash"] is not None and it["aspect"]:
            buckets[_bucket(it["aspect"])].append(idx)

    for same in by_content.values():
        for other in same[1:]:
            union(same[0], other)

    lineage = set()
    if exclude_lineage:
        for it in items:
            if it.get("parent_image_id"):
                lineage.add(frozenset((it["id"], it["parent_image_id"])))

    phash = [None if it["phash"] is None else it["phash"] & MASK64 for it in items]
    dhash = [None if it["dhash"] is None else it["dhash"] & MASK64 for it in items]
    for key, members in buckets.items():
        # Compare against this bucket and the ones above it; the ones below
        # compare against this one on their own turn.
        neighbours = list(members)
        for step in range(1, BUCKET_REACH + 1):
            neighbours += buckets.get(round(key + step / 100, 2), [])
        for i, a in enumerate(members):
            for b in neighbours[i + 1:]:
                if (phash[a] ^ phash[b]).bit_count() > threshold:
                    continue
                if lineage and frozenset((items[a]["id"], items[b]["id"])) in lineage:
                    continue
                if dhash_threshold is not None and dhash[a] is not None and dhash[b] is not None:
                    if (dhash[a] ^ dhash[b]).bit_count() > dhash_threshold:
                        continue
                union(a, b)

    groups = defaultdict(list)
    for idx in range(len(items)):
        groups[find(idx)].append(idx)
    return [g for g in groups.values() if len(g) > 1]


def _distance(a, b):
    if a["content_hash"] and a["content_hash"] == b["content_hash"]:
        return 0
    if a["phash"] is None or b["phash"] is None:
        return None
    return hamming(a["phash"], b["phash"])


def _data_version(conn, project_ids, include_archived):
    """Changes whenever an image in the selection is added, removed, restored
    or gets its hashes filled in, so a cached clustering is never stale.
    """
    parts = []
    for table, alias in (("images", "i"), ("reference_images", "ri")):
        params = []
        where = _project_clause(project_ids, include_archived, alias, params)
        parts.append(tuple(conn.execute(
            f"""
            SELECT COUNT(*), MAX({alias}.date_added), COUNT({alias}.phash), COUNT({alias}.content_hash)
            FROM {table} {alias} JOIN projects p ON p.id = {alias}.project_id
            WHERE {alias}.is_deleted = 0 AND p.is_deleted = 0 {where}
            """,
            params,
        ).fetchone()))
    return tuple(parts)


def _clusters_cached(conn, project_ids, include_archived, kinds, threshold, dhash_threshold, exclude_lineage):
    key = (tuple(sorted(project_ids)), include_archived, tuple(sorted(kinds)), threshold, dhash_threshold,
           exclude_lineage, _data_version(conn, project_ids, include_archived))
    with _cache_lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    items = _load_items(conn, project_ids, include_archived, kinds)
    clusters = [[items[i] for i in c] for c in cluster_items(items, threshold, dhash_threshold, exclude_lineage)]
    unhashed = sum(1 for it in items if it["phash"] is None or not it["aspect"])
    value = (clusters, len(items), unhashed)
    with _cache_lock:
        if len(_cache) >= _CACHE_SIZE:
            _cache.pop(next(iter(_cache)))
        _cache[key] = value
    return value


def _decisions(conn):
    return {(r["image_kind"], r["image_id"]): r["role"] for r in conn.execute("SELECT image_kind, image_id, role FROM dup_decisions")}


def _result_counts(conn, image_ids):
    counts = {i: {"YES": 0, "MAYBE": 0, "NO": 0, "UNRATED": 0} for i in image_ids}
    ids = list(image_ids)
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for r in conn.execute(
            f"""SELECT image_id, COALESCE(evaluation, 'UNRATED') AS ev, COUNT(*) AS n FROM results
                WHERE is_deleted = 0 AND image_id IN ({','.join('?' * len(chunk))}) GROUP BY image_id, ev""",
            chunk,
        ):
            counts[r["image_id"]][r["ev"]] = r["n"]
    return counts


def _reference_uses(conn, ref_ids):
    uses = dict.fromkeys(ref_ids, 0)
    ids = list(ref_ids)
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for r in conn.execute(
            f"""SELECT rr.reference_image_id AS id, COUNT(*) AS n FROM result_references rr
                JOIN results r ON r.id = rr.result_id AND r.is_deleted = 0
                WHERE rr.reference_image_id IN ({','.join('?' * len(chunk))}) GROUP BY rr.reference_image_id""",
            chunk,
        ):
            uses[r["id"]] = r["n"]
    return uses


def _is_resolved(members):
    roles = [m["decision"] for m in members]
    undecided = roles.count(None)
    if roles.count("canonical") >= 1:
        return undecided == 0
    return undecided <= 1 and roles.count("ignore") >= len(members) - 1


def find_duplicates(project_ids=(), include_archived=False, kinds=("source", "reference"),
                    threshold=DEFAULT_THRESHOLD, dhash_threshold=None, exclude_lineage=True,
                    include_resolved=False):
    """{clusters, total_items, unhashed, resolved_hidden} for the selection.

    Each cluster: anchor_id/anchor_kind (the canonical member if one is marked,
    else the earliest added), max_distance (largest pairwise phash distance;
    0 = identical content), resolved, and members sorted anchor first then by
    distance to it. A cluster is resolved once a canonical is marked and every
    other member has a decision, or all members but one are marked ignore.
    """
    conn = db.get_connection()
    clusters, total, unhashed = _clusters_cached(
        conn, list(project_ids), include_archived, list(kinds), threshold, dhash_threshold, exclude_lineage
    )
    decisions = _decisions(conn)
    out = []
    hidden = 0
    for members in clusters:
        members = [dict(m, decision=decisions.get((m["kind"], m["id"]))) for m in members]
        resolved = _is_resolved(members)
        if resolved and not include_resolved:
            hidden += 1
            continue
        canonical = [m for m in members if m["decision"] == "canonical"]
        anchor = canonical[0] if canonical else min(members, key=lambda m: (m["date_added"] or "", m["id"]))
        pairwise = [_distance(a, b) for i, a in enumerate(members) for b in members[i + 1:]]
        for m in members:
            m["distance_to_anchor"] = 0 if m is anchor else _distance(anchor, m)
        members.sort(key=lambda m: (m is not anchor, m["distance_to_anchor"] if m["distance_to_anchor"] is not None else 99))
        out.append({
            "anchor_id": anchor["id"],
            "anchor_kind": anchor["kind"],
            "max_distance": max((d for d in pairwise if d is not None), default=0),
            "resolved": resolved,
            "members": members,
        })

    # Per-member usage, only for what's being returned.
    source_ids = {m["id"] for c in out for m in c["members"] if m["kind"] == "source"}
    ref_ids = {m["id"] for c in out for m in c["members"] if m["kind"] == "reference"}
    counts = _result_counts(conn, source_ids)
    uses = _reference_uses(conn, ref_ids)
    for c in out:
        for m in c["members"]:
            for k in ("phash", "dhash", "content_hash", "aspect", "parent_image_id"):
                m.pop(k, None)
            if m["kind"] == "source":
                m["result_counts"] = counts[m["id"]]
            else:
                m["used_in_results"] = uses[m["id"]]
    out.sort(key=lambda c: (c["resolved"], -len(c["members"]), c["max_distance"]))
    return {"clusters": out, "total_items": total, "unhashed": unhashed, "resolved_hidden": hidden}


def set_decisions(items, cluster_anchor_id=None):
    """Applies [{kind, id, role}] in one transaction; role None clears it."""
    conn = db.get_connection()
    for it in items:
        if it["role"] is None:
            conn.execute("DELETE FROM dup_decisions WHERE image_kind = ? AND image_id = ?", (it["kind"], it["id"]))
        else:
            conn.execute(
                """INSERT INTO dup_decisions (image_kind, image_id, role, cluster_anchor_id) VALUES (?, ?, ?, ?)
                   ON CONFLICT (image_kind, image_id) DO UPDATE
                   SET role = excluded.role, cluster_anchor_id = excluded.cluster_anchor_id, date_set = CURRENT_TIMESTAMP""",
                (it["kind"], it["id"], it["role"], cluster_anchor_id),
            )
    conn.commit()


def merge_references(keep_id, remove_ids):
    """Folds duplicate references into keep_id: results that used a removed
    reference now point at keep_id, then the removed ones go to the trash.
    All must be live and in keep_id's project (references are per project).
    Raises ValueError otherwise, before changing anything.
    """
    conn = db.get_connection()
    keep = db.get_reference_image(keep_id)
    if not keep or keep["is_deleted"]:
        raise ValueError("Reference to keep not found")
    removals = [r for r in dict.fromkeys(remove_ids) if r != keep_id]
    for ref_id in removals:
        ref = db.get_reference_image(ref_id)
        if not ref or ref["is_deleted"]:
            raise ValueError(f"Reference {ref_id} not found")
        if ref["project_id"] != keep["project_id"]:
            raise ValueError("Can't merge references from different projects")
    for ref_id in removals:
        # A result that used both keeps a single entry for keep_id.
        conn.execute(
            """DELETE FROM result_references WHERE reference_image_id = ? AND result_id IN
               (SELECT result_id FROM result_references WHERE reference_image_id = ?)""",
            (ref_id, keep_id),
        )
        conn.execute("UPDATE result_references SET reference_image_id = ? WHERE reference_image_id = ?", (keep_id, ref_id))
        conn.execute("UPDATE reference_images SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (ref_id,))
    conn.commit()
    return {"kept": keep_id, "merged": removals}
