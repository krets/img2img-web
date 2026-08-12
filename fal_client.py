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


def generate_image_edit(api_key, source_path, prompt, model=None, max_dim=1024):
    """Runs a single image-to-image edit against a source file on disk via fal.ai.
    Returns (image_bytes, revised_prompt) -- fal doesn't rewrite prompts the
    way the Grok API does, so revised_prompt is always None.
    """
    model = model or DEFAULT_MODEL
    image_data_uri = load_and_preprocess_image(source_path, max_dim=max_dim)

    headers = {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
    }
    spec = _model_spec(model)
    if spec["image_field"] == "image_url":
        image_field = {"image_url": image_data_uri}
    else:
        image_field = {"image_urls": [image_data_uri]}
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
