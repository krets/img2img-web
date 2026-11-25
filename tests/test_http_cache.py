"""Cache headers and asset versioning (http_cache.py)."""

import re

from PIL import Image

import http_cache


def _img():
    return Image.new("RGB", (64, 48), (120, 40, 200))


def test_image_routes_cache_policies(client, lib):
    p = lib.project("P")
    image = lib.source(p, "src", img=_img(), write=True)
    result = lib.result(image, img=_img(), source_preprocess={"rotation": 0})
    legacy = lib.result(image, img=_img())  # no recorded crop: follows the image's current one
    ref = lib.reference(p, "ref", img=_img(), write=True)

    expected = {
        f"/api/results/{result}/file": http_cache.IMMUTABLE,
        f"/api/results/{result}/thumbnail": http_cache.IMMUTABLE,
        f"/api/results/{result}/preview": http_cache.IMMUTABLE,
        f"/api/images/{image}/file": http_cache.STABLE,
        f"/api/images/{image}/thumbnail": http_cache.STABLE,
        f"/api/images/{image}/preview": http_cache.STABLE,
        f"/api/results/{result}/side-by-side": http_cache.STABLE,
        f"/api/results/{legacy}/source": http_cache.REVALIDATE,
        f"/api/reference-images/{ref}/file": http_cache.REVALIDATE,
        f"/api/reference-images/{ref}/thumbnail": http_cache.REVALIDATE,
    }
    for url, policy in expected.items():
        r = client.get(url, headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200, url
        assert r.headers["cache-control"] == policy, url
        assert "content-encoding" not in r.headers, url  # images aren't re-compressed


def test_pages_pin_assets_to_content_hashes(client):
    r = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert r.headers["cache-control"] == http_cache.REVALIDATE
    assert r.headers["content-encoding"] == "gzip"
    html = r.text
    entry = re.search(r'<script type="module" src="/js/app\.js\?v=([0-9a-f]+)"', html)
    assert entry
    assert '<script type="importmap">' in html
    assert re.search(r'"/js/api\.js": "/js/api\.js\?v=[0-9a-f]+"', html)  # imported, not linked directly
    assert re.search(r'<link rel="modulepreload" href="/js/viewer\.js\?v=[0-9a-f]+"', html)
    assert html.index('type="importmap"') < html.index('type="module"')

    assert client.get("/", headers={"If-None-Match": r.headers["etag"]}).status_code == 304

    current = client.get(f"/js/app.js?v={entry.group(1)}")
    assert current.headers["cache-control"] == http_cache.IMMUTABLE
    for url in ("/js/app.js", "/js/app.js?v=stale"):
        assert client.get(url).headers["cache-control"] == http_cache.REVALIDATE, url

    manage = client.get("/manage")
    assert manage.status_code == 200
    assert re.search(r'src="/js/manage\.js\?v=[0-9a-f]+"', manage.text)
