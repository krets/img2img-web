"""Pydantic request/response schemas for the API."""

from typing import Literal, Optional

from pydantic import BaseModel


class ProjectIn(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectUpdateIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ImageUpdateIn(BaseModel):
    display_name: Optional[str] = None
    comment: Optional[str] = None


class ImageFromUrlIn(BaseModel):
    url: str


class ReferenceImageUpdateIn(BaseModel):
    display_name: Optional[str] = None


class ReferenceImageCropIn(BaseModel):
    crop_x: int
    crop_y: int
    crop_w: int
    crop_h: int


class MoveImagesIn(BaseModel):
    image_ids: list[str]
    target_project_id: str


class CopyImagesIn(BaseModel):
    image_ids: list[str]
    target_project_id: str


class MergeImagesIn(BaseModel):
    keep_id: str
    remove_ids: list[str]


class PromptIn(BaseModel):
    title: str
    prompt_text: str


class PromptUpdateIn(BaseModel):
    title: Optional[str] = None
    prompt_text: Optional[str] = None


class GenerateRequestIn(BaseModel):
    prompt_id: Optional[str] = None
    adhoc_prompt_text: str
    engine: Optional[Literal["grok", "comfyui", "fal"]] = None
    model: Optional[str] = None
    aspect_ratio: Optional[str] = None
    max_dim: Optional[int] = None
    # Ids into this project's reference-image library (see routers/references.py),
    # passed as extra reference inputs. Supported by all engines, though not
    # every fal.ai model accepts more than one input image.
    reference_image_ids: Optional[list[str]] = None


class EvaluationIn(BaseModel):
    evaluation: Literal["YES", "NO", "MAYBE", "UNRATED"]


class ConfigIn(BaseModel):
    xai_api_key: Optional[str] = None
    default_model: Optional[str] = None
    default_max_dim: Optional[int] = None
    default_engine: Optional[Literal["grok", "comfyui", "fal"]] = None
    comfyui_url: Optional[str] = None
    comfyui_workflow_path: Optional[str] = None
    fal_api_key: Optional[str] = None
    fal_model: Optional[str] = None


class ExportRequestIn(BaseModel):
    status_filter: Literal["YES", "NO", "MAYBE", "UNRATED", "ALL"] = "YES"
    mode: Literal["clean", "side_by_side"] = "clean"
