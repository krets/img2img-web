from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

import comfyui_client
import config as cfg
import db
import grok_client
import jobs
import storage
from models import EvaluationIn, GenerateRequestIn

router = APIRouter(tags=["results"])


@router.post("/api/projects/{project_id}/results/import")
async def import_result(
    project_id: str,
    result_file: UploadFile = File(...),
    image_id: str = Form(None),
    source_file: UploadFile = File(None),
    display_name: str = Form(None),
    prompt_text: str = Form(""),
    evaluation: str = Form("UNRATED"),
):
    """Attaches an already-generated result image to a source image, without
    calling the Grok API. Either image_id (attach to an existing image) or
    source_file (create a new image first) must be provided.
    """
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    if evaluation not in ("YES", "NO", "MAYBE", "UNRATED"):
        raise HTTPException(400, "evaluation must be YES, NO, MAYBE, or UNRATED")

    if image_id:
        image = db.get_image(image_id)
        if not image or image["project_id"] != project_id:
            raise HTTPException(404, "Image not found in this project")
    elif source_file is not None:
        source_bytes = await source_file.read()
        name = (display_name or (source_file.filename.rsplit(".", 1)[0] if source_file.filename else "image")).strip()
        new_image_id = db.new_id()
        try:
            file_name, width, height, content_hash, resized_hash = storage.save_source_image(
                project_id, new_image_id, name, source_bytes
            )
        except Exception as e:
            raise HTTPException(400, f"Could not process source image: {e}")

        existing = db.find_image_by_hash(project_id, content_hash)
        if existing:
            storage.delete_source_image(project_id, file_name)
            raise HTTPException(409, f"Source image is a duplicate of existing image '{existing['display_name']}'")

        image = db.create_image(
            project_id=project_id, file_name=file_name, display_name=name, width=width, height=height,
            content_hash=content_hash, resized_hash=resized_hash,
        )
    else:
        raise HTTPException(400, "Either image_id or source_file must be provided")

    result_bytes = await result_file.read()
    result_id = db.new_id()
    try:
        result_file_name = storage.save_result_image(
            project_id, result_id, prompt_text or "imported", result_bytes, metadata={"engine": "imported"}
        )
    except Exception as e:
        raise HTTPException(400, f"Could not process result image: {e}")

    result = db.create_result(
        image_id=image["id"],
        file_path=result_file_name,
        adhoc_prompt_text=prompt_text or None,
        result_id=result_id,
    )
    if evaluation != "UNRATED":
        result = db.update_evaluation(result["id"], evaluation)
    return result


@router.get("/api/queue")
def get_queue():
    return jobs.list_jobs()


@router.post("/api/images/{image_id}/generate")
def generate_result(image_id: str, body: GenerateRequestIn, background_tasks: BackgroundTasks):
    image = db.get_image(image_id)
    if not image:
        raise HTTPException(404, "Image not found")

    if body.prompt_id and not db.get_prompt(body.prompt_id):
        raise HTTPException(404, "Prompt not found")

    if not body.adhoc_prompt_text or not body.adhoc_prompt_text.strip():
        raise HTTPException(400, "Prompt text is required")

    config = cfg.load_config()
    engine = body.engine or config["default_engine"]

    source_path = storage.source_image_path(image["project_id"], image["file_name"])
    if not source_path.exists():
        raise HTTPException(404, "Source image file missing on disk")

    if engine != "comfyui" and not cfg.get_api_key():
        raise HTTPException(400, "No xAI API key configured. Set one in Settings first.")

    job = jobs.create_job(
        image_id=image_id,
        project_id=image["project_id"],
        image_name=image["display_name"],
        engine=engine,
        prompt_text=body.adhoc_prompt_text,
    )
    background_tasks.add_task(_run_generation, job["id"], image, body, engine, config, source_path)
    return job


