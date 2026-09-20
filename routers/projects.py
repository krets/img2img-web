from fastapi import APIRouter, HTTPException

import db
import storage
from models import ProjectIn, ProjectUpdateIn

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects(include_archived: bool = False):
    return db.list_projects(include_archived=include_archived)


@router.post("")
def create_project(body: ProjectIn):
    return db.create_project(body.name, body.description)


@router.get("/trash")
def list_trashed_projects():
    return db.list_deleted_projects()


@router.get("/{project_id}")
def get_project(project_id: str):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@router.get("/{project_id}/trash")
def get_project_trash(project_id: str):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return {
        "images": db.list_deleted_images(project_id),
        "results": db.list_deleted_results(project_id),
        "reference_images": db.list_deleted_reference_images(project_id),
    }


@router.put("/{project_id}")
def update_project(project_id: str, body: ProjectUpdateIn):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    name = body.name.strip() if body.name is not None else None
    if name == "":
        raise HTTPException(400, "Project name cannot be empty")
    return db.update_project(project_id, name=name, description=body.description)


@router.post("/{project_id}/archive")
def archive_project(project_id: str, archived: bool = True):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return db.set_project_archived(project_id, archived)


@router.delete("/{project_id}")
def delete_project(project_id: str):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    db.soft_delete_project(project_id)
    return {"ok": True}


@router.post("/{project_id}/restore")
def restore_project(project_id: str):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return db.restore_project(project_id)


@router.delete("/{project_id}/permanent")
def permanently_delete_project(project_id: str):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not project["is_deleted"]:
        raise HTTPException(400, "Project must be trashed before it can be permanently deleted")
    db.delete_project(project_id)
    storage.delete_project_dirs(project_id)
    return {"ok": True}
