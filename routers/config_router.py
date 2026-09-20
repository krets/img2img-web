from fastapi import APIRouter, HTTPException

import comfyui_client
import config as cfg
import fal_client
import grok_client
from models import ConfigIn

router = APIRouter(prefix="/api/config", tags=["config"])


def _mask(key):
    return f"{'*' * max(len(key) - 4, 0)}{key[-4:]}" if key else ""


def _masked(config):
    xai_key = config.get("xai_api_key", "")
    fal_key = config.get("fal_api_key", "")
    xai_management_key = config.get("xai_management_key", "")
    return {
        **config,
        "xai_api_key": _mask(xai_key),
        "has_api_key": bool(xai_key),
        "fal_api_key": _mask(fal_key),
        "has_fal_api_key": bool(fal_key),
        "xai_management_key": _mask(xai_management_key),
        "has_xai_management_key": bool(xai_management_key),
    }


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
    if body.fal_api_key is not None and body.fal_api_key != "":
        config["fal_api_key"] = body.fal_api_key
    if body.fal_model is not None:
        config["fal_model"] = body.fal_model
    if body.xai_management_key is not None and body.xai_management_key != "":
        config["xai_management_key"] = body.xai_management_key
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


@router.post("/comfyui-free")
def comfyui_free():
    config = cfg.load_config()
    ok, message = comfyui_client.free_memory(config["comfyui_url"])
    return {"ok": ok, "message": message}


@router.post("/check-fal-connection")
def check_fal_connection():
    ok, message = fal_client.check_connection(cfg.get_fal_api_key())
    return {"ok": ok, "message": message}


@router.get("/balances")
def get_balances():
    fal_ok, fal_message, fal_balance = fal_client.get_balance(cfg.get_fal_api_key())
    grok_ok, grok_message, grok_balance = grok_client.get_balance(
        cfg.get_api_key(), cfg.get_xai_management_key()
    )
    return {
        "fal": {"ok": fal_ok, "message": fal_message, "balance": fal_balance},
        "grok": {"ok": grok_ok, "message": grok_message, "balance": grok_balance},
    }


@router.get("/fal-models")
def get_fal_models():
    try:
        models = fal_client.list_edit_models(cfg.get_fal_api_key())
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e
    return {"models": models}
