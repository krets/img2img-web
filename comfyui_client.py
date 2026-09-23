"""Client for running the local ComfyUI Flux.2 image-edit workflow as an
alternative generation engine to the Grok API.

Loads the exported API-format workflow JSON (comfyui_flux2_imageedit.json),
swaps in the source image and prompt text, submits it to a running ComfyUI
server, and polls for the resulting image. Progress is reported into the
shared job registry (jobs.py) keyed by job_id (reused as ComfyUI's
client_id) so the frontend's queue overlay can follow it live.
"""

import json
import random
import time
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

import jobs
from grok_img2img import DIM_MULTIPLE, aligned_size

try:
    from websockets.sync.client import connect as _ws_connect
except ImportError:
    _ws_connect = None

LOAD_IMAGE_NODE = "637"
POSITIVE_PROMPT_NODE = "515:74"
SEED_NODE = "515:73"
SAVE_IMAGE_NODE = "516"
# Optional extra reference images, in slot order. The workflow's index node
# (INDEX_NODE) tells a chain of switch nodes how many of these are "real" --
# anything beyond that count stays wired to a blank placeholder internally.
EXTRA_IMAGE_NODES = ["605", "638"]
INDEX_NODE = "515:604"

POLL_INTERVAL_SECONDS = 1.0
POLL_TIMEOUT_SECONDS = 300
# Generous ceiling for individual HTTP calls (upload, submit, poll, download) so a
# flaky/slow network doesn't abort a request that would've completed given more time.
REQUEST_TIMEOUT_SECONDS = 120
WS_OPEN_TIMEOUT_SECONDS = 30


