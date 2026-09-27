"""Cross-library export: a zip of the results matching a management filter.

Layout, with <name> the slugged export name and one folder per project so
same-named images from different libraries can't collide:

    <name>/results/<project>/<image>_<result8>.png         (images)
    <name>/side_by_side/<project>/<image>_<result8>_ab.png (side_by_side)
    <name>/sources/<project>/<image>_<image8>[_<crop8>].png (include_sources)
    <name>/references/<project>/<ref>_<ref8>.png            (include_references)
    <name>/manifest.json, manifest.csv                      (sidecar)
    <name>/report.html                                      (html_report)

Sources are the image as the engine saw it: when a result records a
pre-process (crop/rotate/pad), the processed render, suffixed with its
settings hash; include_originals adds the untouched file as well.

Exports run on a background thread (start_export) because a cross-library
zip can take a while; progress lives in memory like jobs.py and is lost on
restart, which is fine for a download that's fetched right away.
"""

import csv
import html
import io
import json
import threading
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

import config as cfg
import db
import manage_db
import preprocess
import storage

JOB_TTL_SECONDS = 3600

_lock = threading.Lock()
_jobs = {}

MANIFEST_FIELDS = [
    "result_id", "project_id", "project_name", "image_id", "image_display_name",
    "evaluation", "is_active_result", "prompt_text", "prompt_hash", "revised_prompt",
    "engine", "model", "aspect_ratio", "max_dim", "date_generated", "copy_count",
    "result_file", "side_by_side_file", "source_file", "source_original_file",
    "reference_files", "derived_from",
]


def all_filtered_results(f, page=500):
    """Every result matching ManageFilterIn f, in its sort order."""
    items, offset = [], 0
    while True:
        chunk = manage_db.list_filtered_results(f, offset=offset, limit=page)
        items.extend(chunk["items"])
        offset += page
        if offset >= chunk["total"] or not chunk["items"]:
            return items


def _ancestors(image):
    """Display names of the images this one was promoted from, nearest first."""
    from routers.images import _resolve_ancestors

    return [a["display_name"] for a in _resolve_ancestors(image)]


