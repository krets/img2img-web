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

try:
    from websockets.sync.client import connect as _ws_connect
except ImportError:
    _ws_connect = None

LOAD_IMAGE_NODE = "637"
POSITIVE_PROMPT_NODE = "515:74"
SEED_NODE = "515:73"
SAVE_IMAGE_NODE = "516"

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
    """Resizes the source image to max_dim before upload if it's larger, so a
    slow or remote ComfyUI connection doesn't have to transfer a full-resolution
    original for every generation (mirrors the Grok engine's preprocessing).
    Returns (bytes, filename); passes the file through untouched if no resize
    is needed.
    """
    if max_dim:
        img = Image.open(image_path)
        if max(img.size) > max_dim:
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                img_rgba = img.convert("RGBA")
                bg.paste(img_rgba, mask=img_rgba.split()[3])
                img = bg
            else:
                img = img.convert("RGB")
            img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue(), Path(image_path).stem + ".png"
    with open(image_path, "rb") as f:
        return f.read(), Path(image_path).name


def _upload_image(base_url, image_path, max_dim=None):
    image_bytes, filename = _prepare_upload(image_path, max_dim)
    files = {"image": (filename, image_bytes, "image/png")}
    response = requests.post(
        f"{base_url}/upload/image", files=files, data={"overwrite": "true"}, timeout=REQUEST_TIMEOUT_SECONDS
    )
    response.raise_for_status()
    return response.json()["name"]


def generate_image_edit(base_url, workflow_path, source_path, prompt, job_id, max_dim=None):
    """Runs the Flux.2 ComfyUI workflow against a source image on disk.
    Returns (image_bytes, revised_prompt) — revised_prompt is always None since
    ComfyUI doesn't rewrite prompts the way the Grok API does.
    """
    base_url = base_url.rstrip("/")

    jobs.update_job(job_id, phase="uploading", value=0, max=0)
    workflow = _load_workflow(workflow_path)
    uploaded_name = _upload_image(base_url, source_path, max_dim=max_dim)

    # Every LoadImage node gets pointed at the uploaded source image. The workflow
    # has unused reference/mask branches (from whatever ComfyUI session it was
    # exported from) that ComfyUI still evaluates even though a switch node
    # discards their output, so they need a valid file to read too.
    for node in workflow.values():
        if node.get("class_type") == "LoadImage":
            node["inputs"]["image"] = uploaded_name

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

    history_entry = _wait_for_result(base_url, job_id, prompt_id)
    jobs.update_job(job_id, phase="saving")
    outputs = history_entry.get("outputs", {})
    save_node_output = outputs.get(SAVE_IMAGE_NODE)
    if not save_node_output or not save_node_output.get("images"):
        raise RuntimeError(f"ComfyUI run finished without a saved image. Outputs: {outputs}")

    image_info = save_node_output["images"][0]
    image_bytes = _download_image(base_url, image_info)
    return image_bytes, None


def _wait_for_result(base_url, job_id, prompt_id):
    if _ws_connect is not None:
        try:
            entry = _wait_for_result_ws(base_url, job_id, prompt_id)
            if entry:
                return entry
        except Exception:
            pass  # websocket path failed for any reason — fall back to HTTP polling
    return _wait_for_result_http(base_url, job_id, prompt_id)


def _wait_for_result_ws(base_url, job_id, prompt_id):
    """Follows ComfyUI's websocket event stream for live step progress.
    Returns the history entry once execution completes, or None if the
    connection ends without a clear completion signal (caller falls back
    to HTTP polling in that case).
    """
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/ws?clientId={job_id}"
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    with _ws_connect(ws_url, open_timeout=WS_OPEN_TIMEOUT_SECONDS) as ws:
        while time.time() < deadline:
            try:
                raw = ws.recv(timeout=max(1.0, deadline - time.time()))
            except TimeoutError:
                break
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
                jobs.update_job(job_id, phase="running")
            elif msg_type == "execution_error":
                raise RuntimeError(f"ComfyUI execution failed: {msg_data}")
    return None


def _wait_for_result_http(base_url, job_id, prompt_id):
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    while time.time() < deadline:
        entry = _fetch_history(base_url, prompt_id)
        if entry:
            return entry
        jobs.update_job(job_id, phase="running")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError(f"Timed out waiting for ComfyUI to finish prompt {prompt_id}")


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
