"""Cross-library management endpoints (see manage_db.py for the queries)."""

from fastapi import APIRouter

import manage_db

router = APIRouter(prefix="/api/manage", tags=["manage"])


@router.get("/summary")
def get_summary(include_archived: bool = False):
    return manage_db.index_summary(include_archived=include_archived)
