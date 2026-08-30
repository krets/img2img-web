"""Client for fal.ai's synchronous REST API, used as an alternative image
generation engine (FLUX.1 Kontext by default) alongside Grok and ComfyUI.

Reuses load_and_preprocess_image from grok_img2img.py to produce a base64
data URI -- fal's image_url inputs accept data URIs directly, so no separate
upload step is needed.
"""

import requests

from grok_img2img import load_and_preprocess_image

DEFAULT_MODEL = "fal-ai/flux-pro/kontext"
FAL_RUN_BASE = "https://fal.run"
FAL_QUEUE_BASE = "https://queue.fal.run"
FAL_MODELS_BASE = "https://api.fal.ai/v1/models"
REQUEST_TIMEOUT_SECONDS = 180

# Per-model request shape. fal's edit models don't share one schema: the image
# field is `image_url` (singular) for the Kontext family but `image_urls`
# (array) for everything newer (FLUX.2 and beyond), and the safety-filter
# knobs -- field names present, and even the safety_tolerance numeric range
# (1-6 vs 1-5) -- vary per model generation in ways that aren't discoverable
# from the request itself. `safety_extra` sets each field this model exposes
# to its most permissive value; unrecognized models fall back to the most
# common newer-generation shape via DEFAULT_MODEL_SPEC, which may not be
# correct for every case.
MODEL_SPECS = {
    "fal-ai/flux-pro/kontext": {
        "image_field": "image_url",
        "safety_extra": {"safety_tolerance": "6"},
    },
    "fal-ai/flux-pro/kontext/max": {
        "image_field": "image_url",
        "safety_extra": {"safety_tolerance": "6"},
    },
    "fal-ai/flux-kontext/dev": {
        "image_field": "image_url",
        "safety_extra": {"enable_safety_checker": False},
    },
    "fal-ai/flux-2/klein/4b/edit": {
        "image_field": "image_urls",
        "safety_extra": {"enable_safety_checker": False},
    },
    "fal-ai/flux-2/klein/9b/edit": {
        "image_field": "image_urls",
        "safety_extra": {"enable_safety_checker": False},
    },
    "fal-ai/flux-2-pro/edit": {
        "image_field": "image_urls",
        "safety_extra": {"safety_tolerance": "5", "enable_safety_checker": False},
    },
    "fal-ai/flux-2-flex/edit": {
        "image_field": "image_urls",
        "safety_extra": {"safety_tolerance": "5", "enable_safety_checker": False},
    },
}
DEFAULT_MODEL_SPEC = {"image_field": "image_urls", "safety_extra": {"enable_safety_checker": False}}


def _model_spec(model):
    return MODEL_SPECS.get(model, DEFAULT_MODEL_SPEC)


def supports_multiple_images(model):
    """True if this model's request shape takes an `image_urls` array (the
    Kontext family only exposes a singular `image_url` field and can't take
    extra reference images at all).
    """
    return _model_spec(model)["image_field"] == "image_urls"


# fal.ai's model-search API buckets everything under a broad "image-to-image"
# category -- upscalers, background removal, segmentation, inpainting/outpainting,
# vectorizers, etc all land there alongside actual prompt-driven edit models.
# There's no dedicated "edit" category to filter on, so these substrings flag
# endpoint_id/group-label combinations that need a different request shape
# (a mask, a strength parameter, no prompt at all) than the plain
# (prompt, image) shape generate_image_edit sends, even when "edit" also
# appears in the name.
_NON_EDIT_HINTS = (
    "upscale", "vectorize", "segment", "-rle", "background", "rembg",
    "depth", "tryon", "try-on", "product-shot", "outpaint", "expand",
    "erase", "inpaint", "reframe", "mask", "layerize", "layered",
    "extract-frame", "photo-restoration", "auto-segment",
)


