"""HTTP caching and compression for running the app over a slow link.

Every image URL is keyed by an id that never gets reused, so most of them can
be cached by the browser instead of revalidated on each view (a revalidation
is a full round trip even when it ends in a cheap 304). The policies differ
only in how the file behind a URL can change:

- IMMUTABLE: never rewritten (result images and their thumbnails/previews).
- STABLE: only rewritten by the storage page's downscale, which keeps the
  picture the same and just lowers its resolution, so a cached copy that is
  briefly out of date still looks right. (The crop editor takes the size
  from the image record, not from the file it loads.)
- REVALIDATE: replaced in place by ordinary edits (reference re-crops and
  SAM3 placements), so the browser must check with the server every time.

All of them are `private`: the library holds personal images, and a shared
cache (a proxy along the way) must never keep a copy.

Static assets (JS/CSS) are versioned by content hash and injected into the
HTML pages at serve time, see AssetVersioner.
"""

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import parse_qs

from fastapi.responses import FileResponse, HTMLResponse, Response
from starlette.middleware.gzip import GZipMiddleware
from starlette.staticfiles import StaticFiles

IMMUTABLE = "private, max-age=31536000, immutable"
STABLE = "private, max-age=86400, stale-while-revalidate=2592000"
REVALIDATE = "private, no-cache"


def image_response(path, media_type=None, policy=STABLE):
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": policy})


# --- static assets -----------------------------------------------------------

_IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\./[^"']+\.js)["']""")
_ASSET_REF_RE = re.compile(r"""(href|src)="(/(?:js|css)/[^"?]+)\"""")


class AssetVersioner:
    """Serves the HTML pages with every JS/CSS URL pinned to a hash of the
    file's contents, so the assets themselves can be cached forever.

    The <script> and <link> tags in the page are rewritten directly. Modules
    loaded through `import` statements are pinned with an import map instead
    (it remaps the resolved /js/x.js URL to /js/x.js?v=...), and listed as
    <link rel="modulepreload"> so the browser fetches the whole module graph
    in parallel rather than discovering it one import level per round trip.

    Hashes are recomputed whenever a file's mtime/size changes, so edits during
    development show up on the next page load without a server restart.
    """

    def __init__(self, static_dir):
        self.static_dir = Path(static_dir)
        self._hashes = {}  # url path -> (mtime_ns, size, hash)

    def version(self, url_path):
        file = self.static_dir / url_path.lstrip("/")
        st = file.stat()
        cached = self._hashes.get(url_path)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]
        digest = hashlib.sha256(file.read_bytes()).hexdigest()[:12]
        self._hashes[url_path] = (st.st_mtime_ns, st.st_size, digest)
        return digest

    def _module_graph(self, entry):
        """Every /js/ module reachable from `entry` through static or dynamic
        relative imports, entry first."""
        seen = []
        stack = [entry]
        while stack:
            url_path = stack.pop()
            if url_path in seen:
                continue
            seen.append(url_path)
            source = (self.static_dir / url_path.lstrip("/")).read_text(encoding="utf-8")
            base = url_path.rsplit("/", 1)[0]
            for rel in _IMPORT_RE.findall(source):
                stack.append(f"{base}/{rel[2:]}")
        return seen

    def render(self, html_file):
        html = (self.static_dir / html_file).read_text(encoding="utf-8")
        entries = re.findall(r'<script type="module" src="(/js/[^"?]+)"', html)
        modules = []
        for entry in entries:
            modules += [m for m in self._module_graph(entry) if m not in modules]
        html = _ASSET_REF_RE.sub(lambda m: f'{m.group(1)}="{m.group(2)}?v={self.version(m.group(2))}"', html)
        import_map = {"imports": {m: f"{m}?v={self.version(m)}" for m in modules}}
        preloads = "".join(
            f'<link rel="modulepreload" href="{m}?v={self.version(m)}" />\n' for m in modules if m not in entries
        )
        head = f'<script type="importmap">{json.dumps(import_map)}</script>\n{preloads}'
        return html.replace("</head>", head + "</head>", 1)

    def page_response(self, request, html_file):
        """The rendered page, revalidated on every load (a 304 when nothing
        changed) so a new asset version is always picked up."""
        body = self.render(html_file).encode("utf-8")
        etag = '"' + hashlib.sha256(body).hexdigest()[:16] + '"'
        headers = {"Cache-Control": REVALIDATE, "ETag": etag}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return HTMLResponse(body, headers=headers)


class VersionedStaticFiles(StaticFiles):
    """Static files: cached forever when requested with the file's current
    ?v= content hash (as AssetVersioner writes it), otherwise revalidated on
    every load. A stale hash from an old page gets the current contents, which
    must not be cached forever under that old URL."""

    def __init__(self, versioner, **kwargs):
        super().__init__(**kwargs)
        self.versioner = versioner

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        current = False
        if response.status_code == 200:
            requested = parse_qs(scope.get("query_string", b"").decode()).get("v", [None])[0]
            try:
                current = requested is not None and requested == self.versioner.version("/" + path.replace("\\", "/"))
            except OSError:
                current = False
        response.headers["Cache-Control"] = IMMUTABLE if current else REVALIDATE
        return response


# --- compression -------------------------------------------------------------

# Last path segments of the routes that serve image files or zips: those are
# already compressed, so gzipping them just burns server CPU.
_BINARY_ENDPOINTS = {"file", "thumbnail", "preview", "processed", "source", "side-by-side", "original", "download"}


class SelectiveGZipMiddleware:
    """Gzips text responses (pages, JS, CSS, JSON) and leaves image and zip
    downloads alone."""

    def __init__(self, app, minimum_size=1024):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=6)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not self._is_binary(scope["path"]):
            await self.gzip(scope, receive, send)
        else:
            await self.app(scope, receive, send)

    @staticmethod
    def _is_binary(path):
        if not path.startswith("/api/") and not path.startswith("/manage/"):
            return False
        last = path.rstrip("/").rsplit("/", 1)[-1]
        return last in _BINARY_ENDPOINTS or last.endswith(".zip") or "/export" in path