def _load_workflow(workflow_path):
    with open(workflow_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _prepare_upload(image_path, max_dim):
    """Resizes the source image to fit max_dim, with both sides snapped to the
    model's patch grid (DIM_MULTIPLE), before upload -- so a slow or remote
    ComfyUI connection doesn't have to transfer a full-resolution original for
    every generation (mirrors the Grok engine's preprocessing).
    Returns (bytes, filename); passes the file through untouched if no resize
    is needed.
    """
    img = Image.open(image_path)
    target = aligned_size(*img.size, max_dim=max_dim)
    if target != img.size:
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            img_rgba = img.convert("RGBA")
            bg.paste(img_rgba, mask=img_rgba.split()[3])
            img = bg
        else:
            img = img.convert("RGB")
        img = img.resize(target, Image.Resampling.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), Path(image_path).stem + ".png"
    with open(image_path, "rb") as f:
        return f.read(), Path(image_path).name


def _align_scale_nodes(workflow):
    """The workflow rescales inputs to a fixed megapixel budget in-graph, which
    lands on arbitrary sizes. VAEEncode then silently crops to the latent grid
    while the scheduler is fed the uncropped size, so the output loses an edge
    sliver and the reference latents don't line up. Snap those rescales to
    the grid so every stage agrees on the size.
    """
    for node in workflow.values():
        if node.get("class_type") == "ImageScaleToTotalPixels":
            node["inputs"]["resolution_steps"] = DIM_MULTIPLE


def _upload_image(base_url, image_path, max_dim=None):
    image_bytes, filename = _prepare_upload(image_path, max_dim)
    files = {"image": (filename, image_bytes, "image/png")}
    response = requests.post(
        f"{base_url}/upload/image", files=files, data={"overwrite": "true"}, timeout=REQUEST_TIMEOUT_SECONDS
    )
    response.raise_for_status()
    return response.json()["name"]


def generate_image_edit(base_url, workflow_path, source_path, prompt, job_id, max_dim=None, extra_source_paths=None):
    """Runs the Flux.2 ComfyUI workflow against a source image on disk, plus up
    to len(EXTRA_IMAGE_NODES) additional reference images. Returns
    (image_bytes, revised_prompt, processing_seconds) — revised_prompt is
    always None since ComfyUI doesn't rewrite prompts the way the Grok API
    does. processing_seconds covers only actual GPU execution (from the
    moment ComfyUI starts running our prompt to completion), excluding time
    spent waiting behind other jobs in ComfyUI's own queue; it's None if
    that moment was never observed (e.g. HTTP-polling fallback that missed
    a very short run).
    """
    base_url = base_url.rstrip("/")
    extra_source_paths = list(extra_source_paths or [])
    if len(extra_source_paths) > len(EXTRA_IMAGE_NODES):
        raise ValueError(f"ComfyUI workflow supports at most {len(EXTRA_IMAGE_NODES)} extra reference images")

    if jobs.is_cancelled(job_id):
        raise jobs.GenerationCancelled()

    jobs.update_job(job_id, phase="uploading", value=0, max=0)
    workflow = _load_workflow(workflow_path)
    _align_scale_nodes(workflow)
    uploaded_name = _upload_image(base_url, source_path, max_dim=max_dim)

    # Every LoadImage node gets pointed at the uploaded source image by default.
    # The workflow has reference-image slots (EXTRA_IMAGE_NODES) that ComfyUI
    # still evaluates even when the index node below leaves them switched out,
    # so they need a valid file to read too -- falling back to the primary
    # image is harmless since their output is discarded downstream in that case.
    for node in workflow.values():
        if node.get("class_type") == "LoadImage":
            node["inputs"]["image"] = uploaded_name

    for node_id, extra_path in zip(EXTRA_IMAGE_NODES, extra_source_paths):
        workflow[node_id]["inputs"]["image"] = _upload_image(base_url, extra_path, max_dim=max_dim)

    if INDEX_NODE in workflow:
        workflow[INDEX_NODE]["inputs"]["b"] = len(extra_source_paths)

    if POSITIVE_PROMPT_NODE in workflow:
        workflow[POSITIVE_PROMPT_NODE]["inputs"]["text"] = prompt
    if SEED_NODE in workflow:
        workflow[SEED_NODE]["inputs"]["noise_seed"] = random.randint(0, 2**63 - 1)

    jobs.update_job(job_id, phase="queued")
    response = requests.post(
        f"{base_url}/prompt", json={"prompt": workflow, "client_id": job_id}, timeout=REQUEST_TIMEOUT_SECONDS
    )
    if response.status_code != 200:
        raise RuntimeError(f"ComfyUI rejected the prompt: {response.status_code} {response.text}")
    data = response.json()
    if data.get("node_errors"):
        raise RuntimeError(f"ComfyUI reported node errors: {data['node_errors']}")
    prompt_id = data["prompt_id"]
    jobs.update_job(job_id, prompt_id=prompt_id)

    if jobs.is_cancelled(job_id):
        _cancel_on_comfyui(base_url, prompt_id)
        raise jobs.GenerationCancelled()

    history_entry = _wait_for_result(base_url, job_id, prompt_id)
    finished_at = time.time()
    jobs.update_job(job_id, phase="saving")
    outputs = history_entry.get("outputs", {})
    save_node_output = outputs.get(SAVE_IMAGE_NODE)
    if not save_node_output or not save_node_output.get("images"):
        raise RuntimeError(f"ComfyUI run finished without a saved image. Outputs: {outputs}")

    image_info = save_node_output["images"][0]
    image_bytes = _download_image(base_url, image_info)

    job = jobs.get_job(job_id)
    processing_started_at = job.get("processing_started_at") if job else None
    processing_seconds = (finished_at - processing_started_at) if processing_started_at else None
    return image_bytes, None, processing_seconds


def _wait_for_result(base_url, job_id, prompt_id):
    if _ws_connect is not None:
        try:
            entry = _wait_for_result_ws(base_url, job_id, prompt_id)
            if entry:
                return entry
        except jobs.GenerationCancelled:
            raise  # a real cancellation, not a transport hiccup -- don't mask it
        except Exception:
            pass  # websocket path failed for any other reason — fall back to HTTP polling
    return _wait_for_result_http(base_url, job_id, prompt_id)


def _wait_for_result_ws(base_url, job_id, prompt_id):
    """Follows ComfyUI's websocket event stream for live step progress.
    Returns the history entry once execution completes, or None if the
    connection ends without a clear completion signal (caller falls back
    to HTTP polling in that case).
    """
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/ws?clientId={job_id}"
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    processing_started = False
    with _ws_connect(ws_url, open_timeout=WS_OPEN_TIMEOUT_SECONDS) as ws:
        while time.time() < deadline:
            if jobs.is_cancelled(job_id):
                _cancel_on_comfyui(base_url, prompt_id)
                raise jobs.GenerationCancelled()
            try:
                # Capped well below the overall deadline so cancellation is
                # noticed promptly even during a long quiet stretch (e.g.
                # sitting in ComfyUI's own queue behind other work).
                raw = ws.recv(timeout=min(2.0, max(0.5, deadline - time.time())))
            except TimeoutError:
                continue
            if isinstance(raw, (bytes, bytearray)):
                continue  # binary preview-image frame, not a status message
            try:
                msg = json.loads(raw)
            except ValueError:
                continue

            msg_data = msg.get("data") or {}
            if msg_data.get("prompt_id") not in (None, prompt_id):
                continue

            msg_type = msg.get("type")
            if msg_type == "progress":
                if not processing_started:
                    jobs.update_job(job_id, processing_started_at=time.time())
                    processing_started = True
                jobs.update_job(job_id, phase="running", value=msg_data.get("value", 0), max=msg_data.get("max", 0))
            elif msg_type == "executing":
                if msg_data.get("prompt_id") == prompt_id and msg_data.get("node") is None:
                    # ComfyUI signals completion by clearing the executing node.
                    for _ in range(10):
                        entry = _fetch_history(base_url, prompt_id)
                        if entry:
                            return entry
                        time.sleep(0.5)
                    return None
                if not processing_started:
                    jobs.update_job(job_id, processing_started_at=time.time())
                    processing_started = True
                jobs.update_job(job_id, phase="running")
            elif msg_type == "execution_error":
                raise RuntimeError(f"ComfyUI execution failed: {msg_data}")
    return None


def _wait_for_result_http(base_url, job_id, prompt_id):
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    processing_started = False
    while time.time() < deadline:
        if jobs.is_cancelled(job_id):
            _cancel_on_comfyui(base_url, prompt_id)
            raise jobs.GenerationCancelled()
        entry = _fetch_history(base_url, prompt_id)
        if entry:
            return entry
        if not processing_started:
            try:
                running_ids = _fetch_queue_running_ids(base_url)
            except Exception:
                running_ids = set()
            if prompt_id in running_ids:
                jobs.update_job(job_id, processing_started_at=time.time())
                processing_started = True
        jobs.update_job(job_id, phase="running")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError(f"Timed out waiting for ComfyUI to finish prompt {prompt_id}")


def _cancel_on_comfyui(base_url, prompt_id):
    """Best-effort cancellation against ComfyUI's own queue. Only interrupts
    if this prompt is confirmed to be the one currently executing -- never
    blindly, since /interrupt stops whatever ComfyUI happens to be running,
    which could be a different job on the same (shared, single-GPU) queue.
    Otherwise just removes it from the pending queue before it starts.
    Failures are swallowed: the job is being marked cancelled in our own
    state regardless, and there's nothing more the caller can do here.
    """
    try:
        running_ids = _fetch_queue_running_ids(base_url)
    except Exception:
        return
    try:
        if prompt_id in running_ids:
            requests.post(f"{base_url}/interrupt", timeout=REQUEST_TIMEOUT_SECONDS)
        else:
            requests.post(f"{base_url}/queue", json={"delete": [prompt_id]}, timeout=REQUEST_TIMEOUT_SECONDS)
    except Exception:
        pass


def _fetch_queue_running_ids(base_url):
    state = requests.get(f"{base_url}/queue", timeout=REQUEST_TIMEOUT_SECONDS).json()
    return {entry[1] for entry in state.get("queue_running", [])}


def _fetch_history(base_url, prompt_id):
    response = requests.get(f"{base_url}/history/{prompt_id}", timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    entry = response.json().get(prompt_id)
    if not entry:
        return None
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        raise RuntimeError(f"ComfyUI execution failed: {status.get('messages')}")
    if entry.get("outputs"):
        return entry
    return None


def _download_image(base_url, image_info):
    response = requests.get(
        f"{base_url}/view",
        params={
            "filename": image_info["filename"],
            "subfolder": image_info.get("subfolder", ""),
            "type": image_info.get("type", "output"),
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.content


def check_connection(base_url):
    """Lightweight check that a ComfyUI server is reachable at base_url."""
    if not base_url:
        return False, "No ComfyUI URL configured."
    try:
        response = requests.get(f"{base_url.rstrip('/')}/system_stats", timeout=5)
    except Exception as e:
        return False, f"Network error: {e}"
    if response.status_code == 200:
        return True, "Connected."
    return False, f"Unexpected response: {response.status_code}"


def free_memory(base_url):
    """Hits ComfyUI's own /free endpoint to unload models and clear the node
    execution cache -- the same thing its "Unload Models" / "Free model and
    node cache" menu items do. Handy for self-managed ComfyUI instances
    sharing a GPU with other work, where you don't want models sitting
    resident in VRAM between generations.
    """
    if not base_url:
        return False, "No ComfyUI URL configured."
    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/free",
            json={"unload_models": True, "free_memory": True},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except Exception as e:
        return False, f"Network error: {e}"
    if response.status_code == 200:
        return True, "Models unloaded and cache freed."
    return False, f"Unexpected response: {response.status_code}"
