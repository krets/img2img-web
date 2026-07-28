"""Workspace path resolution and config.json (API key + defaults) handling."""

import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

APP_ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = APP_ROOT / "workspace"
SOURCE_IMAGES_DIR = WORKSPACE_ROOT / "source_images"
RESULT_IMAGES_DIR = WORKSPACE_ROOT / "result_images"
EXPORTS_DIR = WORKSPACE_ROOT / "exports"
DB_PATH = WORKSPACE_ROOT / "library.db"
CONFIG_PATH = WORKSPACE_ROOT / "config.json"


def set_db_path(path):
    """Points the app at a different SQLite file, relocating image storage
    (source/result images, exports, config.json) alongside it. Used to run
    against an isolated test workspace instead of the live one.
    """
    global DB_PATH, WORKSPACE_ROOT, SOURCE_IMAGES_DIR, RESULT_IMAGES_DIR, EXPORTS_DIR, CONFIG_PATH
    DB_PATH = Path(path).resolve()
    WORKSPACE_ROOT = DB_PATH.parent
    SOURCE_IMAGES_DIR = WORKSPACE_ROOT / "source_images"
    RESULT_IMAGES_DIR = WORKSPACE_ROOT / "result_images"
    EXPORTS_DIR = WORKSPACE_ROOT / "exports"
    CONFIG_PATH = WORKSPACE_ROOT / "config.json"

DEFAULT_CONFIG = {
    "xai_api_key": "",
    "default_model": "grok-imagine-image-quality",
    "default_max_dim": 1024,
    "default_engine": "grok",
    "comfyui_url": "http://127.0.0.1:8188",
    "comfyui_workflow_path": "comfyui_flux2_imageedit.json",
}


def ensure_workspace():
    """Creates the workspace folder structure and a default config.json if missing."""
    for d in (WORKSPACE_ROOT, SOURCE_IMAGES_DIR, RESULT_IMAGES_DIR, EXPORTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)


def load_config():
    ensure_workspace()
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        data = {}
    merged = {**DEFAULT_CONFIG, **data}
    return merged


def save_config(config: dict):
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def get_api_key():
    config = load_config()
    if config.get("xai_api_key"):
        return config["xai_api_key"]
    return os.getenv("XAI_API_KEY", "")


def comfyui_workflow_path(config=None):
    config = config or load_config()
    path = Path(config["comfyui_workflow_path"])
    return path if path.is_absolute() else APP_ROOT / path


def project_source_dir(project_id):
    d = SOURCE_IMAGES_DIR / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_result_dir(project_id):
    d = RESULT_IMAGES_DIR / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d
