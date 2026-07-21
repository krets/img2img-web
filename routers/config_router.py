from fastapi import APIRouter

import comfyui_client
import config as cfg
import grok_client
from models import ConfigIn

router = APIRouter(prefix="/api/config", tags=["config"])


def _masked(config):
    key = config.get("xai_api_key", "")
    masked = f"{'*' * max(len(key) - 4, 0)}{key[-4:]}" if key else ""
    return {**config, "xai_api_key": masked, "has_api_key": bool(key)}


@router.get("")
def get_config():
    return _masked(cfg.load_config())


@router.put("")
def update_config(body: ConfigIn):
    config = cfg.load_config()
    if body.xai_api_key is not None and body.xai_api_key != "":
        config["xai_api_key"] = body.xai_api_key
    if body.default_model is not None:
        config["default_model"] = body.default_model
    if body.default_max_dim is not None:
        config["default_max_dim"] = body.default_max_dim
    if body.default_engine is not None:
        config["default_engine"] = body.default_engine
    if body.comfyui_url is not None:
        config["comfyui_url"] = body.comfyui_url
    if body.comfyui_workflow_path is not None:
        config["comfyui_workflow_path"] = body.comfyui_workflow_path
    cfg.save_config(config)
    return _masked(config)


@router.post("/check-connection")
def check_connection():
    api_key = cfg.get_api_key()
    ok, message = grok_client.check_connection(api_key)
    return {"ok": ok, "message": message}


@router.post("/check-comfyui-connection")
def check_comfyui_connection():
    config = cfg.load_config()
    ok, message = comfyui_client.check_connection(config["comfyui_url"])
    return {"ok": ok, "message": message}
