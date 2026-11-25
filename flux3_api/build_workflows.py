"""Writes flux3_edit_{1..4}ref.json: FLUX.3 Klein image edit, API format.

Node ids are fixed so a client can patch values by id (see README.md).
Reference i is chained in order, so ref 1 is the primary image. The output
size follows the primary: scale_1 sets its total pixels (snapped to
multiples of 16) and the output uses that width and height.
"""
import json
from pathlib import Path

DEFAULT_MP = [1.0, 0.7, 0.5, 0.5]


def build(num_refs, vl=False):
    """vl=True swaps the plain CLIPTextEncode for TextEncodeFlux3ImageEdit
    (custom_nodes/flux3_vl_edit in the ComfyUI install), which also feeds the
    loaded references into the Qwen3-VL text encoder itself -- on top of,
    not instead of, the VAEEncode -> ReferenceLatent chain below, which is
    unchanged. Experimental/unverified -- see that node's docstring.
    """
    wf = {
        "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "flux-3-image-klein-Q8_0.gguf"}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "flux3", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
    }
    if vl:
        prompt_inputs = {"text": "", "clip": ["clip", 0], "vision_resolution": 384}
        for i in range(1, num_refs + 1):
            prompt_inputs[f"image{i}"] = [f"load_{i}", 0]
        wf["prompt"] = {"class_type": "TextEncodeFlux3ImageEdit", "inputs": prompt_inputs}
    else:
        wf["prompt"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}}
    cond = ["prompt", 0]
    for i in range(1, num_refs + 1):
        wf[f"load_{i}"] = {"class_type": "LoadImage", "inputs": {"image": f"ref_{i}.png"}}
        wf[f"scale_{i}"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [f"load_{i}", 0], "upscale_method": "lanczos", "megapixels": DEFAULT_MP[i - 1], "resolution_steps": 16 if i == 1 else 1}}
        wf[f"enc_{i}"] = {"class_type": "VAEEncode", "inputs": {"pixels": [f"scale_{i}", 0], "vae": ["vae", 0]}}
        wf[f"reflat_{i}"] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": cond, "latent": [f"enc_{i}", 0]}}
        cond = [f"reflat_{i}", 0]
    wf.update({
        "guider": {"class_type": "BasicGuider", "inputs": {"model": ["unet", 0], "conditioning": cond}},
        "sampler_select": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "size": {"class_type": "GetImageSize", "inputs": {"image": ["scale_1", 0]}},
        "scheduler": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": ["size", 0], "height": ["size", 1]}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": 0}},
        "latent": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": ["size", 0], "height": ["size", 1], "batch_size": 1}},
        "sampler": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["sampler_select", 0], "sigmas": ["scheduler", 0], "latent_image": ["latent", 0]}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sampler", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": f"flux3_edit_{'vl_' if vl else ''}{num_refs}ref"}},
    })
    return wf


if __name__ == "__main__":
    here = Path(__file__).parent
    for n in range(1, 5):
        (here / f"flux3_edit_{n}ref.json").write_text(json.dumps(build(n), indent=1))
        (here / f"flux3_edit_vl_{n}ref.json").write_text(json.dumps(build(n, vl=True), indent=1))
