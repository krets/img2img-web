"""In-memory registry of background generation jobs.

Powers the queue overlay and per-image progress chits in the UI. Nothing
here is persisted — the database only gains a `results` row once a job
finishes successfully. Finished jobs (done/error) are kept around briefly
so polling clients see the terminal state before they're purged.
"""

import threading
import time
import uuid

FINISHED_GRACE_SECONDS = 10

_lock = threading.Lock()
_jobs = {}


def create_job(image_id, project_id, image_name, engine, prompt_text=""):
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "image_id": image_id,
        "project_id": project_id,
        "image_name": image_name,
        "engine": engine,
        "prompt_text": prompt_text,
        "status": "queued",  # queued -> running -> done | error
        "phase": None,  # engine-specific sub-stage, e.g. comfyui's uploading/running/saving
        "value": 0,
        "max": 0,
        "result_id": None,
        "error": None,
        "created_at": time.time(),
        "finished_at": None,
    }
    with _lock:
        _jobs[job_id] = job
    return dict(job)


def update_job(job_id, **fields):
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job.update(fields)


def finish_job(job_id, result_id=None, error=None):
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job["status"] = "error" if error else "done"
            job["result_id"] = result_id
            job["error"] = error
            job["finished_at"] = time.time()


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
