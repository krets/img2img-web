from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

import db
import storage
from models import ImageFromUrlIn, ImageUpdateIn, MergeImagesIn, MoveImagesIn

router = APIRouter(tags=["images"])

MAX_URL_IMAGE_BYTES = 25 * 1024 * 1024


@router.get("/api/projects/{project_id}/images")
def list_images(project_id: str, sort: str = "recent_result", filter: str = "all", search: str = None):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return db.list_images(project_id, sort=sort, filter=filter, search=search)


@router.post("/api/projects/{project_id}/images")
async def upload_images(project_id: str, files: list[UploadFile] = File(...)):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")

    created = []
    skipped = []
    seen_hashes = {}  # content_hash -> {"id", "display_name"} of the image already kept, within this batch
    for upload in files:
        file_bytes = await upload.read()
        display_name = upload.filename.rsplit(".", 1)[0] if upload.filename else "image"
        image_id = db.new_id()
        try:
            file_name, width, height, content_hash, resized_hash = storage.save_source_image(
                project_id, image_id, display_name, file_bytes
            )
        except Exception as e:
            raise HTTPException(400, f"Could not process image '{upload.filename}': {e}")

        existing = db.find_image_by_hash(project_id, content_hash)
        duplicate_of = existing or seen_hashes.get(content_hash)
        if duplicate_of:
            storage.delete_source_image(project_id, file_name)
            skipped.append({
                "filename": upload.filename,
                "duplicate_of": duplicate_of["display_name"],
                "duplicate_of_id": duplicate_of["id"],
            })
            continue

        seen_hashes[content_hash] = {"id": image_id, "display_name": display_name}
        image = db.create_image(
            project_id=project_id,
            file_name=file_name,
            display_name=display_name,
            width=width,
            height=height,
            content_hash=content_hash,
            resized_hash=resized_hash,
        )
        created.append(image)
    return {"created": created, "skipped": skipped}


@router.post("/api/projects/{project_id}/images/from-url")
def import_image_from_url(project_id: str, body: ImageFromUrlIn):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")

    url = body.url.strip()
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(400, f"Could not fetch URL: {e}")

    content_type = resp.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        raise HTTPException(400, f"URL did not return an image (content-type: {content_type or 'unknown'})")
    if len(resp.content) > MAX_URL_IMAGE_BYTES:
        raise HTTPException(400, "Image is too large (25MB limit)")

    display_name = unquote(Path(urlparse(url).path).stem) or "image"
    image_id = db.new_id()
    try:
        file_name, width, height, content_hash, resized_hash = storage.save_source_image(
            project_id, image_id, display_name, resp.content
        )
    except Exception as e:
        raise HTTPException(400, f"Could not process image from URL: {e}")

    existing = db.find_image_by_hash(project_id, content_hash)
    if existing:
        storage.delete_source_image(project_id, file_name)
        return {
            "created": [],
            "skipped": [{
                "filename": display_name,
                "duplicate_of": existing["display_name"],
                "duplicate_of_id": existing["id"],
            }],
        }

    image = db.create_image(
        project_id=project_id,
        file_name=file_name,
        display_name=display_name,
        width=width,
        height=height,
        content_hash=content_hash,
        resized_hash=resized_hash,
        comment=url,
    )
    return {"created": [image], "skipped": []}


@router.get("/api/projects/{project_id}/duplicates")
def get_duplicates(project_id: str):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return db.list_duplicate_groups(project_id)


@router.post("/api/images/move")
def move_images(body: MoveImagesIn):
    if not db.get_project(body.target_project_id):
        raise HTTPException(404, "Target project not found")

    moved = []
    for image_id in body.image_ids:
        image = db.get_image(image_id)
        if not image or image["project_id"] == body.target_project_id:
            continue
        old_project_id = image["project_id"]

        storage.move_source_image(old_project_id, body.target_project_id, image["file_name"])
        storage.clear_thumbnail("images", old_project_id, image_id)

        for result in db.list_results_for_image(image_id):
            storage.move_result_image(old_project_id, body.target_project_id, result["file_path"])
            storage.clear_thumbnail("results", old_project_id, result["id"])

        db.set_image_project(image_id, body.target_project_id)
        moved.append(image_id)

    return {"moved": moved, "target_project_id": body.target_project_id}


@router.post("/api/images/merge")
def merge_images(body: MergeImagesIn):
    keep = db.get_image(body.keep_id)
    if not keep:
        raise HTTPException(404, "Keep image not found")

    merged = []
    for remove_id in body.remove_ids:
        if remove_id == body.keep_id:
            continue
        remove_image = db.get_image(remove_id)
        if not remove_image or remove_image["project_id"] != keep["project_id"]:
            continue

        db.merge_images(body.keep_id, remove_id)
        storage.delete_source_image(remove_image["project_id"], remove_image["file_name"])
        storage.clear_thumbnail("images", remove_image["project_id"], remove_id)
        merged.append(remove_id)

    return {"kept": body.keep_id, "merged": merged}


def _resolve_provenance(image):
    """Resolves an image's derived_from_result_id (set when it was promoted
    from a result via /api/results/{id}/promote-to-source) into the display
    info the details panel needs -- or None for an ordinary uploaded image.
    Tolerates the source result having since been deleted.
    """
    result_id = image.get("derived_from_result_id")
    if not result_id:
        return None
    result = db.get_result(result_id)
    if not result:
        return None
    source_image = db.get_image(result["image_id"])
    prompt_text = result.get("adhoc_prompt_text")
    if not prompt_text and result.get("prompt_id"):
        prompt = db.get_prompt(result["prompt_id"])
        prompt_text = prompt["prompt_text"] if prompt else None
    return {
        "result_id": result_id,
        "source_image_id": result["image_id"],
        "source_image_display_name": source_image["display_name"] if source_image else None,
        "prompt_text": prompt_text,
    }


@router.get("/api/images/{image_id}")
def get_image(image_id: str):
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    image["results"] = db.list_results_for_image(image_id)
    image["derived_from"] = _resolve_provenance(image)
    return image


@router.put("/api/images/{image_id}")
def update_image(image_id: str, body: ImageUpdateIn):
    if not db.get_image(image_id):
        raise HTTPException(404, "Image not found")
    return db.update_image(image_id, display_name=body.display_name, comment=body.comment)


@router.delete("/api/images/{image_id}")
def delete_image(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    db.soft_delete_image(image_id)
    return {"ok": True}


@router.post("/api/images/{image_id}/restore")
def restore_image(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    return db.restore_image(image_id)


@router.delete("/api/images/{image_id}/permanent")
def permanently_delete_image(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    if not image["is_deleted"]:
        raise HTTPException(400, "Image must be trashed before it can be permanently deleted")
    for result in db.list_results_for_image(image_id, include_deleted=True):
        storage.delete_result_image(image["project_id"], result["file_path"])
        storage.clear_thumbnail("results", image["project_id"], result["id"])
    storage.delete_source_image(image["project_id"], image["file_name"])
    storage.clear_thumbnail("images", image["project_id"], image_id)
    db.delete_image(image_id)
    return {"ok": True}


@router.get("/api/images/{image_id}/file")
def get_image_file(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    return FileResponse(path, media_type="image/png")


@router.get("/api/images/{image_id}/thumbnail")
def get_image_thumbnail(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    thumb_path = storage.get_or_create_thumbnail("images", image["project_id"], image_id, path)
    return FileResponse(thumb_path, media_type="image/jpeg")
