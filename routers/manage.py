"""Cross-library management endpoints (see manage_db.py for the queries)."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

import dupes
import export
import hash_worker
import manage_db
from models import (DupDecisionsIn, DuplicatesIn, ManageExportIn, ManageFilterIn, MergeReferencesIn, ReportIn,
                    ReportUpdateIn)

router = APIRouter(prefix="/api/manage", tags=["manage"])


@router.get("/index/status")
def get_index_status():
    """Progress of the background hash backfill: rows still missing hashes, per kind."""
    return hash_worker.status()


@router.get("/summary")
def get_summary(include_archived: bool = False):
    return manage_db.index_summary(include_archived=include_archived)


@router.post("/results")
def list_results(f: ManageFilterIn, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    """One page of live results across projects matching the filter. Image URLs
    are built client-side from the result id (/api/results/{id}/thumbnail etc.).
    """
    return manage_db.list_filtered_results(f, offset=offset, limit=limit)


@router.post("/prompts")
def prompt_report(f: ManageFilterIn):
    """Results matching the filter grouped by prompt (f.prompt_hashes is ignored)."""
    return manage_db.prompt_report(f)


@router.post("/prompts/{prompt_hash}/revised")
def revised_prompts(prompt_hash: str, f: ManageFilterIn):
    """Distinct engine-revised versions of one prompt, with counts, within the filter."""
    return manage_db.revised_prompts(prompt_hash, f)


@router.post("/duplicates")
def find_duplicates(body: DuplicatesIn):
    """Clusters of near-duplicate sources/references across the selected projects."""
    return dupes.find_duplicates(
        project_ids=body.project_ids,
        include_archived=body.include_archived,
        kinds=body.kinds,
        threshold=body.threshold,
        dhash_threshold=body.dhash_threshold,
        exclude_lineage=body.exclude_lineage,
        include_resolved=body.include_resolved,
    )


@router.post("/duplicates/decisions")
def set_duplicate_decisions(body: DupDecisionsIn):
    """Marks members canonical / ignore (role null clears), all at once."""
    dupes.set_decisions([i.model_dump() for i in body.items], body.cluster_anchor_id)
    return {"ok": True}


@router.post("/duplicates/merge-references")
def merge_references(body: MergeReferencesIn):
    """Trash duplicate references in keep_id's project, repointing their uses to it."""
    try:
        return dupes.merge_references(body.keep_id, body.remove_ids)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------------------
# Saved reports
# ---------------------------------------------------------------------------


def _run_report(report, offset, limit):
    f = manage_db.effective_report_filter(report, ManageFilterIn)
    if f is None:
        return {"total": 0, "items": []}
    return manage_db.list_filtered_results(f, offset=offset, limit=limit)


def _report_or_404(report_id):
    report = manage_db.get_report(report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    return report


@router.get("/reports")
def list_reports(with_counts: bool = True):
    """Saved reports, most recently updated first; result_count is the current
    size of each (the filter re-run now), unless with_counts=false."""
    reports = manage_db.list_reports()
    if with_counts:
        for r in reports:
            r["result_count"] = _run_report(r, 0, 1)["total"]
    return reports


@router.post("/reports")
def create_report(body: ReportIn):
    return manage_db.create_report(body.name, body.filter.model_dump(), body.display)


@router.get("/reports/{report_id}")
def get_report(report_id: str):
    return _report_or_404(report_id)


@router.put("/reports/{report_id}")
def update_report(report_id: str, body: ReportUpdateIn):
    _report_or_404(report_id)
    return manage_db.update_report(
        report_id,
        name=body.name,
        filter_dict=body.filter.model_dump() if body.filter else None,
        display=body.display,
    )


@router.delete("/reports/{report_id}")
def delete_report(report_id: str):
    _report_or_404(report_id)
    manage_db.delete_report(report_id)
    return {"ok": True}


@router.get("/reports/{report_id}/results")
def report_results(report_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    """Runs the stored filter against the library as it is now."""
    return _run_report(_report_or_404(report_id), offset, limit)


# ---------------------------------------------------------------------------
# Export (built in the background; see export.py)
# ---------------------------------------------------------------------------


def _public(job):
    return {k: v for k, v in job.items() if k != "path"}


@router.post("/export")
def start_export(body: ManageExportIn):
    """Starts a zip of the results matching body.filter or the saved report's
    filter. Poll GET /export/{job_id}, then fetch /export/{job_id}/download."""
    if body.report_id:
        report = _report_or_404(body.report_id)
        f = manage_db.effective_report_filter(report, ManageFilterIn)
        if f is None:
            raise HTTPException(400, "None of this report's libraries exist any more")
        name = body.name or report["name"]
    else:
        f = body.filter
        name = body.name or "export"
    return export.start_export(name, f, body.options)


@router.get("/export/{job_id}")
def export_status(job_id: str):
    job = export.job_status(job_id)
    if not job:
        raise HTTPException(404, "Export not found (they're kept for an hour)")
    return _public(job)


@router.get("/export/{job_id}/download")
def export_download(job_id: str):
    path = export.job_file(job_id)
    if not path or not path.exists():
        raise HTTPException(404, "Export not ready or no longer available")
    return FileResponse(path, media_type="application/zip", filename=path.name)
