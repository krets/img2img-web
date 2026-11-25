"""Saving a source's rotate/crop/pad settings (PUT /api/images/{id}/preprocess)."""

import json
from io import BytesIO

from PIL import Image


def test_preprocess_is_rendered_server_side(client, lib):
    """Apply sends only the settings; the server renders and caches the result."""
    p = lib.project("P")
    image = lib.source(p, "src", img=Image.new("RGB", (40, 30), (10, 200, 90)), write=True)
    params = {"rotation": 90, "crop": {"x": -5, "y": 0, "w": 40, "h": 40}, "fill": {"mode": "color", "color": "#ff0000"}}
    r = client.put(f"/api/images/{image}/preprocess", data={"params": json.dumps(params)})
    assert r.status_code == 200, r.text
    assert r.json()["preprocess"]["rotation"] == 90

    processed = client.get(f"/api/images/{image}/processed")
    assert processed.status_code == 200
    with Image.open(BytesIO(processed.content)) as out:
        assert out.size == (40, 40)
        assert out.getpixel((0, 20)) == (255, 0, 0)  # the overhang got the fill colour
