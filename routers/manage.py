"""Cross-library management endpoints (see manage_db.py for the queries)."""

from fastapi import APIRouter

import hash_worker
import manage_db

router = APIRouter(prefix="/api/manage", tags=["manage"])


@router.get("/index/status")
def get_index_status():
    """Progress of the background hash backfill: rows still missing hashes, per kind."""
    return hash_worker.status()


@router.get("/summary")
def get_summary(include_archived: bool = False):
    return manage_db.index_summary(include_archived=include_archived)