def _run_generation(job_id, image, body, engine, config, source_path):
    model = None
    aspect_ratio = None
    max_dim = None
    try:
        jobs.update_job(job_id, status="running")

        if engine == "comfyui":
            try:
                image_bytes, revised_prompt = comfyui_client.generate_image_edit(
                    base_url=config["comfyui_url"],
                    workflow_path=cfg.comfyui_workflow_path(config),
                    source_path=source_path,
                    prompt=body.adhoc_prompt_text,
                    job_id=job_id,
                )
            except Exception as e:
                raise RuntimeError(f"ComfyUI request failed: {e}") from e
        else:
            model = body.model or config["default_model"]
            max_dim = body.max_dim or config["default_max_dim"]
            aspect_ratio = body.aspect_ratio
            try:
                image_bytes, revised_prompt = grok_client.generate_image_edit(
                    api_key=cfg.get_api_key(),
                    source_path=source_path,
                    prompt=body.adhoc_prompt_text,
                    model=model,
                    aspect_ratio=aspect_ratio,
                    max_dim=max_dim,
                )
            except Exception as e:
                raise RuntimeError(f"Grok API request failed: {e}") from e

        result_id = db.new_id()
        file_name = storage.save_result_image(
            image["project_id"], result_id, body.adhoc_prompt_text, image_bytes,
            metadata={
                "revised_prompt": revised_prompt,
                "engine": engine,
                "model": model,
                "aspect_ratio": aspect_ratio,
            },
        )
        result = db.create_result(
            image_id=image["id"],
            file_path=file_name,
            prompt_id=body.prompt_id,
            adhoc_prompt_text=body.adhoc_prompt_text,
            engine=engine,
            model=model,
            aspect_ratio=aspect_ratio,
            max_dim=max_dim,
            revised_prompt=revised_prompt,
            result_id=result_id,
        )
        jobs.finish_job(job_id, result_id=result["id"])
    except Exception as e:
        jobs.finish_job(job_id, error=str(e))


@router.get("/api/results/{result_id}/file")
def get_result_file(result_id: str):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(404, "Result not found")
    image = db.get_image(result["image_id"])
    path = storage.result_image_path(image["project_id"], result["file_path"])
    if not path.exists():
        raise HTTPException(404, "Result file missing on disk")
    return FileResponse(path, media_type="image/png")


@router.get("/api/results/{result_id}/thumbnail")
def get_result_thumbnail(result_id: str):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(404, "Result not found")
    image = db.get_image(result["image_id"])
    path = storage.result_image_path(image["project_id"], result["file_path"])
    if not path.exists():
        raise HTTPException(404, "Result file missing on disk")
    thumb_path = storage.get_or_create_thumbnail("results", image["project_id"], result_id, path)
    return FileResponse(thumb_path, media_type="image/jpeg")


@router.put("/api/results/{result_id}/evaluation")
def update_evaluation(result_id: str, body: EvaluationIn):
    if not db.get_result(result_id):
        raise HTTPException(404, "Result not found")
    return db.update_evaluation(result_id, body.evaluation)


@router.put("/api/results/{result_id}/activate")
def activate_result(result_id: str):
    if not db.get_result(result_id):
        raise HTTPException(404, "Result not found")
    return db.set_active_result(result_id)


@router.delete("/api/results/{result_id}")
def delete_result(result_id: str):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(404, "Result not found")
    db.soft_delete_result(result_id)
    return {"ok": True}


@router.post("/api/results/{result_id}/restore")
def restore_result(result_id: str):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(404, "Result not found")
    return db.restore_result(result_id)


@router.delete("/api/results/{result_id}/permanent")
def permanently_delete_result(result_id: str):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(404, "Result not found")
    if not result["is_deleted"]:
        raise HTTPException(400, "Result must be trashed before it can be permanently deleted")
    image = db.get_image(result["image_id"])
    storage.delete_result_image(image["project_id"], result["file_path"])
    storage.clear_thumbnail("results", image["project_id"], result_id)
    db.delete_result(result_id)
    return {"ok": True}


@router.post("/api/projects/{project_id}/results/trash-no")
def trash_no_results(project_id: str):
    if not db.get_project(project_id):
        raise HTTPException(404, "Project not found")
    trashed = db.trash_no_results(project_id)
    return {"trashed": trashed}
