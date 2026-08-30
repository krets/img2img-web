"""MCP bridge for the Image-to-Image Library Manager.

Exposes a small tool surface over the existing FastAPI app's HTTP API so an
MCP client (e.g. LM Studio) can drive prompt -> generate -> look -> rate
loops against a running instance. This process does not import or run any
app code itself -- it just makes HTTP calls to an already-running server
(see WORKSPACE_URL / --port in server.py) and re-shapes the responses.

Run directly (stdio transport, for use from an MCP client config):
    .venv/Scripts/python.exe mcp_server.py

The target app server must already be running (default: http://127.0.0.1:8765).
Override with the GROK_IMG2IMG_URL env var if it's on a different host/port.
"""

import base64
import os
import time

import requests
from mcp.server.mcpserver import MCPServer
from mcp.types import ImageContent, TextContent

BASE_URL = os.environ.get("GROK_IMG2IMG_URL", "http://127.0.0.1:8765").rstrip("/")
POLL_INTERVAL_SECONDS = 2

mcp = MCPServer(
    "grok-img2img",
    instructions=(
        "Tools for the local Image-to-Image Library Manager. Typical loop: "
        "list_projects -> list_images to pick a source image -> get_image to see it -> "
        "generate with a prompt (blocks until the result image comes back) -> "
        "rate_result with your judgement -> repeat with a revised prompt if needed."
    ),
)


def _request(method, path, **kwargs):
    resp = requests.request(method, f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 15), **kwargs)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise RuntimeError(f"{method} {path} -> {resp.status_code}: {detail}")
    return resp


def _image_block(path, mime_type="image/jpeg"):
    resp = _request("GET", path)
    return ImageContent(type="image", data=base64.b64encode(resp.content).decode(), mimeType=mime_type)


@mcp.tool()
def list_projects() -> list[dict]:
    """List all projects in the library (id, name, slug, description)."""
    return [
        {"id": p["id"], "name": p["name"], "slug": p["slug"], "description": p.get("description")}
        for p in _request("GET", "/api/projects").json()
    ]


@mcp.tool()
def list_images(project_id: str, filter: str = "all", search: str | None = None) -> list[dict]:
    """List images in a project.

    filter: "all" | "unprocessed" (no results yet) | "YES" | "NO" | "MAYBE" | "UNRATED"
    (the YES/NO/MAYBE/UNRATED values filter by the *active* result's rating).
    """
    params = {"filter": filter}
    if search:
        params["search"] = search
    rows = _request("GET", f"/api/projects/{project_id}/images", params=params).json()
    return [
        {
            "id": r["id"],
            "display_name": r["display_name"],
            "comment": r.get("comment"),
            "result_count": r["result_count"],
            "active_evaluation": r.get("active_evaluation"),
        }
        for r in rows
    ]


@mcp.tool()
def get_image(image_id: str) -> list[TextContent | ImageContent]:
    """Get an image's details -- display name, comment, and every prior result
    with its prompt and rating -- plus the source picture itself, so you can
    see what you'd be editing before generating."""
    info = _request("GET", f"/api/images/{image_id}").json()
    summary = {
        "id": info["id"],
        "display_name": info["display_name"],
        "comment": info.get("comment"),
        "results": [
            {
                "id": r["id"],
                "prompt": r.get("adhoc_prompt_text"),
                "revised_prompt": r.get("revised_prompt"),
                "evaluation": r["evaluation"],
                "is_active_result": r["is_active_result"],
            }
            for r in info["results"]
        ],
    }
    return [TextContent(type="text", text=str(summary)), _image_block(f"/api/images/{image_id}/preview")]


@mcp.tool()
def generate(image_id: str, prompt: str, engine: str | None = None, timeout_seconds: int = 180) -> list[TextContent | ImageContent]:
    """Run an image-to-image edit on the given source image with the given prompt text.
    Blocks until the generation finishes (polling), then returns the resulting
    image plus its result_id (needed for rate_result) and the engine's revised
    prompt, if any.

    engine: "grok" | "fal" | "comfyui" -- omit to use the app's configured default.
    """
    body = {"adhoc_prompt_text": prompt}
    if engine:
        body["engine"] = engine
    job = _request("POST", f"/api/images/{image_id}/generate", json=body).json()
    job_id = job["id"]

    deadline = time.time() + timeout_seconds
    final = None
    while time.time() < deadline:
        jobs_now = _request("GET", "/api/queue").json()
        current = next((j for j in jobs_now if j["id"] == job_id), None)
        if current is None or current["status"] in ("done", "error", "cancelled"):
            final = current
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    if final is None:
        return [TextContent(
            type="text",
            text=f"Timed out after {timeout_seconds}s waiting for job {job_id}. "
                 "It may still be running -- try again shortly, or check the app's queue.",
        )]
    if final["status"] == "error":
        return [TextContent(type="text", text=f"Generation failed: {final.get('error')}")]
    if final["status"] == "cancelled":
        return [TextContent(type="text", text="Generation was cancelled.")]

    result_id = final["result_id"]
    result = _request("GET", f"/api/images/{image_id}").json()
    revised = next((r.get("revised_prompt") for r in result["results"] if r["id"] == result_id), None)
    return [
        TextContent(type="text", text=f"result_id={result_id} revised_prompt={revised!r}"),
        _image_block(f"/api/results/{result_id}/preview"),
    ]


@mcp.tool()
def rate_result(result_id: str, evaluation: str) -> str:
    """Rate a result. evaluation must be one of: YES, MAYBE, NO, UNRATED."""
    _request("PUT", f"/api/results/{result_id}/evaluation", json={"evaluation": evaluation})
    return f"Rated {result_id} as {evaluation}."


if __name__ == "__main__":
    mcp.run(transport="stdio")
