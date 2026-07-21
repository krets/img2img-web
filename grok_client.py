"""Thin wrapper around the existing grok_img2img.py functions for use by the FastAPI app.

Reuses load_and_preprocess_image / call_grok_img2img / download_image as-is;
adds a connectivity check helper used by the config UI.
"""

import requests

from grok_img2img import (
    DEFAULT_MODEL,
    call_grok_img2img,
    download_image,
    load_and_preprocess_image,
)


def generate_image_edit(api_key, source_path, prompt, model=None, aspect_ratio=None, max_dim=1024):
    """Runs a single image-to-image edit against a source file on disk.
    Returns (image_bytes, revised_prompt).
    """
    model = model or DEFAULT_MODEL
    image_input = load_and_preprocess_image(source_path, max_dim=max_dim)
    response_data = call_grok_img2img(
        api_key=api_key,
        prompt=prompt,
        image_input=image_input,
        model=model,
        aspect_ratio=aspect_ratio,
    )
    generated_data = response_data.get("data", [])
    if not generated_data:
        raise RuntimeError(f"API response did not contain image data. Response: {response_data}")

    generated_url = generated_data[0].get("url")
    if not generated_url:
        raise RuntimeError(f"API response did not contain an image URL. Response: {response_data}")

    revised_prompt = generated_data[0].get("revised_prompt")
    image_bytes = download_image(generated_url)
    return image_bytes, revised_prompt


def check_connection(api_key):
    """Lightweight check that the given xAI API key is accepted by the API."""
    if not api_key:
        return False, "No API key configured."
    try:
        response = requests.get(
            "https://api.x.ai/v1/api-key",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
    except Exception as e:
        return False, f"Network error: {e}"

    if response.status_code == 200:
        return True, "Connected."
    if response.status_code in (401, 403):
        return False, "API key rejected (unauthorized)."
    return False, f"Unexpected response: {response.status_code}"
