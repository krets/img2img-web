"""Near-duplicate detection against generated fixtures (tests/hash_fixtures.py):
edits that should still count as the same picture cluster with their original
at the default threshold (all of them, or most for the harder edits);
rotations and unrelated images don't."""

import pytest

import dupes
import storage
from tests.hash_fixtures import TRANSFORMS, build


@pytest.fixture(scope="module")
def fixtures():
    bases, variants = build(n_bases=24, seed=11)
    return bases, variants, [storage.compute_perceptual(b) for b in bases]


def _item(img, name):
    ph, dh = storage.compute_perceptual(img)
    return {"kind": "source", "id": name, "phash": ph, "dhash": dh, "aspect": img.width / img.height,
            "content_hash": None, "parent_image_id": None}


SLIDER_MAX = 16  # DuplicatesIn.threshold's upper bound
SAME = [n for n, (_, tier) in TRANSFORMS.items() if tier]


@pytest.mark.parametrize("name", SAME)
def test_edit_distance(fixtures, name):
    bases, variants, hashes = fixtures
    dists = [dupes.hamming(bh[0], storage.compute_perceptual(v)[0]) for bh, v in zip(hashes, variants[name])]
    within = sum(d <= dupes.DEFAULT_THRESHOLD for d in dists) / len(dists)
    if TRANSFORMS[name][1] == "all":
        assert within == 1, sorted(dists)
    else:
        assert within >= 0.9, sorted(dists)
        assert max(dists) <= SLIDER_MAX, sorted(dists)


@pytest.mark.parametrize("name", SAME)
def test_edit_clusters_with_original(fixtures, name):
    # Goes through the aspect bucketing, which is what a one-edge crop tests.
    bases, variants, _ = fixtures
    items = [_item(b, f"base{i}") for i, b in enumerate(bases)] + [_item(v, f"var{i}") for i, v in enumerate(variants[name])]
    clusters = [{items[i]["id"] for i in c} for c in dupes.cluster_items(items)]
    paired = sum(any({f"base{i}", f"var{i}"} <= c for c in clusters) for i in range(len(bases)))
    need = len(bases) if TRANSFORMS[name][1] == "all" else 0.9 * len(bases)
    assert paired >= need, f"{name}: {paired}/{len(bases)} paired"
    # At the slider's maximum even the harder edits all pair up.
    wide = [{items[i]["id"] for i in c} for c in dupes.cluster_items(items, threshold=SLIDER_MAX)]
    assert all(any({f"base{i}", f"var{i}"} <= c for c in wide) for i in range(len(bases)))


def test_rotation_does_not_match(fixtures):
    bases, variants, hashes = fixtures
    best = min(dupes.hamming(bh[0], storage.compute_perceptual(v)[0]) for bh, v in zip(hashes, variants["rotate_90"]))
    assert best > dupes.DEFAULT_THRESHOLD


def test_unrelated_images_stay_apart(fixtures):
    bases, _, hashes = fixtures
    closest = min(dupes.hamming(hashes[i][0], hashes[j][0]) for i in range(len(bases)) for j in range(i + 1, len(bases)))
    assert closest > dupes.DEFAULT_THRESHOLD
    items = [_item(b, f"base{i}") for i, b in enumerate(bases)]
    assert dupes.cluster_items(items) == []


def test_hamming_treats_stored_hashes_as_unsigned():
    assert dupes.hamming(-1, (1 << 63) - 1) == 1
    assert dupes.hamming(-1, -1) == 0
