"""Per-project export, kept for scripts that call it. The app exports from the
management page (/api/manage/export, see export.py); this builds the same
kind of zip, synchronously, for one project's active results.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import db
import export
from models import ExportOptions, ExportRequestIn, ManageFilterIn

router = APIRouter(tags=["export"])


@router.post("/api/projects/{project_id}/export")
def export_project(project_id: str, body: ExportRequestIn):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    f = ManageFilterIn(
        project_ids=[project_id],
        evaluations=[] if body.status_filter == "ALL" else [body.status_filter],
        active_only=True,
        dedupe_copies=False,
    )
    results = export.all_filtered_results(f)
    if not results:
        raise HTTPException(400, "No results match the selected filter")

    options = ExportOptions(images=body.mode == "clean", side_by_side=body.mode == "side_by_side",
                            sidecar=False, html_report=False)
    name = f"{project['slug']}_{body.status_filter.lower()}_{body.mode}"
    zip_path = export.build_export(name, results, options)
    return FileResponse(zip_path, media_type="application/zip", filename=zip_path.name)
