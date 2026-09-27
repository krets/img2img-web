"""Management API: /api/manage/* plus the cross-project merge guard, through
the HTTP layer against an isolated workspace (see conftest.py)."""

import random

import pytest

import db
from tests.hash_fixtures import jpeg, scene

ALL = {"dedupe_copies": False}


def results(client, offset=0, limit=100, **body):
    r = client.post(f"/api/manage/results?offset={offset}&limit={limit}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def ids(page):
    return [i["id"] for i in page["items"]]


# ---------------------------------------------------------------------------
# mgmt_index / summary: soft-deleted rows drop out at every level
# ---------------------------------------------------------------------------


def test_summary_excludes_deleted_at_every_level(client, lib):
    a = lib.project("A")
    gone = lib.project("Gone")
    arch = lib.project("Arch", archived=True)
    img = lib.source(a, "img")
    lib.result(img)
    lib.soft_delete("results", lib.result(img))            # result deleted
    dead_img = lib.source(a, "dead")
    lib.result(dead_img)                                    # live result under a deleted image
    lib.soft_delete("images", dead_img)
    lib.reference(a, "ref")
    lib.soft_delete("reference_images", lib.reference(a, "old ref"))
    lib.result(lib.source(gone, "g"))
    lib.reference(gone, "gref")
    lib.soft_delete("projects", gone)                      # everything under a deleted project
    lib.result(lib.source(arch, "x"))

    body = client.get("/api/manage/summary").json()
    assert body["totals"] == {"source": 1, "reference": 1, "result": 1}
    assert [p["project_name"] for p in body["projects"]] == ["A"]
    with_arch = client.get("/api/manage/summary?include_archived=true").json()
    assert with_arch["totals"] == {"source": 2, "reference": 1, "result": 2}
    view = db.get_connection().execute("SELECT kind, COUNT(*) FROM mgmt_index GROUP BY kind").fetchall()
    assert dict(view) == {"source": 2, "reference": 1, "result": 2}  # the view itself ignores archiving


# ---------------------------------------------------------------------------
# Filtered results
# ---------------------------------------------------------------------------


@pytest.fixture
def two_projects(lib):
    a, b, z = lib.project("A"), lib.project("B"), lib.project("Zarch", archived=True)
    ia, ib, iz = lib.source(a, "a"), lib.source(b, "b"), lib.source(z, "z")
    r = {
        "a1": lib.result(ia, "YES", "p one", content="C1", when="2026-09-01 10:00:00", active=1),
        "a2": lib.result(ia, "NO", "p two", when="2026-09-02 10:00:00", engine="fal"),
        "a3": lib.result(ia, None, "p one", when="2026-09-03 23:59:59"),
        "b1": lib.result(ib, "MAYBE", "p one", content="C1", when="2026-08-31 10:00:00"),  # earlier copy of a1
        "b2": lib.result(ib, "YES", None, content="C2", when="2026-09-05 10:00:00", active=1),
        "z1": lib.result(iz, "YES", "p one", when="2026-09-06 10:00:00"),
    }
    lib.soft_delete("results", lib.result(ia, "YES", when="2026-09-04 10:00:00"))
    return {"A": a, "B": b, "Z": z, **r}


def test_results_filters(client, two_projects):
    t = two_projects
    page = results(client, **ALL)
    assert page["total"] == 5
    assert ids(page) == [t["b2"], t["a3"], t["a2"], t["a1"], t["b1"]]
    item = page["items"][0]
    for key in ("project_id", "project_name", "image_display_name", "image_file_name", "reference_image_ids", "copy_count"):
        assert key in item
    assert "copy_rank" not in item and "total" not in item
    assert results(client, include_archived=True, **ALL)["total"] == 6
    assert ids(results(client, project_ids=[t["Z"]])) == [t["z1"]]            # listed archived project is used
    assert results(client, evaluations=["YES"], **ALL)["total"] == 2
    assert ids(results(client, evaluations=["UNRATED"])) == [t["a3"]]          # NULL counts as UNRATED
    assert ids(results(client, engines=["fal"])) == [t["a2"]]
    assert sorted(ids(results(client, active_only=True, **ALL))) == sorted([t["a1"], t["b2"]])
    assert sorted(ids(results(client, date_from="2026-09-01", date_to="2026-09-03", **ALL))) == sorted(
        [t["a1"], t["a2"], t["a3"]]
    )


def test_results_dedupe_copies(client, two_projects):
    t = two_projects
    page = results(client)
    assert page["total"] == 4
    assert t["b1"] in ids(page) and t["a1"] not in ids(page)                   # earliest copy wins
    assert {i["id"]: i["copy_count"] for i in page["items"]}[t["b1"]] == 2
    only_a = ids(results(client, project_ids=[t["A"]]))
    assert t["a1"] in only_a                                                   # a copy outside the selection can't hide it


def test_results_sorts_and_paging(client, two_projects):
    t = two_projects
    assert ids(results(client, sort="date_asc", **ALL))[0] == t["b1"]
    assert ids(results(client, sort="evaluation", **ALL))[:2] == [t["b2"], t["a1"]]
    assert [i["project_name"] for i in results(client, sort="project")["items"]] == ["A", "A", "B", "B"]
    page = results(client, offset=1, limit=2, **ALL)
    assert page["total"] == 5 and ids(page) == [t["a3"], t["a2"]]
    past_end = results(client, offset=50, limit=10, **ALL)
    assert past_end == {"total": 5, "items": []}


@pytest.mark.parametrize("body", [{"sort": "bogus"}, {"date_from": "yesterday"}, {"evaluations": ["GOOD"]}])
def test_results_rejects_bad_filters(client, body):
    assert client.post("/api/manage/results", json=body).status_code == 422


def test_results_limit_bounds(client):
    assert client.post("/api/manage/results?limit=501", json={}).status_code == 422
    assert client.post("/api/manage/results?offset=-1", json={}).status_code == 422


# ---------------------------------------------------------------------------
# Prompt report
# ---------------------------------------------------------------------------


def test_prompt_report_matches_click_through(client, lib):
    a, b = lib.project("A"), lib.project("B")
    imgs = [lib.source(p, f"i{p[:4]}{k}") for p in (a, b) for k in range(3)]
    rnd = random.Random(1)
    texts = ["a cat  in a hat", "a cat in a hat", " A dog ", "sunset", None, ""]
    for k in range(120):
        t = rnd.choice(texts)
        lib.result(rnd.choice(imgs), rnd.choice(["YES", "NO", "MAYBE", "UNRATED", None]), t,
                   content=f"C{rnd.randint(0, 40)}", revised=f"rev {t}" if t == "sunset" and k % 2 else None)
    db.create_prompt("Cat", "a cat in a hat")

    groups = client.post("/api/manage/prompts", json={}).json()["groups"]
    assert len(groups) == 4                                                    # cat (both spacings), dog, sunset, none
    assert [g["n"] for g in groups] == sorted((g["n"] for g in groups), reverse=True)
    by_text = {g["text"]: g for g in groups}
    assert by_text["a cat in a hat"]["palette_title"] == "Cat"
    assert by_text[None]["prompt_hash"] is None
    for g in groups:
        h = [g["prompt_hash"]]
        assert results(client, prompt_hashes=h, **ALL)["total"] == g["n"]
        assert results(client, prompt_hashes=h)["total"] == g["unique_n"]     # dedupe_copies on
        assert g["yes"] + g["maybe"] + g["no"] + g["unrated"] == g["n"]
    assert len(client.post("/api/manage/prompts", json={"prompt_hashes": [groups[0]["prompt_hash"]]}).json()["groups"]) == 4

    sunset = by_text["sunset"]
    revised = client.post(f"/api/manage/prompts/{sunset['prompt_hash']}/revised", json={}).json()
    assert [r["revised_prompt"] for r in revised] == ["rev sunset"] and sunset["revised_n"] == 1

    only_a = {g["prompt_hash"]: g for g in client.post("/api/manage/prompts", json={"project_ids": [a]}).json()["groups"]}
    cat = by_text["a cat in a hat"]["prompt_hash"]
    assert only_a[cat]["n"] == results(client, project_ids=[a], prompt_hashes=[cat], **ALL)["total"]


# ---------------------------------------------------------------------------
# Duplicates
# ---------------------------------------------------------------------------


@pytest.fixture
def dup_lib(lib):
    rnd = random.Random(5)
    s1, s2, s3 = scene(rnd, 256, 256), scene(rnd, 208, 304), scene(rnd, 304, 208)
    a, b = lib.project("A"), lib.project("B")
    d = {"A": a, "B": b}
    d["a1"] = lib.source(a, "s1", s1, when="2026-09-01 10:00:00")
    d["a1j"] = lib.source(a, "s1 jpeg", jpeg(s1, 60), when="2026-09-02 10:00:00")
    d["b1"] = lib.source(b, "s1 half", s1.resize((128, 128)), when="2026-08-30 10:00:00")
    d["ref1"] = lib.reference(b, "s1 ref", s1)
    d["a2"] = lib.source(a, "s2", s2, content="same")
    d["b2"] = lib.source(b, "s2 copy", s2, content="same")
    d["a3"] = lib.source(a, "s3", s3)
    parent_result = lib.result(d["a3"])
    d["child"] = lib.source(a, "s3 edit", jpeg(s3, 90), parent_result=parent_result)
    d["unhashed"] = lib.source(a, "unhashed")
    for ev in ("YES", "YES", "NO"):
        lib.result(d["a1"], ev)
    lib.use_reference(lib.result(d["b1"]), d["ref1"])
    return d


def dup(client, **body):
    r = client.post("/api/manage/duplicates", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def member_sets(out):
    return sorted((sorted(m["id"] for m in c["members"]) for c in out["clusters"]), key=len)


def test_duplicate_clusters(client, dup_lib):
    d = dup_lib
    out = dup(client)
    assert member_sets(out) == sorted([sorted([d["a2"], d["b2"]]), sorted([d["a1"], d["a1j"], d["b1"], d["ref1"]])], key=len)
    assert out["unhashed"] == 1
    s1 = next(c for c in out["clusters"] if len(c["members"]) == 4)
    assert s1["anchor_id"] == d["b1"] and s1["members"][0]["id"] == d["b1"]    # earliest added
    mem = {m["id"]: m for m in s1["members"]}
    assert mem[d["a1"]]["result_counts"] == {"YES": 2, "MAYBE": 0, "NO": 1, "UNRATED": 0}
    assert mem[d["ref1"]]["used_in_results"] == 1
    assert not {"phash", "dhash", "content_hash", "parent_image_id"} & set(mem[d["a1"]])
    s2 = next(c for c in out["clusters"] if len(c["members"]) == 2)
    assert s2["max_distance"] == 0


def test_duplicate_options(client, dup_lib):
    d = dup_lib
    assert [d["a3"], d["child"]] not in member_sets(dup(client))
    assert sorted([d["a3"], d["child"]]) in member_sets(dup(client, exclude_lineage=False))
    assert member_sets(dup(client, project_ids=[d["A"]])) == [sorted([d["a1"], d["a1j"]])]
    assert all(m["kind"] == "source" for c in dup(client, kinds=["source"])["clusters"] for m in c["members"])
    assert client.post("/api/manage/duplicates", json={"threshold": 17}).status_code == 422


def test_duplicate_decisions_resolve(client, dup_lib):
    d = dup_lib
    post = lambda items: client.post("/api/manage/duplicates/decisions", json={"items": items})
    assert post([{"kind": "source", "id": d["a1"], "role": "canonical"}]).status_code == 200
    s1 = next(c for c in dup(client)["clusters"] if len(c["members"]) == 4)
    assert s1["anchor_id"] == d["a1"] and not s1["resolved"]
    post([{"kind": "source", "id": d["a1j"], "role": "ignore"}, {"kind": "source", "id": d["b1"], "role": "ignore"},
          {"kind": "reference", "id": d["ref1"], "role": "ignore"}])
    out = dup(client)
    assert out["resolved_hidden"] == 1 and len(out["clusters"]) == 1
    shown = dup(client, include_resolved=True)
    assert shown["clusters"][-1]["resolved"] and len(shown["clusters"][-1]["members"]) == 4
    post([{"kind": "source", "id": d["a1j"], "role": None}])
    assert dup(client)["resolved_hidden"] == 0
    post([{"kind": "source", "id": d["a2"], "role": "ignore"}])                # all but one ignored
    assert all(d["a2"] not in [m["id"] for m in c["members"]] for c in dup(client)["clusters"])


def test_duplicate_cache_follows_changes(client, lib, dup_lib):
    d = dup_lib
    dup(client)
    rnd = random.Random(9)
    s4 = scene(rnd, 256, 256)
    x = lib.source(d["A"], "s4", s4)
    y = lib.source(d["B"], "s4 jpeg", jpeg(s4, 60))
    assert sorted([x, y]) in member_sets(dup(client))
    lib.soft_delete("images", y)
    assert all(y not in s for s in member_sets(dup(client)))


# ---------------------------------------------------------------------------
# Merge guards
# ---------------------------------------------------------------------------


def test_cross_project_merge_rejected(client, lib):
    a, b = lib.project("A"), lib.project("B")
    keep, same, other = lib.source(a, "keep"), lib.source(a, "same"), lib.source(b, "other")
    r_same, r_other = lib.result(same), lib.result(other)
    lib.c.execute("INSERT INTO dup_decisions (image_kind, image_id, role) VALUES ('source', ?, 'ignore')", (same,))
    lib.c.commit()

    r = client.post("/api/images/merge", json={"keep_id": keep, "remove_ids": [same, other]})
    assert r.status_code == 400
    assert db.get_image(same) and db.get_result(r_same)["image_id"] == same   # nothing half-merged
    assert db.get_result(r_other)["image_id"] == other
    assert client.post("/api/images/merge", json={"keep_id": keep, "remove_ids": ["nope"]}).status_code == 404

    r = client.post("/api/images/merge", json={"keep_id": keep, "remove_ids": [same, same]})
    assert r.status_code == 200 and r.json()["merged"] == [same]
    assert db.get_image(same) is None and db.get_result(r_same)["image_id"] == keep
    assert db.get_connection().execute("SELECT COUNT(*) FROM dup_decisions").fetchone()[0] == 0


def test_merge_references(client, lib):
    a, b = lib.project("A"), lib.project("B")
    keep, d1, d2, other = (lib.reference(a, "keep"), lib.reference(a, "d1"), lib.reference(a, "d2"), lib.reference(b, "other"))
    img = lib.source(a, "img")
    r1, r2, both = lib.result(img), lib.result(img), lib.result(img)
    lib.use_reference(r1, d1)
    lib.use_reference(r2, d2)
    lib.use_reference(both, keep, 0)
    lib.use_reference(both, d1, 1)
    url = "/api/manage/duplicates/merge-references"

    assert client.post(url, json={"keep_id": keep, "remove_ids": [d1, other]}).status_code == 400
    assert db.get_reference_image(d1)["is_deleted"] == 0

    assert client.post(url, json={"keep_id": keep, "remove_ids": [d1, d2]}).json()["merged"] == [d1, d2]
    assert [db.get_reference_image(i)["is_deleted"] for i in (d1, d2, keep)] == [1, 1, 0]
    uses = lambda r: [x[0] for x in db.get_connection().execute(
        "SELECT reference_image_id FROM result_references WHERE result_id = ?", (r,))]
    assert uses(r1) == [keep] and uses(r2) == [keep] and uses(both) == [keep]
