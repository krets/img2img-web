"""Cross-library management endpoints (see manage_db.py for the queries)."""

from fastapi import APIRouter, Query

import dupes
import hash_worker
import manage_db
from models import DuplicatesIn, ManageFilterIn

router = APIRouter(prefix="/api/manage", tags=["manage"])


@router.get("/index/status")
def get_index_status():
    """Progress of the background hash backfill: rows still missing hashes, per kind."""
    return hash_worker.status()


@router.get("/summary")
def get_summary(include_archived: bool = False):
    return manage_db.index_summary(include_archived=include_archived)


@router.post("/results")
def list_results(f: ManageFilterIn, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    """One page of live results across projects matching the filter. Image URLs
    are built client-side from the result id (/api/results/{id}/thumbnail etc.).
    """
    return manage_db.list_filtered_results(f, offset=offset, limit=limit)


@router.post("/prompts")
def prompt_report(f: ManageFilterIn):
    """Results matching the filter grouped by prompt (f.prompt_hashes is ignored)."""
    return manage_db.prompt_report(f)


@router.post("/prompts/{prompt_hash}/revised")
def revised_prompts(prompt_hash: str, f: ManageFilterIn):
    """Distinct engine-revised versions of one prompt, with counts, within the filter."""
    return manage_db.revised_prompts(prompt_hash, f)


@router.post("/duplicates")
def find_duplicates(body: DuplicatesIn):
    """Clusters of near-duplicate sources/references across the selected projects."""
    return dupes.find_duplicates(
        project_ids=body.project_ids,
        include_archived=body.include_archived,
        kinds=body.kinds,
        threshold=body.threshold,
        dhash_threshold=body.dhash_threshold,
        exclude_lineage=body.exclude_lineage,
        include_resolved=body.include_resolved,
    )