class _Builder:
    def __init__(self, zf, root, options):
        self.zf = zf
        self.root = root
        self.o = options
        self.written = set()
        self.project_slugs = {}
        self.images = {}
        self.refs = {}

    def _slug(self, project_id):
        if project_id not in self.project_slugs:
            project = db.get_project(project_id)
            self.project_slugs[project_id] = (project or {}).get("slug") or storage.slugify(project_id)
        return self.project_slugs[project_id]

    def _put_file(self, arcname, path):
        if arcname in self.written:
            return arcname
        if not Path(path).exists():
            return ""
        self.zf.write(path, f"{self.root}/{arcname}")
        self.written.add(arcname)
        return arcname

    def _put_image(self, arcname, img):
        if arcname not in self.written:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            self.zf.writestr(f"{self.root}/{arcname}", buf.getvalue())
            self.written.add(arcname)
        return arcname

    def image(self, image_id):
        if image_id not in self.images:
            self.images[image_id] = db.get_image(image_id)
        return self.images[image_id]

    def add(self, r):
        """Writes what the options ask for one result; returns its manifest row."""
        project = self._slug(r["project_id"])
        stem = f"{storage.slugify(r.get('image_display_name') or 'result')}_{r['id'][:8]}"
        result_path = storage.result_image_path(r["project_id"], r["file_path"])
        image = self.image(r["image_id"])
        source_path = storage.source_image_path(image["project_id"], image["file_name"]) if image else None
        row = {
            "result_id": r["id"], "project_id": r["project_id"], "project_name": r["project_name"],
            "image_id": r["image_id"], "image_display_name": r["image_display_name"],
            "evaluation": r.get("evaluation") or "UNRATED", "is_active_result": bool(r["is_active_result"]),
            "prompt_text": r.get("adhoc_prompt_text") or "", "prompt_hash": r.get("prompt_hash") or "",
            "revised_prompt": r.get("revised_prompt") or "", "engine": r.get("engine") or "",
            "model": r.get("model") or "", "aspect_ratio": r.get("aspect_ratio") or "",
            "max_dim": r.get("max_dim") or "", "date_generated": r.get("date_generated") or "",
            "copy_count": r.get("copy_count", 1),
            "result_file": "", "side_by_side_file": "", "source_file": "", "source_original_file": "",
            "reference_files": [], "derived_from": _ancestors(image) if image else [],
        }

        if self.o.images:
            row["result_file"] = self._put_file(f"results/{project}/{stem}.png", result_path)

        # The engine's input: the processed render when the result recorded
        # one, else the stored source file.
        engine_input = source_path
        crop = r.get("source_preprocess")
        if image and crop and source_path and source_path.exists():
            engine_input = storage.get_or_create_processed(image["project_id"], image["id"], source_path, crop)

        if self.o.side_by_side and result_path.exists():
            arc = f"side_by_side/{project}/{stem}_ab.png"
            if arc not in self.written:
                composite = storage._make_side_by_side(engine_input, result_path)
                if composite is not None:
                    self._put_image(arc, composite)
            row["side_by_side_file"] = arc if arc in self.written else ""

        if self.o.include_sources and image and source_path:
            src_stem = f"{storage.slugify(image['display_name'])}_{image['id'][:8]}"
            src_project = self._slug(image["project_id"])
            original = f"sources/{src_project}/{src_stem}.png"
            if crop:
                row["source_file"] = self._put_file(
                    f"sources/{src_project}/{src_stem}_{preprocess.cache_key(crop)[:8]}.png", engine_input
                )
                if self.o.include_originals:
                    row["source_original_file"] = self._put_file(original, source_path)
            else:
                row["source_file"] = self._put_file(original, source_path)

        if self.o.include_references:
            for ref_id in r.get("reference_image_ids") or []:
                if ref_id not in self.refs:
                    self.refs[ref_id] = db.get_reference_image(ref_id)
                ref = self.refs[ref_id]
                if not ref:
                    continue  # hard-deleted: only the id is left
                path = storage.reference_image_path(ref["project_id"], ref["file_name"])
                arc = f"references/{self._slug(ref['project_id'])}/{storage.slugify(ref['display_name'])}_{ref_id[:8]}{path.suffix or '.png'}"
                if self._put_file(arc, path):
                    row["reference_files"].append(arc)
        return row


def _manifest_csv(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=MANIFEST_FIELDS)
    w.writeheader()
    for row in rows:
        w.writerow({k: "; ".join(v) if isinstance(v, list) else v for k, v in row.items()})
    return buf.getvalue()


_EVAL_COLOURS = {"YES": "#16a34a", "MAYBE": "#d97706", "NO": "#dc2626", "UNRATED": "#2563eb"}


