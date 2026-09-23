#!/usr/bin/env python3
"""
Grok Image-to-Image (img2img) CLI tool.
Uses xAI's Grok Imagine API (grok-imagine-image-quality) to edit local images.
Pre-processes, resizes, and optimizes images before sending to minimize payload size.
"""

import os
import io
import base64
import sys
import argparse
import requests
import time
import hashlib
import json
from datetime import datetime
from PIL import Image
from dotenv import load_dotenv

# Load environment variables from a .env file if present
load_dotenv()

XAI_API_URL = "https://api.x.ai/v1/images/edits"
XAI_VIDEO_GEN_URL = "https://api.x.ai/v1/videos/generations"
DEFAULT_MODEL = "grok-imagine-image-quality"
DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5"

# Diffusion transformers see the image as a grid of latent patches: an 8x VAE
# plus 2x2 patchify (Flux) means every 16 pixels is one token. Sides that aren't
# a multiple of this get silently cropped or padded by the model, so we snap to it.
DIM_MULTIPLE = 16


def aligned_size(width, height, max_dim=None, multiple=DIM_MULTIPLE):
    """Returns (w, h) scaled down so the long edge fits max_dim, then with each
    side rounded to the nearest multiple of `multiple` (never exceeding
    max_dim). Rounding each side independently keeps aspect distortion under
    half a patch per side, which is imperceptible next to a crop.
    """
    scale = min(1.0, max_dim / max(width, height)) if max_dim else 1.0
    limit = (max_dim // multiple) * multiple if max_dim else None

    def snap(side):
        snapped = max(multiple, round(side * scale / multiple) * multiple)
        return min(snapped, limit) if limit and limit >= multiple else snapped

    return snap(width), snap(height)


def load_and_preprocess_image(image_input, max_dim=1024):
    """
    Loads an image (file path, file-like object, or PIL Image),
    flattens transparency to white, and resizes it so the long edge fits
    max_dim and both sides are multiples of DIM_MULTIPLE.
    Returns the base64-encoded data URI string.
    """
    if isinstance(image_input, (str, os.PathLike)):
        print(f"[*] Loading image: {image_input}")
        try:
            img = Image.open(image_input)
        except Exception as e:
            raise ValueError(f"Error loading image file: {e}")
    elif isinstance(image_input, Image.Image):
        print("[*] Processing PIL Image input...")
        img = image_input.copy()
    else:
        # File-like object (e.g. BytesIO from Streamlit)
        print("[*] Loading image from stream...")
        try:
            img = Image.open(image_input)
        except Exception as e:
            raise ValueError(f"Error loading image stream: {e}")
        
    orig_w, orig_h = img.size
    print(f"[*] Original image dimensions: {orig_w}x{orig_h} ({img.mode})")

    # Handle transparency (flatten RGBA / LA to RGB on a white background)
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        print("[*] Flattening transparency onto a white background...")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        img_rgba = img.convert("RGBA")
        bg.paste(img_rgba, mask=img_rgba.split()[3]) # Use alpha channel as mask
        img = bg
    else:
        img = img.convert("RGB")

    # Fit within max_dim and snap both sides to the model's patch grid
    target = aligned_size(*img.size, max_dim=max_dim)
    if target != img.size:
        print(f"[*] Resizing image to {target[0]}x{target[1]} (max {max_dim}px, multiple of {DIM_MULTIPLE})...")
        img = img.resize(target, Image.Resampling.LANCZOS)

    # Encode to base64
    print("[*] Encoding image to base64 PNG...")
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    img_bytes = buffered.getvalue()
    img_base64 = base64.b64encode(img_bytes).decode("utf-8")
    
    # Calculate approximate payload size in MB
    payload_size_mb = len(img_base64) / (1024 * 1024)
    print(f"[*] Processed payload size: {payload_size_mb:.2f} MB")
    
    return f"data:image/png;base64,{img_base64}"

def save_to_history(media_bytes, metadata, mode):
    """
    Saves the media file and its metadata to the local .cache/ directory.
    metadata should be a dict containing details like prompt, model, etc.
    """
    # Use workspace-relative path for .cache
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cache_dir = os.path.join(base_dir, ".cache")
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except Exception as e:
        print(f"[!] Warning: Failed to create cache directory: {e}")
        return None
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    prompt = metadata.get("prompt", "")
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]
    
    ext = "mp4" if mode == "video" else "png"
    base_name = f"grok_{timestamp}_{mode}_{prompt_hash}"
    media_filename = f"{base_name}.{ext}"
    json_filename = f"{base_name}.json"
    
    media_path = os.path.join(cache_dir, media_filename)
    json_path = os.path.join(cache_dir, json_filename)
    
    # Save media file
    try:
        with open(media_path, "wb") as f:
            f.write(media_bytes)
        print(f"[*] Saved copy to local cache: .cache/{media_filename}")
    except Exception as e:
        print(f"[!] Warning: Failed to save cached media file: {e}")
        return None
        
    # Save metadata JSON
    metadata["timestamp"] = datetime.now().isoformat()
    metadata["mode"] = mode
    metadata["filename"] = media_filename
    
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[!] Warning: Failed to save cached metadata: {e}")
        
    return media_path

