import json
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from PIL import Image

import comfyui_client
import config as cfg
import db
import http_cache
import jobs
import preprocess
import storage
from models import (
    CopyImagesIn,
    ImageFromUrlIn,
    ImageParentIn,
    ImageUpdateIn,
    MergeImagesIn,
    MoveImagesIn,
    PreprocessIn,
    Sam3CutoutBatchIn,
)

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
            saved = storage.save_source_image(project_id, image_id, display_name, file_bytes)
        except Exception as e:
            raise HTTPException(400, f"Could not process image '{upload.filename}': {e}")

        existing = db.find_image_by_hash(project_id, saved.content_hash)
        duplicate_of = existing or seen_hashes.get(saved.content_hash)
        if duplicate_of:
            storage.delete_source_image(project_id, saved.file_name)
            skipped.append({
                "filename": upload.filename,
                "duplicate_of": duplicate_of["display_name"],
                "duplicate_of_id": duplicate_of["id"],
            })
            continue

        seen_hashes[saved.content_hash] = {"id": image_id, "display_name": display_name}
        image = db.create_image(
            project_id=project_id,
            file_name=saved.file_name,
            display_name=display_name,
            width=saved.width,
            height=saved.height,
            **saved.hash_fields(),
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
        saved = storage.save_source_image(project_id, image_id, display_name, resp.content)
    except Exception as e:
        raise HTTPException(400, f"Could not process image from URL: {e}")

    existing = db.find_image_by_hash(project_id, saved.content_hash)
    if existing:
        storage.delete_source_image(project_id, saved.file_name)
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
        file_name=saved.file_name,
        display_name=display_name,
        width=saved.width,
        height=saved.height,
        **saved.hash_fields(),
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
            content_hash=image["content_hash"],
            resized_hash=image["resized_hash"],
            phash=image["phash"],
            dhash=image["dhash"],
            aspect=image["aspect"],
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
                source_preprocess=result["source_preprocess"],
                source_preprocess_known=result["source_preprocess_known"],
                # Still the source project's reference ids -- references are
                # per-project and aren't copied along with the image.
                reference_image_ids=result["reference_image_ids"],
                content_hash=result["content_hash"],
                copied_from_result_id=result["id"],
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

    # Checked up front so a bad id aborts the whole request rather than leaving
    # it half merged. Cross-project merges are refused: merge_images reassigns
    # results.image_id without moving their files, which live under the
    # project's folder, so the moved results would point at missing files.
    removals = []
    for remove_id in dict.fromkeys(body.remove_ids):
        if remove_id == body.keep_id:
            continue
        remove_image = db.get_image(remove_id)
        if not remove_image:
            raise HTTPException(404, f"Image {remove_id} not found")
        if remove_image["project_id"] != keep["project_id"]:
            raise HTTPException(400, "Can't merge images from different projects; move them into one project first")
        removals.append(remove_image)

    merged = []
    for remove_image in removals:
        remove_id = remove_image["id"]
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
            "preprocess": parent["preprocess"],
            # The result the next link in the chain was promoted from, and the
            # crop it was generated with -- what "this ancestor" really looked
            # like as an engine input, even if the crop has since been edited.
            "promoted_result_id": result["id"],
            "generated_preprocess": result["source_preprocess"],
            "generated_preprocess_known": result["source_preprocess_known"],
        })
        current = parent
    return chain


def _image_detail(image):
    image["results"] = db.list_results_for_image(image["id"])
    image["derived_from"] = _resolve_provenance(image)
    image["sam3_reference"] = db.get_scoped_reference_image(image["id"])
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


def _is_ancestor_or_self(candidate_id, image, max_depth=50):
    """True if `image` is candidate_id or has it anywhere up its parent chain."""
    seen = set()
    current = image
    while current and current["id"] not in seen and len(seen) < max_depth:
        if current["id"] == candidate_id:
            return True
        seen.add(current["id"])
        result_id = current.get("derived_from_result_id")
        result = db.get_result(result_id) if result_id else None
        current = db.get_image(result["image_id"]) if result else None
    return False


