from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

import db
import storage
from models import ReferenceImageCropIn, ReferenceImageUpdateIn

router = APIRouter(tags=["reference-images"])


def _clamp_crop_box(crop_x, crop_y, crop_w, crop_h, orig_width, orig_height):
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(400, "Crop width/height must be positive")
    x = max(0, min(crop_x, orig_width - 1))
    y = max(0, min(crop_y, orig_height - 1))
    w = max(1, min(crop_w, orig_width - x))
    h = max(1, min(crop_h, orig_height - y))
    return x, y, w, h


@router.get("/api/projects/{project_id}/reference-images")
def list_reference_images(project_id: str):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return db.list_reference_images(project_id)


@router.post("/api/projects/{project_id}/reference-images")
async def upload_reference_image(
    project_id: str,
    file: UploadFile = File(...),
    display_name: str = Form(None),
    crop_x: int = Form(None),
    crop_y: int = Form(None),
    crop_w: int = Form(None),
    crop_h: int = Form(None),
):
    """Uploads a reference image with an optional just-in-time crop applied at
    upload time. The untouched original is always kept alongside the cropped
    (or full, if no crop box was given) active version, so the crop can be
    redone later from full quality via the /crop endpoint.
    """
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")

    file_bytes = await file.read()
    name = (display_name or (file.filename.rsplit(".", 1)[0] if file.filename else "reference")).strip() or "reference"
    ref_id = db.new_id()
    try:
        original_file_name, orig_width, orig_height = storage.save_reference_image_original(
            project_id, ref_id, name, file_bytes
        )
    except Exception as e:
        raise HTTPException(400, f"Could not process reference image: {e}")

    crop_box = None
    if None not in (crop_x, crop_y, crop_w, crop_h):
        crop_box = _clamp_crop_box(crop_x, crop_y, crop_w, crop_h, orig_width, orig_height)

    try:
        active_file_name, width, height = storage.apply_reference_crop(
            project_id, ref_id, name, original_file_name, crop_box
        )
    except Exception as e:
        storage.delete_reference_image_files(project_id, original_file_name, original_file_name)
        raise HTTPException(400, f"Could not crop reference image: {e}")

    return db.create_reference_image(
        ref_id=ref_id,
        project_id=project_id,
        display_name=name,
        original_file_name=original_file_name,
        file_name=active_file_name,
        crop_x=crop_box[0] if crop_box else None,
        crop_y=crop_box[1] if crop_box else None,
        crop_w=crop_box[2] if crop_box else None,
        crop_h=crop_box[3] if crop_box else None,
        orig_width=orig_width,
        orig_height=orig_height,
        width=width,
        height=height,
    )


@router.put("/api/reference-images/{ref_id}")
def update_reference_image(ref_id: str, body: ReferenceImageUpdateIn):
    if not db.get_reference_image(ref_id):
        raise HTTPException(404, "Reference image not found")
    return db.update_reference_image(ref_id, display_name=body.display_name)


@router.put("/api/reference-images/{ref_id}/crop")
def recrop_reference_image(ref_id: str, body: ReferenceImageCropIn):
    """Re-crops from the untouched original (never from a previous crop), so
    repeated adjustments never compound quality loss.
    """
    ref = db.get_reference_image(ref_id)
    if not ref:
        raise HTTPException(404, "Reference image not found")

    crop_box = _clamp_crop_box(body.crop_x, body.crop_y, body.crop_w, body.crop_h, ref["orig_width"], ref["orig_height"])
    try:
        active_file_name, width, height = storage.apply_reference_crop(
            ref["project_id"], ref_id, ref["display_name"], ref["original_file_name"], crop_box
        )
    except Exception as e:
        raise HTTPException(400, f"Could not crop reference image: {e}")

    if active_file_name != ref["file_name"]:
        storage.reference_image_path(ref["project_id"], ref["file_name"]).unlink(missing_ok=True)
    storage.clear_thumbnail("references", ref["project_id"], ref_id)

    return db.update_reference_image_crop(
        ref_id, active_file_name, crop_box[0], crop_box[1], crop_box[2], crop_box[3], width, height
    )


@router.delete("/api/reference-images/{ref_id}")
def delete_reference_image(ref_id: str):
    if not db.get_reference_image(ref_id):
        raise HTTPException(404, "Reference image not found")
    db.soft_delete_reference_image(ref_id)
    return {"ok": True}


@router.post("/api/reference-images/{ref_id}/restore")
def restore_reference_image(ref_id: str):
    if not db.get_reference_image(ref_id):
        raise HTTPException(404, "Reference image not found")
    return db.restore_reference_image(ref_id)


@router.delete("/api/reference-images/{ref_id}/permanent")
def permanently_delete_reference_image(ref_id: str):
    ref = db.get_reference_image(ref_id)
    if not ref:
        raise HTTPException(404, "Reference image not found")
    if not ref["is_deleted"]:
        raise HTTPException(400, "Reference image must be trashed before it can be permanently deleted")
    storage.delete_reference_image_files(ref["project_id"], ref["original_file_name"], ref["file_name"])
    storage.clear_thumbnail("references", ref["project_id"], ref_id)
    db.delete_reference_image(ref_id)
    return {"ok": True}


@router.get("/api/reference-images/{ref_id}/file")
def get_reference_image_file(ref_id: str):
    ref = db.get_reference_image(ref_id)
    if not ref:
        raise HTTPException(404, "Reference image not found")
    path = storage.reference_image_path(ref["project_id"], ref["file_name"])
    if not path.exists():
        raise HTTPException(404, "Reference image file missing on disk")
    return FileResponse(path, media_type="image/png")


@router.get("/api/reference-images/{ref_id}/original")
def get_reference_image_original(ref_id: str):
    ref = db.get_reference_image(ref_id)
    if not ref:
        raise HTTPException(404, "Reference image not found")
    path = storage.reference_image_path(ref["project_id"], ref["original_file_name"])
    if not path.exists():
        raise HTTPException(404, "Reference image original file missing on disk")
    return FileResponse(path, media_type="image/png")


@router.get("/api/reference-images/{ref_id}/thumbnail")
def get_reference_image_thumbnail(ref_id: str):
    ref = db.get_reference_image(ref_id)
    if not ref:
        raise HTTPException(404, "Reference image not found")
    path = storage.reference_image_path(ref["project_id"], ref["file_name"])
    if not path.exists():
        raise HTTPException(404, "Reference image file missing on disk")
    thumb_path = storage.get_or_create_thumbnail("references", ref["project_id"], ref_id, path)
    return FileResponse(thumb_path, media_type="image/jpeg")
