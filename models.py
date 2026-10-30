"""Pydantic request/response schemas for the API."""

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


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
    mode: Literal["blur", "color", "extend", "edge_color"] = "blur"
    color: str = "#000000"


class PreprocessIn(BaseModel):
    """Crop coordinates are in the rotated image's pixel space and may extend
    past its edges (the overhang gets padded) -- see preprocess.py. rotation
    is any angle, not just a multiple of 90 -- see preprocess.normalize for
    the actual range/precision clamp applied on top of this.
    """
    rotation: float = 0
    crop: Optional[PreprocessCropIn] = None  # None = the whole (rotated) image
    fill: PreprocessFillIn = PreprocessFillIn()


class ReferenceImageUpdateIn(BaseModel):
    display_name: Optional[str] = None


class Sam3CutoutBatchIn(BaseModel):
    sam3_prompts: list[str]

    @field_validator("sam3_prompts")
    @classmethod
    def _validate_prompts(cls, value):
        cleaned = [p.strip() for p in value if p.strip()]
        if not cleaned:
            raise ValueError("At least one SAM3 prompt is required")
        return cleaned


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
    # ComfyUI only -- picks which bundled workflow graph to run. "sam3" and
    # "sam3_xy" both run an upstream SAM3 detect/rescale pass and require
    # sam3_prompt; "sam3" scales the detected object uniformly (scale_by),
    # "sam3_xy" scales its width/height independently (scale_x/scale_y).
    # All numeric fields are optional and fall back to the workflow's own
    # defaults.
    comfyui_workflow: Optional[Literal["default", "sam3", "sam3_xy"]] = None
    sam3_prompt: Optional[str] = None
    sam3_scale_by: Optional[float] = None
    sam3_scale_x: Optional[float] = None
    sam3_scale_y: Optional[float] = None
    sam3_lr_pin: Optional[float] = None
    sam3_tb_pin: Optional[float] = None
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
    comfyui_sam3_workflow_path: Optional[str] = None
    comfyui_sam3xy_workflow_path: Optional[str] = None
    comfyui_sam3_cutout_workflow_path: Optional[str] = None
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


class TrashResultsIn(BaseModel):
    """Results to trash: those matching filter, or just ids when given."""
    filter: ManageFilterIn
    ids: Optional[list[str]] = None


class StorageScopeIn(BaseModel):
    """Libraries a storage request covers (empty: every live one)."""
    project_ids: list[str] = []
    include_archived: bool = False


class DownscaleIn(StorageScopeIn):
    """Shrink source images whose long edge exceeds max_dim, in place. Running
    one takes an explicit image_ids list; previews leave it out."""
    max_dim: int = Field(ge=256, le=16000)
    image_ids: Optional[list[str]] = None


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


class ExportOptions(BaseModel):
    """What goes into a cross-library export zip (see export.py)."""
    images: bool = True             # result PNGs
    side_by_side: bool = False      # source | result composites
    include_sources: bool = False   # the engine's input (processed if cropped)
    include_originals: bool = False # plus the untouched source when it was processed
    include_references: bool = False
    sidecar: bool = True            # manifest.json + manifest.csv
    html_report: bool = False       # self-contained report.html
    group_by: Literal["prompt", "project"] = "prompt"

    @model_validator(mode="after")
    def _something_to_export(self):
        if not (self.images or self.side_by_side or self.include_sources or self.include_references
                or self.sidecar or self.html_report):
            raise ValueError("Pick at least one thing to export")
        return self


class ManageExportIn(BaseModel):
    """Export the current filter, or a saved report's (exactly one of them)."""
    filter: Optional[ManageFilterIn] = None
    report_id: Optional[str] = None
    name: Optional[str] = Field(None, max_length=120)
    options: ExportOptions = ExportOptions()

    @model_validator(mode="after")
    def _one_source(self):
        if (self.filter is None) == (self.report_id is None):
            raise ValueError("Give either filter or report_id")
        return self


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