def list_edit_models(api_key=None, max_pages=10):
    """Queries fal.ai's public model-search API (https://api.fal.ai/v1/models)
    for image-to-image models and filters down to ones that look like
    prompt-driven edit models. Best-effort: fal has no dedicated "edit"
    category, so this is a name/label heuristic and can include false
    positives or miss unusually-named models -- models it turns up that
    aren't in MODEL_SPECS above just fall back to DEFAULT_MODEL_SPEC, same
    as a manually-entered custom model ID.
    """
    headers = {"Authorization": f"Key {api_key}"} if api_key else {}
    models = []
    cursor = None
    for _ in range(max_pages):
        params = {"category": "image-to-image", "limit": 100}
        if cursor:
            params["cursor"] = cursor
        try:
            response = requests.get(FAL_MODELS_BASE, params=params, headers=headers, timeout=15)
        except Exception as e:
            raise RuntimeError(f"fal.ai model search request failed: {e}")
        if response.status_code != 200:
            raise RuntimeError(f"fal.ai model search failed with status code {response.status_code}: {response.text}")
        data = response.json()
        models.extend(data.get("models", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
        if not cursor:
            break

    results = []
    for m in models:
        endpoint_id = m.get("endpoint_id", "")
        meta = m.get("metadata", {})
        if meta.get("status") != "active":
            continue
        group_label = (meta.get("group") or {}).get("label", "")
        haystack = f"{endpoint_id} {group_label}".lower()
        if "edit" not in haystack:
            continue
        if any(hint in haystack for hint in _NON_EDIT_HINTS):
            continue
        results.append(
            {
                "value": endpoint_id,
                "label": meta.get("display_name") or endpoint_id,
                "group": group_label or "fal.ai",
            }
        )
    results.sort(key=lambda r: (r["group"], r["label"]))
    return results


def generate_image_edit(api_key, source_path, prompt, model=None, max_dim=1024, extra_source_paths=None):
    """Runs an image-to-image edit against a source file on disk via fal.ai,
    optionally with extra reference images (only supported by models whose
    spec uses the `image_urls` array field -- see supports_multiple_images).
    Returns (image_bytes, revised_prompt) -- fal doesn't rewrite prompts the
    way the Grok API does, so revised_prompt is always None.
    """
    model = model or DEFAULT_MODEL
    extra_source_paths = list(extra_source_paths or [])
    image_data_uri = load_and_preprocess_image(source_path, max_dim=max_dim)

    headers = {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
    }
    spec = _model_spec(model)
    if spec["image_field"] == "image_url":
        if extra_source_paths:
            raise ValueError(f"Model '{model}' only accepts a single input image and can't take reference images.")
        image_field = {"image_url": image_data_uri}
    else:
        extra_data_uris = [load_and_preprocess_image(p, max_dim=max_dim) for p in extra_source_paths]
        image_field = {"image_urls": [image_data_uri, *extra_data_uris]}
    payload = {"prompt": prompt, **image_field, **spec["safety_extra"]}

    try:
        response = requests.post(
            f"{FAL_RUN_BASE}/{model}", json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS
        )
    except Exception as e:
        raise RuntimeError(f"Network error occurred during fal.ai request: {e}")

    if response.status_code != 200:
        try:
            error_data = response.json()
        except Exception:
            raise RuntimeError(f"fal.ai request failed with status code {response.status_code}: {response.text}")

        detail = error_data.get("detail", error_data)
        # This is a platform-level input moderation gate that runs before the
        # model does, distinct from (and not affected by) the model's own
        # safety_tolerance/enable_safety_checker output-side filter.
        if isinstance(detail, list) and any(
            isinstance(d, dict) and d.get("type") == "content_policy_violation" for d in detail
        ):
            raise RuntimeError(
                "fal.ai's content moderation rejected this request before generation started "
                "(prompt and/or image flagged). This can't be relaxed via any request setting -- "
                "reword the prompt or use a different engine for this image."
            )
        error_msg = detail if isinstance(detail, str) else error_data
        raise RuntimeError(f"fal.ai request failed with status code {response.status_code}: {error_msg}")

    response_data = response.json()
    images = response_data.get("images", [])
    if not images:
        raise RuntimeError(f"fal.ai response did not contain image data. Response: {response_data}")

    if any(response_data.get("has_nsfw_concepts", [])):
        raise RuntimeError(
            "fal.ai's content filter flagged this generation and returned a blank image instead "
            "(this can happen even with the safety filter relaxed as far as this model allows). "
            "Try rewording the prompt or switching engines."
        )

    image_url = images[0].get("url")
    if not image_url:
        raise RuntimeError(f"fal.ai response did not contain an image URL. Response: {response_data}")

    image_response = requests.get(image_url, timeout=REQUEST_TIMEOUT_SECONDS)
    image_response.raise_for_status()
    return image_response.content, None


def check_connection(api_key):
    """Lightweight check that the given fal.ai API key is accepted.
    Submits an empty body to the queue endpoint -- fal checks auth before
    validating the request body, so a 401/403 means a bad key while a 422
    (missing required fields) means the key is fine, without ever running
    or paying for an actual model call.
    """
    if not api_key:
        return False, "No API key configured."
    try:
        response = requests.post(
            f"{FAL_QUEUE_BASE}/{DEFAULT_MODEL}",
            json={},
            headers={"Authorization": f"Key {api_key}"},
            timeout=10,
        )
    except Exception as e:
        return False, f"Network error: {e}"

    if response.status_code in (401, 403):
        return False, "API key rejected (unauthorized)."
    if response.status_code in (200, 422):
        return True, "Connected."
    return False, f"Unexpected response: {response.status_code}"