def _html_report(name, rows, group_by, meta):
    esc = html.escape
    groups = {}
    for row in rows:
        key = (row["prompt_text"] or "(no prompt)") if group_by == "prompt" else row["project_name"]
        groups.setdefault(key, []).append(row)

    def card(row):
        img = row["result_file"] or row["side_by_side_file"]
        pic = f'<a href="{esc(img)}"><img src="{esc(img)}" loading="lazy" alt=""></a>' if img else '<div class="noimg">no image in export</div>'
        colour = _EVAL_COLOURS.get(row["evaluation"], "#6b7280")
        lines = [
            f'<b>{esc(row["image_display_name"])}</b>',
            esc(row["project_name"]) if group_by == "prompt" else esc(row["prompt_text"][:160] or "(no prompt)"),
            esc(" · ".join(x for x in (row["engine"], row["model"], row["date_generated"][:16]) if x)),
        ]
        if row["revised_prompt"]:
            lines.append(f'<i>revised:</i> {esc(row["revised_prompt"][:200])}')
        return (f'<figure style="border-bottom-color:{colour}">{pic}<figcaption>'
                f'<span class="ev" style="background:{colour}">{esc(row["evaluation"])}</span> '
                + "<br>".join(lines) + "</figcaption></figure>")

    sections = "\n".join(
        f'<section><h2>{esc(key)} <small>({len(items)})</small></h2><div class="grid">{"".join(card(r) for r in items)}</div></section>'
        for key, items in groups.items()
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(name)}</title>
<style>
  body {{ font: 13px/1.4 system-ui, sans-serif; margin: 24px; color: #111; background: #fff; }}
  header p {{ color: #555; margin: 4px 0 16px; }}
  h1 {{ margin: 0; font-size: 22px; }}
  h2 {{ font-size: 15px; margin: 28px 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 4px; white-space: pre-wrap; }}
  h2 small {{ color: #777; font-weight: normal; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }}
  figure {{ margin: 0; border: 1px solid #ddd; border-bottom: 4px solid #999; border-radius: 6px; overflow: hidden; break-inside: avoid; }}
  figure img {{ display: block; width: 100%; height: 220px; object-fit: contain; background: #f3f4f6; }}
  .noimg {{ height: 80px; display: flex; align-items: center; justify-content: center; color: #999; background: #f3f4f6; }}
  figcaption {{ padding: 6px 8px; font-size: 12px; overflow-wrap: anywhere; }}
  .ev {{ color: #fff; border-radius: 3px; padding: 0 5px; font-size: 11px; font-weight: 600; }}
  @media print {{
    body {{ margin: 0; }}
    section {{ break-before: auto; }}
    h2 {{ break-after: avoid; }}
    .grid {{ grid-template-columns: repeat(3, 1fr); }}
    figure img {{ height: 180px; }}
  }}
</style></head><body>
<header><h1>{esc(name)}</h1><p>{esc(meta)}</p></header>
{sections}
</body></html>"""


def build_export(name, results, options, progress=None):
    """Writes the zip for results (rows from manage_db.list_filtered_results)
    per options (models.ExportOptions) and returns its path. progress(done,
    total) is called after each result."""
    cfg.EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    slug = storage.slugify(name, max_len=60)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_path = cfg.EXPORTS_DIR / f"{stamp}_{slug}.zip"
    tmp_path = zip_path.with_suffix(".part")
    rows = []
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        builder = _Builder(zf, slug, options)
        for i, r in enumerate(results, 1):
            rows.append(builder.add(r))
            if progress:
                progress(i, len(results))
        projects = sorted({r["project_name"] for r in rows})
        meta = (f"{len(rows)} results from {len(projects)} {'library' if len(projects) == 1 else 'libraries'} "
                f"({', '.join(projects)}) · exported {datetime.now().strftime('%Y-%m-%d %H:%M')}")
        if options.sidecar:
            zf.writestr(f"{slug}/manifest.json", json.dumps({"name": name, "exported": stamp, "results": rows}, indent=2))
            zf.writestr(f"{slug}/manifest.csv", _manifest_csv(rows))
        if options.html_report:
            zf.writestr(f"{slug}/report.html", _html_report(name, rows, options.group_by, meta))
    tmp_path.replace(zip_path)
    return zip_path


# ---------------------------------------------------------------------------
# Background jobs
# ---------------------------------------------------------------------------


def _prune():
    cutoff = time.time() - JOB_TTL_SECONDS
    for job_id in [k for k, j in _jobs.items() if (j["finished_at"] or time.time()) < cutoff]:
        _jobs.pop(job_id, None)


def job_status(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def job_file(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return Path(job["path"]) if job and job["status"] == "done" else None


def _update(job_id, **fields):
    with _lock:
        _jobs[job_id].update(fields)


def start_export(name, f, options):
    """Starts building the export for ManageFilterIn f; returns the job dict."""
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "name": name, "status": "running", "done": 0, "total": 0,
           "error": None, "file_name": None, "path": None, "started_at": time.time(), "finished_at": None}
    with _lock:
        _prune()
        _jobs[job_id] = job

    def run():
        try:
            results = all_filtered_results(f)
            _update(job_id, total=len(results))
            if not results:
                raise ValueError("No results match this filter")
            path = build_export(name, results, options, progress=lambda d, t: _update(job_id, done=d))
            _update(job_id, status="done", path=str(path), file_name=path.name, finished_at=time.time())
        except Exception as e:  # reported to the client through the job
            _update(job_id, status="error", error=str(e), finished_at=time.time())

    threading.Thread(target=run, name=f"export-{job_id[:8]}", daemon=True).start()
    return {k: v for k, v in job.items() if k != "path"}
