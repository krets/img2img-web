from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import db
import storage
from models import ExportRequestIn

router = APIRouter(tags=["export"])


@router.get("/api/projects/{project_id}/export/preview")
def export_preview(project_id: str, status_filter: str = "YES"):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return db.list_results_by_status(project_id, status=status_filter)


@router.post("/api/projects/{project_id}/export")
def export_project(project_id: str, body: ExportRequestIn):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    results = db.list_results_by_status(project_id, status=body.status_filter)
    if not results:
        raise HTTPException(400, "No results match the selected filter")

    for r in results:
        r["project_id"] = project_id

    source_paths = {}
    if body.mode == "side_by_side":
        for r in results:
            image = db.get_image(r["image_id"])
            source_paths[r["id"]] = storage.source_image_path(project_id, image["file_name"])

    zip_path = storage.build_export_zip(
        project_slug=project["slug"],
        status_filter=body.status_filter,
        mode=body.mode,
        results=results,
        source_paths=source_paths,
    )
    return FileResponse(zip_path, media_type="application/zip", filename=zip_path.name)