@router.put("/api/images/{image_id}/parent")
def set_image_parent(image_id: str, body: ImageParentIn):
    """Makes the image a child of one of another image's results, replacing any
    existing parent. Rejects links that would make an image its own ancestor.
    """
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    result = db.get_result(body.result_id)
    parent = db.get_image(result["image_id"]) if result else None
    if not result or result["is_deleted"] or not parent or parent["is_deleted"]:
        raise HTTPException(404, "Parent result not found")
    if parent["project_id"] != image["project_id"]:
        raise HTTPException(400, "Parent must be in the same project")
    if _is_ancestor_or_self(image_id, parent):
        raise HTTPException(400, "An image can't be its own ancestor")
    return _image_detail(db.set_image_parent(image_id, body.result_id))


@router.delete("/api/images/{image_id}/parent")
def clear_image_parent(image_id: str):
    """Detaches the image from its parent; it becomes a root of its own lineage."""
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    return _image_detail(db.set_image_parent(image_id, None))


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
    return http_cache.image_response(path, "image/png")


@router.put("/api/images/{image_id}/preprocess")
def set_image_preprocess(image_id: str, params: str = Form(...)):
    """Sets how the source gets rotated/cropped/padded before being sent to a
    generation engine. Only the settings are stored on the image row -- the
    source file stays untouched -- and the render is made here, so the
    browser sends a few hundred bytes of settings rather than uploading the
    full-size result (tens of MB for a large source, which stalled saves over
    a slow link). It's rendered now rather than on first use so the viewer
    and the next generation find it ready. Params that amount to no change
    clear the setting. Returns the image detail.
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
        parsed = PreprocessIn.model_validate_json(params)
        normalized = preprocess.normalize(parsed.model_dump(), width, height)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(400, str(e))

    storage.clear_processed(image["project_id"], image_id)
    if normalized:
        try:
            storage.get_or_create_processed(image["project_id"], image_id, path, normalized)
        except Exception as e:
            raise HTTPException(500, f"Could not render the pre-processed image: {e}")
    return _image_detail(db.set_image_preprocess(image_id, normalized))


@router.delete("/api/images/{image_id}/preprocess")
def clear_image_preprocess(image_id: str):
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    storage.clear_processed(image["project_id"], image_id)
    return _image_detail(db.set_image_preprocess(image_id, None))


def _effective_source_path(image):
    """The file an engine actually sees: the cached pre-processed (rotate/
    crop/pad) render if the image has one, else the raw source. Mirrors
    _run_generation's resolution in routers/results.py.
    """
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    if not image["preprocess"]:
        return path
    try:
        return storage.get_or_create_processed(image["project_id"], image["id"], path, image["preprocess"])
    except Exception as e:
        raise HTTPException(400, f"Failed to pre-process source image: {e}")


def _replace_scoped_reference(image):
    """Removes all of this image's existing scoped SAM3 references (if any)
    -- see get_scoped_reference_image / list_scoped_cutout_layers. A fresh
    batch of detections and a finished positioning both clear the slot
    rather than piling up on top of what was there before.
    """
    existing = db.list_scoped_cutout_layers(image["id"])
    finished = db.get_scoped_reference_image(image["id"])
    if finished and not finished.get("needs_composite"):
        existing = existing + [finished]
    for ref in existing:
        storage.delete_reference_image_files(image["project_id"], ref["original_file_name"], ref["file_name"])
        db.delete_reference_image(ref["id"])


@router.post("/api/images/{image_id}/sam3-cutout-batch")
def sam3_cutout_batch(image_id: str, body: Sam3CutoutBatchIn, background_tasks: BackgroundTasks):
    """Queues one SAM3 detect/crop job per prompt, all sharing a
    batch_id and tagged with their requested layer_index (bottom to top, in
    the order the prompts were given) -- see _await_sam3_cutout_layer. Each
    cache-miss prompt is submitted to ComfyUI right here, synchronously,
    before this handler returns -- not lazily from a background task -- so
    the whole batch claims its queue positions up front and nothing started
    afterwards (a generation, say) can slip in between two of its layers.
    ComfyUI still only runs one prompt at a time, so they wait behind each
    other (and behind any generation already in flight); each still finishes
    independently into its own needs_composite=1 reference_images row, and
    the positioning UI waits for all of them before opening.

    SAM3 detection is deterministic for a given source image and prompt, so
    each prompt is first checked against storage's on-disk cutout cache
    (keyed on the source bytes + prompt + max_dim) -- useful when re-running
    a prompt that mis-segmented the object the first time. A cache hit is
    saved synchronously right here, before the job ever reaches "queued", so
    the response already reports it done instead of making the user watch it
    sit in the queue and "detect" instantly. ComfyUI is only required to be
    reachable, and a job only queued, for a prompt that actually misses.

    Checks ComfyUI is actually reachable before queuing anything that needs
    it: each queued job's own submit call has a 120s timeout (comfyui_client's
    REQUEST_TIMEOUT_SECONDS) and jobs run strictly one at a time, so a dead
    server would otherwise cost prompts*120s of silent waiting before the
    user sees any error.
    """
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")

    config = cfg.load_config()
    source_path = _effective_source_path(image)
    max_dim = config["default_max_dim"]
    cache_keys = [storage.sam3_cutout_cache_key(source_path, p, max_dim) for p in body.sam3_prompts]
    cached_bytes = [storage.get_cached_sam3_cutout(image["project_id"], key) for key in cache_keys]
    if any(cb is None for cb in cached_bytes):
        reachable, detail = comfyui_client.check_connection(config.get("comfyui_url"))
        if not reachable:
            raise HTTPException(503, f"ComfyUI isn't reachable, so SAM3 detection can't run right now: {detail}")
    _replace_scoped_reference(image)
    batch_id = db.new_id()
    jobs_out = []
    queued_any = False
    for layer_index, (sam3_prompt, cache_key, cutout_bytes) in enumerate(zip(body.sam3_prompts, cache_keys, cached_bytes)):
        job = jobs.create_job(
            image_id=image_id,
            project_id=image["project_id"],
            image_name=image["display_name"],
            engine="comfyui",
            prompt_text=sam3_prompt,
            kind="sam3_cutout",
        )
        if cutout_bytes is not None:
            try:
                _save_sam3_cutout_layer(job["id"], image, sam3_prompt, batch_id, layer_index, cutout_bytes)
            except Exception as e:
                jobs.finish_job(job["id"], error=str(e))
            job = jobs.get_job(job["id"])
        else:
            # Submit this layer's prompt to ComfyUI right now, synchronously,
            # instead of waiting for a background task to get around to it.
            # That reserves its place in ComfyUI's queue (see submit_sam3_detection's
            # front param -- only the first job actually queued in the batch
            # jumps the queue, the rest just queue normally behind it) before
            # this handler returns, so a generation started right after this
            # batch can't slip in between two of its layers -- which it could
            # if each layer only submitted lazily, after the previous one's
            # background task finished waiting on its result.
            try:
                source_path = _effective_source_path(image)
                prompt_id = comfyui_client.submit_sam3_detection(
                    base_url=config["comfyui_url"],
                    workflow_path=cfg.comfyui_workflow_path(config, "cutout"),
                    source_path=source_path,
                    sam3_prompt=sam3_prompt,
                    job_id=job["id"],
                    max_dim=config["default_max_dim"],
                    front=not queued_any,
                )
            except jobs.GenerationCancelled:
                jobs.cancel_job(job["id"])
            except Exception as e:
                jobs.finish_job(job["id"], error=str(e))
            else:
                background_tasks.add_task(
                    _await_sam3_cutout_layer, job["id"], image, sam3_prompt, config, batch_id, layer_index, cache_key, prompt_id
                )
            queued_any = True
            job = jobs.get_job(job["id"])
        jobs_out.append(job)
    return {"batch_id": batch_id, "jobs": jobs_out}


def _save_sam3_cutout_layer(job_id, image, sam3_prompt, batch_id, layer_index, cutout_bytes):
    name = f"SAM3: {sam3_prompt.strip()}"
    ref_id = db.new_id()
    file_name, width, height = storage.save_reference_cutout(image["project_id"], ref_id, name, cutout_bytes)
    db.create_reference_image(
        ref_id=ref_id,
        project_id=image["project_id"],
        display_name=name,
        original_file_name=file_name,
        file_name=file_name,
        crop_x=None, crop_y=None, crop_w=None, crop_h=None,
        orig_width=width, orig_height=height,
        width=width, height=height,
        source_image_id=image["id"],
        needs_composite=True,
        batch_id=batch_id,
        layer_index=layer_index,
    )
    jobs.finish_job(job_id)


def _await_sam3_cutout_layer(job_id, image, sam3_prompt, config, batch_id, layer_index, cache_key, prompt_id):
    """Waits for a prompt already submitted by sam3_cutout_batch (via
    comfyui_client.submit_sam3_detection) and saves the result.
    """
    try:
        jobs.update_job(job_id, status="running")
        cutout_bytes = comfyui_client.await_sam3_result(config["comfyui_url"], job_id, prompt_id)
        storage.save_sam3_cutout_cache(image["project_id"], cache_key, cutout_bytes)
        _save_sam3_cutout_layer(job_id, image, sam3_prompt, batch_id, layer_index, cutout_bytes)
    except jobs.GenerationCancelled:
        jobs.cancel_job(job_id)
    except HTTPException as e:
        jobs.finish_job(job_id, error=str(e.detail))
    except Exception as e:
        jobs.finish_job(job_id, error=str(e))


@router.post("/api/images/{image_id}/sam3-reference")
async def set_sam3_reference(
    image_id: str, file: UploadFile = File(...), sam3_prompt: str = Form(None), sam3_prompts: str = Form(None)
):
    """Saves the frontend's client-composited placement (source image + the
    repositioned/rescaled SAM3 cutout, flattened to opaque RGB) as this
    image's one scoped reference -- see get_scoped_reference_image. Replaces
    any previous one for this image (typically the needs_composite=1 raw
    cutout this was positioned from) rather than accumulating.

    sam3_prompt is the ", "-joined display string (for display_name only);
    sam3_prompts is the same layers' prompts as a JSON array, stored as-is
    so reopening the prompt editor later can recover the original per-layer
    prompts without having to guess by splitting the joined string (which
    breaks if a prompt itself contains a comma).
    """
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")

    _replace_scoped_reference(image)

    file_bytes = await file.read()
    name = f"SAM3: {sam3_prompt.strip()}" if sam3_prompt and sam3_prompt.strip() else "SAM3 placement"
    prompts_list = None
    if sam3_prompts:
        try:
            parsed = json.loads(sam3_prompts)
            if isinstance(parsed, list) and all(isinstance(p, str) for p in parsed):
                prompts_list = parsed
        except ValueError:
            pass
    ref_id = db.new_id()
    try:
        original = storage.save_reference_image_original(image["project_id"], ref_id, name, file_bytes)
    except Exception as e:
        raise HTTPException(400, f"Could not process placement image: {e}")

    # No crop here (there's nothing to crop -- it's already the composited
    # placement at its final size), so the original doubles as the active
    # file, same as save_reference_cutout does for a raw cutout.
    return db.create_reference_image(
        ref_id=ref_id,
        project_id=image["project_id"],
        display_name=name,
        original_file_name=original.file_name,
        file_name=original.file_name,
        crop_x=None, crop_y=None, crop_w=None, crop_h=None,
        orig_width=original.width, orig_height=original.height,
        width=original.width, height=original.height,
        source_image_id=image_id,
        needs_composite=False,
        sam3_prompts=prompts_list,
        **original.hash_fields(),
    )


@router.get("/api/images/{image_id}/sam3-layers")
def get_sam3_layers(image_id: str):
    """The raw (needs_composite=1) cutout layers finished so far for this
    image, in requested stacking order -- the frontend polls this after
    queuing a batch until it has one entry per prompt submitted, then opens
    the positioning UI with all of them. _replace_scoped_reference clears
    any stale rows from a superseded batch before a new one is queued, so
    this never mixes layers from two different batches.
    """
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    return db.list_scoped_cutout_layers(image_id)


@router.delete("/api/images/{image_id}/sam3-reference")
def clear_sam3_reference(image_id: str):
    image = db.get_image(image_id)
    if not image or image["is_deleted"]:
        raise HTTPException(404, "Image not found")
    _replace_scoped_reference(image)
    return {"ok": True}


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
    return http_cache.image_response(processed, "image/png")


@router.get("/api/images/{image_id}/thumbnail")
def get_image_thumbnail(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    thumb_path = storage.get_or_create_thumbnail("images", image["project_id"], image_id, path)
    return http_cache.image_response(thumb_path, "image/jpeg")


@router.get("/api/images/{image_id}/preview")
def get_image_preview(image_id: str):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")
    path = storage.source_image_path(image["project_id"], image["file_name"])
    if not path.exists():
        raise HTTPException(404, "Image file missing on disk")
    preview_path = storage.get_or_create_preview("images", image["project_id"], image_id, path)
    return http_cache.image_response(preview_path, "image/jpeg")