def call_grok_image_to_video(api_key, prompt, image_input, model=DEFAULT_VIDEO_MODEL, aspect_ratio=None, duration=5, resolution="720p"):
    """
    Sends a POST request to xAI Grok Imagine Video API to start video generation.
    Returns the request_id.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "prompt": prompt,
        "duration": duration,
        "resolution": resolution
    }
    
    if image_input:
        payload["image"] = {
            "url": image_input
        }
        
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
        
    print(f"[*] Sending image-to-video request to xAI using model '{model}'...")
    try:
        response = requests.post(XAI_VIDEO_GEN_URL, json=payload, headers=headers)
    except Exception as e:
        raise RuntimeError(f"Network error occurred during API request: {e}")
        
    if response.status_code != 200:
        try:
            error_data = response.json()
            error_msg = error_data.get("error", {}).get("message", response.text)
        except Exception:
            error_msg = response.text
        raise RuntimeError(f"API Request failed with status code {response.status_code}: {error_msg}")
        
    response_json = response.json()
    request_id = response_json.get("request_id")
    if not request_id:
        raise RuntimeError(f"Failed to obtain request_id from API. Response: {response_json}")
        
    return request_id

def poll_video_status(api_key, request_id, poll_interval=5, timeout=300):
    """
    Polls the xAI Video Status API until the generation completes or fails.
    Returns the final response JSON containing the video data.
    """
    headers = {
        "Authorization": f"Bearer {api_key}"
    }
    
    status_url = f"https://api.x.ai/v1/videos/{request_id}"
    start_time = time.time()
    
    print(f"[*] Polling video status for request {request_id}...")
    while time.time() - start_time < timeout:
        try:
            response = requests.get(status_url, headers=headers)
            if response.status_code == 200:
                data = response.json()
                status = data.get("status")
                
                if status == "done":
                    print("\n[+] Video generation complete!")
                    return data
                elif status == "failed":
                    error_msg = data.get("error", {}).get("message", "Unknown error")
                    raise RuntimeError(f"Video generation failed: {error_msg}")
                elif status == "expired":
                    raise RuntimeError("Video generation request expired.")
                elif status == "processing":
                    elapsed = int(time.time() - start_time)
                    sys.stdout.write(f"\r[*] Generation processing... ({elapsed}s elapsed)")
                    sys.stdout.flush()
                else:
                    print(f"\n[*] Unknown status received: {status}")
            else:
                print(f"\n[!] Status check returned code {response.status_code}: {response.text}")
        except Exception as e:
            if not isinstance(e, RuntimeError):
                print(f"\n[!] Connection error while polling: {e}")
            else:
                raise e
                
        time.sleep(poll_interval)
        
    raise RuntimeError(f"Video generation timed out after {timeout} seconds.")

def call_grok_img2img(api_key, prompt, image_input, model=DEFAULT_MODEL, aspect_ratio=None):
    """
    Sends the request to the xAI Grok Imagine API for image-to-image editing.
    image_input can be a single base64 image data URI string, or a list of up to 3 strings.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "prompt": prompt
    }
    
    if isinstance(image_input, list):
        payload["images"] = [
            {"type": "image_url", "url": img} for img in image_input
        ]
    else:
        payload["image"] = {
            "type": "image_url",
            "url": image_input
        }
        
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
        
    print(f"[*] Sending image-to-image request to xAI using model '{model}'...")
    try:
        response = requests.post(XAI_API_URL, json=payload, headers=headers)
    except Exception as e:
        raise RuntimeError(f"Network error occurred during API request: {e}")
        
    if response.status_code != 200:
        try:
            error_data = response.json()
            error_msg = error_data.get("error", {}).get("message", response.text)
        except Exception:
            error_msg = response.text
        raise RuntimeError(f"API Request failed with status code {response.status_code}: {error_msg}")
        
    return response.json()

def download_image(url):
    """
    Downloads the image from the returned URL and returns the raw bytes.
    """
    print(f"[*] Downloading generated image from: {url}")
    try:
        img_response = requests.get(url, stream=True)
        if img_response.status_code == 200:
            buffered = io.BytesIO()
            for chunk in img_response.iter_content(chunk_size=8192):
                buffered.write(chunk)
            return buffered.getvalue()
        else:
            raise RuntimeError(f"Failed to download generated image. Status code: {img_response.status_code}")
    except Exception as e:
        raise RuntimeError(f"Error downloading image: {e}")

def download_and_save_image(url, output_path):
    """
    Downloads the image from the returned URL and saves it to output_path.
    """
    img_data = download_image(url)
    try:
        with open(output_path, 'wb') as f:
            f.write(img_data)
        print(f"[+] Successfully saved generated image to: {output_path}")
    except Exception as e:
        raise IOError(f"Error saving output image to {output_path}: {e}")

