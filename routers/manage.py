"""Cross-library management endpoints (see manage_db.py for the queries)."""

from fastapi import APIRouter, Query

import hash_worker
import manage_db
from models import ManageFilterIn

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
