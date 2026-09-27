"""Pydantic request/response schemas for the API."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class ProjectIn(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectUpdateIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ImageUpdateIn(BaseModel):
    display_name: Optional[str] = None
    comment: Optional[str] = None


class ImageParentIn(BaseModel):
    result_id: str


class ImageFromUrlIn(BaseModel):
    url: str


class PreprocessCropIn(BaseModel):
    x: int
    y: int
    w: int
    h: int


class PreprocessFillIn(BaseModel):
    mode: Literal["blur", "color"] = "blur"
    color: str = "#000000"


class PreprocessIn(BaseModel):
    """Crop coordinates are in the rotated image's pixel space and may extend
    past its edges (the overhang gets padded) -- see preprocess.py.
    """
    rotation: Literal[0, 90, 180, 270] = 0
    crop: Optional[PreprocessCropIn] = None  # None = the whole (rotated) image
    fill: PreprocessFillIn = PreprocessFillIn()


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
    # Grok only -- the other engines return an image shaped like their input,
    # so framing for them is done up front via the source's pre-process settings.
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
    xai_management_key: Optional[str] = None


class ManageFilterIn(BaseModel):
    """Filter for the cross-library management views (results, reports, export).
    An empty list means no constraint. Stored verbatim as reports.filter_json.
    """
    project_ids: list[str] = []
    # Only consulted when project_ids is empty: whether "all projects" takes in
    # archived ones. Explicitly listed projects are used whether archived or not.
    include_archived: bool = False
    # None stands for "no prompt text" (results whose prompt_hash is NULL).
    prompt_hashes: list[Optional[str]] = []
    evaluations: list[Literal["YES", "NO", "MAYBE", "UNRATED"]] = ["YES", "MAYBE", "NO", "UNRATED"]
    # The current export only takes the active result per image; review usually wants all.
    active_only: bool = False
    engines: list[str] = []
    # Inclusive UTC calendar days, "YYYY-MM-DD".
    date_from: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    date_to: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    # Collapse copies (same content_hash) into one row, keeping the earliest.
    dedupe_copies: bool = True
    sort: Literal["date_desc", "date_asc", "project", "evaluation"] = "date_desc"


class DuplicatesIn(BaseModel):
    """Near-duplicate search over sources and references (dupes.find_duplicates)."""
    project_ids: list[str] = []
    include_archived: bool = False
    kinds: list[Literal["source", "reference"]] = ["source", "reference"]
    # Max phash bit distance (of 64). Unrelated photos start around 16, where
    # clusters begin to chain, so the range stops there.
    threshold: int = Field(8, ge=0, le=16)
    # Optional second test on dhash to cut false positives at high thresholds.
    dhash_threshold: Optional[int] = Field(None, ge=0, le=32)
    # Don't pair a source with the image it was promoted from.
    exclude_lineage: bool = True
    include_resolved: bool = False


class ReportIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    filter: ManageFilterIn
    # View options the report reopens with (gallery mode, tile size, prompt
    # label, ...); opaque to the server.
    display: dict = {}


class ReportUpdateIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    filter: Optional[ManageFilterIn] = None
    display: Optional[dict] = None


class DupDecisionItem(BaseModel):
    kind: Literal["source", "reference"]
    id: str
    role: Optional[Literal["canonical", "ignore"]]  # None clears the decision


class DupDecisionsIn(BaseModel):
    items: list[DupDecisionItem]
    cluster_anchor_id: Optional[str] = None


class MergeReferencesIn(BaseModel):
    keep_id: str
    remove_ids: list[str]


class ExportRequestIn(BaseModel):
    status_filter: Literal["YES", "NO", "MAYBE", "UNRATED", "ALL"] = "YES"
    mode: Literal["clean", "side_by_side"] = "clean"