def main():
    parser = argparse.ArgumentParser(
        description="Edit an image or generate a video using xAI Grok Imagine API."
    )
    parser.add_argument(
        "--mode", choices=["img2img", "video"], default="img2img",
        help="Generation mode: img2img for editing images, video for image-to-video (default: img2img)."
    )
    parser.add_argument(
        "-i", "--image", required=True, nargs="+",
        help="Path to one or more input image files (up to 3 for img2img, exactly 1 for video)."
    )
    parser.add_argument(
        "-p", "--prompt", required=True,
        help="Description of the edits or video motion instructions."
    )
    parser.add_argument(
        "-o", "--output", default=None,
        help="Path to save the output file (default: output.png for img2img, output.mp4 for video)."
    )
    parser.add_argument(
        "--max-dim", type=int, default=1024,
        help="Maximum width/height of the pre-processed image (default: 1024)."
    )
    parser.add_argument(
        "--aspect-ratio", 
        choices=["1:1", "16:9", "3:2", "4:3", "9:16", "2:3", "3:4"],
        help="Target aspect ratio of the output (default: matches original image)."
    )
    parser.add_argument(
        "--model", default=None,
        help="The model to use (default: grok-imagine-image-quality for img2img, grok-imagine-video-1.5 for video)."
    )
    parser.add_argument(
        "--duration", type=int, default=5,
        help="Duration of the generated video in seconds (1-15, default: 5). Only for video mode."
    )
    parser.add_argument(
        "--resolution", choices=["480p", "720p", "1080p"], default="720p",
        help="Resolution of the generated video (default: 720p). Only for video mode."
    )
    parser.add_argument(
        "--api-key",
        help="Your xAI API Key (overrides XAI_API_KEY environment variable)."
    )

    args = parser.parse_args()

    # Determine API key
    api_key = args.api_key or os.getenv("XAI_API_KEY")
    if not api_key:
        print("[!] Error: xAI API Key not found.")
        print("Please set the XAI_API_KEY environment variable, create a .env file, or pass it via --api-key.")
        sys.exit(1)

    mode = args.mode

    # Resolve defaults
    model = args.model
    if not model:
        model = DEFAULT_VIDEO_MODEL if mode == "video" else DEFAULT_MODEL

    output_path = args.output
    if not output_path:
        output_path = "output.mp4" if mode == "video" else "output.png"

    try:
        # Validate number of images
        if mode == "video" and len(args.image) != 1:
            print("[!] Error: Image-to-Video mode expects exactly 1 input image.")
            sys.exit(1)
        elif len(args.image) > 3:
            print("[!] Error: You can provide at most 3 input images.")
            sys.exit(1)

        # 1. Preprocess and shrink local image(s) if needed
        base64_images = [load_and_preprocess_image(img_path, max_dim=args.max_dim) for img_path in args.image]
        image_input = base64_images[0] if len(base64_images) == 1 else base64_images
        
        if mode == "img2img":
            # 2. Query the API
            response_data = call_grok_img2img(
                api_key=api_key,
                prompt=args.prompt,
                image_input=image_input,
                model=model,
                aspect_ratio=args.aspect_ratio
            )
            
            # 3. Handle response and download image
            generated_data = response_data.get("data", [])
            if not generated_data:
                print("[!] API response did not contain image data.")
                print(f"Raw response: {response_data}")
                sys.exit(1)
                
            generated_url = generated_data[0].get("url")
            if not generated_url:
                print("[!] API response did not contain an image URL.")
                print(f"Raw response: {response_data}")
                sys.exit(1)
                
            revised_prompt = generated_data[0].get("revised_prompt")
            if revised_prompt:
                print(f"[*] Grok revised prompt: {revised_prompt}")
                
            img_bytes = download_image(generated_url)
            with open(output_path, 'wb') as f:
                f.write(img_bytes)
            print(f"[+] Successfully saved generated image to: {output_path}")
            
            # Save to history cache
            metadata = {
                "prompt": args.prompt,
                "model": model,
                "aspect_ratio": args.aspect_ratio,
                "max_dim": args.max_dim,
                "source_images": args.image,
                "revised_prompt": revised_prompt
            }
            save_to_history(img_bytes, metadata, mode="img2img")
            
        else: # mode == "video"
            # 2. Query the API to start generation
            request_id = call_grok_image_to_video(
                api_key=api_key,
                prompt=args.prompt,
                image_input=image_input,
                model=model,
                aspect_ratio=args.aspect_ratio,
                duration=args.duration,
                resolution=args.resolution
            )
            
            # 3. Poll for status and download video
            video_data = poll_video_status(api_key, request_id)
            video_url = video_data.get("video", {}).get("url")
            if not video_url:
                print("[!] API response did not contain a video URL.")
                sys.exit(1)
                
            video_bytes = download_image(video_url)
            with open(output_path, 'wb') as f:
                f.write(video_bytes)
            print(f"[+] Successfully saved generated video to: {output_path}")
            
            # Save to history cache
            metadata = {
                "prompt": args.prompt,
                "model": model,
                "aspect_ratio": args.aspect_ratio,
                "duration": args.duration,
                "resolution": args.resolution,
                "source_images": args.image,
                "video_request_id": request_id
            }
            save_to_history(video_bytes, metadata, mode="video")
        
    except Exception as e:
        print(f"[!] Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
