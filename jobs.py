"""In-memory registry of background generation jobs.

Powers the queue overlay and per-image progress chits in the UI. Nothing
here is persisted — the database only gains a `results` row once a job
finishes successfully. Finished jobs (done/error) are kept around briefly
so polling clients see the terminal state before they're purged.

A separate ring buffer (`_log`) keeps the last LOG_MAXLEN finished jobs
(done or error) around for as long as the server process runs, so a failure
you weren't watching for live is still readable later -- it just won't
survive a restart.
"""

import threading
import time
import uuid
from collections import deque

FINISHED_GRACE_SECONDS = 10
LOG_MAXLEN = 1000

_lock = threading.Lock()
_jobs = {}
_log = deque(maxlen=LOG_MAXLEN)


class GenerationCancelled(Exception):
    """Raised inside a generation thread once it observes its job's
    cancel_requested flag, so the caller can record a distinct 'cancelled'
    terminal state instead of treating it as a generic failure."""


def create_job(image_id, project_id, image_name, engine, prompt_text=""):
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "image_id": image_id,
        "project_id": project_id,
        "image_name": image_name,
        "engine": engine,
        "prompt_text": prompt_text,
        "status": "queued",  # queued -> running -> done | error | cancelled
        "phase": None,  # engine-specific sub-stage, e.g. comfyui's uploading/running/saving
        "value": 0,
        "max": 0,
        "result_id": None,
        "error": None,
        "created_at": time.time(),
        "finished_at": None,
        "cancel_requested": False,
        "prompt_id": None,  # engine-native id (e.g. ComfyUI's prompt_id), set once known
    }
    with _lock:
        _jobs[job_id] = job
    return dict(job)


def update_job(job_id, **fields):
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job.update(fields)


def get_job(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def request_cancel(job_id):
    """Flags a still-active job for cooperative cancellation. Returns the job
    dict if it existed and was active, else None. The actual state
    transition to 'cancelled' happens in the generation thread once it
    observes the flag (see is_cancelled/cancel_job)."""
    with _lock:
        job = _jobs.get(job_id)
        if job and job["status"] in ("queued", "running"):
            job["cancel_requested"] = True
            return dict(job)
        return None


def is_cancelled(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return bool(job and job["cancel_requested"])


def cancel_job(job_id):
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
            _log.append(dict(job))


def finish_job(job_id, result_id=None, error=None):
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job["status"] = "error" if error else "done"
            job["result_id"] = result_id
            job["error"] = error
            job["finished_at"] = time.time()
            _log.append(dict(job))


def list_log():
    """Finished jobs (done/error), newest first."""
    with _lock:
        return list(reversed(_log))


def list_jobs():
    """All active jobs plus any finished ones still within the grace window.
    Purges older finished jobs as a side effect.
    """
    now = time.time()
    with _lock:
        stale = [
            job_id for job_id, job in _jobs.items()
            if job["finished_at"] is not None and now - job["finished_at"] > FINISHED_GRACE_SECONDS
        ]
        for job_id in stale:
            del _jobs[job_id]
        return [dict(job) for job in _jobs.values()]
