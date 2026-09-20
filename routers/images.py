from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

import db
import preprocess
import storage
from models import CopyImagesIn, ImageFromUrlIn, ImageUpdateIn, MergeImagesIn, MoveImagesIn, PreprocessIn

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


@router.post("/api/images/copy")
def copy_images(body: CopyImagesIn):
    if not db.get_project(body.target_project_id):
        raise HTTPException(404, "Target project not found")

    copied = []
    for image_id in body.image_ids:
        image = db.get_image(image_id)
        if not image:
            continue

        new_file_name = storage.copy_source_image(image["project_id"], body.target_project_id, image["file_name"])
        new_image = db.create_image(
            project_id=body.target_project_id,
            file_name=new_file_name,
            display_name=image["display_name"],
            width=image["width"],
            height=image["height"],
            comment=image["comment"],
            preprocess=image["preprocess"],
        )

        active_result_id = None
        # oldest first, so create_result's "clear other actives on this image_id"
        # side effect leaves the newest (last one inserted) active, matching
        # the eventual explicit set_active_result() call below for correctness
        # regardless of insert order.
        for result in reversed(db.list_results_for_image(image_id)):
            new_result_file_name = storage.copy_result_image(
                image["project_id"], body.target_project_id, result["file_path"]
            )
            new_result = db.create_result(
                image_id=new_image["id"],
                file_path=new_result_file_name,
                prompt_id=result["prompt_id"],
                adhoc_prompt_text=result["adhoc_prompt_text"],
                engine=result["engine"],
                model=result["model"],
                aspect_ratio=result["aspect_ratio"],
                max_dim=result["max_dim"],
                revised_prompt=result["revised_prompt"],
                media_type=result["media_type"],
                duration_seconds=result["duration_seconds"],
            )
            db.update_evaluation(new_result["id"], result["evaluation"])
            if result["is_active_result"]:
                active_result_id = new_result["id"]

        if active_result_id:
            db.set_active_result(active_result_id)

        copied.append(new_image["id"])

    return {"copied": copied, "target_project_id": body.target_project_id}


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
        "ancestors": _resolve_ancestors(image),
    }


def _resolve_ancestors(image, max_depth=50):
    """Walks derived_from_result_id -> result.image_id upward, returning the
    image's ancestors nearest-first (parent, grandparent, ... root). Stops at
    the first link that no longer resolves (result or image hard-deleted) or
    if it ever revisits an image (merge_images can in principle create a loop).
    Trashed ancestors are included and flagged, since their files are still
    on disk and still usable for comparison until the trash is purged.
    """
    chain = []
    seen = {image["id"]}
    current = image
    while len(chain) < max_depth:
        result_id = current.get("derived_from_result_id")
        result = db.get_result(result_id) if result_id else None
        parent = db.get_image(result["image_id"]) if result else None
        if not parent or parent["id"] in seen:
            break
        seen.add(parent["id"])
        chain.append({
            "id": parent["id"],
            "display_name": parent["display_name"],
            "is_deleted": bool(parent["is_deleted"]),
        })
        current = parent
    return chain


def _image_detail(image):
    image["results"] = db.list_results_for_image(image["id"])
    image["derived_from"] = _resolve_provenance(image)
    return image


@router.get("/api/images/{image_id}")
def get_image(image_id: str):
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    return _image_detail(image)


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


@router.put("/api/images/{image_id}/preprocess")
def set_image_preprocess(image_id: str, body: PreprocessIn):
    """Sets how the source gets rotated/cropped/padded before being sent to a
    generation engine. Only the settings are stored -- the source file stays
    untouched, and the processed render is cached (see storage.get_or_create_processed).
    Params that amount to no change clear the setting. Returns the image detail.
    """
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")

    with Image.open(path) as img:
        width, height = img.size
    try:
        params = preprocess.normalize(body.model_dump(), width, height)
    except ValueError as e:
        raise HTTPException(400, str(e))

    storage.clear_processed(image["project_id"], image_id)
    if params:
        storage.get_or_create_processed(image["project_id"], image_id, path, params)  # render now, so a failure surfaces here
    return _image_detail(db.set_image_preprocess(image_id, params))


@router.delete("/api/images/{image_id}/preprocess")
def clear_image_preprocess(image_id: str):
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    storage.clear_processed(image["project_id"], image_id)
    return _image_detail(db.set_image_preprocess(image_id, None))


@router.get("/api/images/{image_id}/processed")
def get_image_processed(image_id: str):
    """The source as it will be sent to the engine (rotated/cropped/padded).
    404 when the image has no pre-process settings -- use /file for the original.
    """
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    if not image["preprocess"]:
        raise HTTPException(404, "Image has no pre-processing")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    processed = storage.get_or_create_processed(image["project_id"], image_id, path, image["preprocess"])
    return FileResponse(processed, media_type="image/png")


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


@router.get("/api/images/{image_id}/preview")
def get_image_preview(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    preview_path = storage.get_or_create_preview("images", image["project_id"], image_id, path)
    return FileResponse(preview_path, media_type="image/jpeg")
