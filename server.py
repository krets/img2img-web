"""FastAPI entrypoint for the Image-to-Image Library Manager.

Run with `python server.py` — starts uvicorn. Set OPEN_BROWSER=1 to also open
the app in your default browser on startup (off by default so restarts during
development don't keep popping new windows/tabs).
"""

import os
import threading
import webbrowser

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

import config as cfg
import db
import pruning
import storage
from routers import config_router, export, images, projects, prompts, results

HOST = "0.0.0.0"
PORT = 8765

app = FastAPI(title="Image-to-Image Library Manager")

app.include_router(projects.router)
app.include_router(images.router)
app.include_router(prompts.router)
app.include_router(results.router)
app.include_router(export.router)
app.include_router(config_router.router)


@app.on_event("startup")
def startup():
    cfg.ensure_workspace()
    db.init_db(cfg.DB_PATH)
    storage.backfill_missing_content_hashes()
    pruning.start_background_pruner()


app.mount("/", StaticFiles(directory="static", html=True), name="static")


def _open_browser():
    webbrowser.open(f"http://{HOST}:{PORT}")


if __name__ == "__main__":
    if os.getenv("OPEN_BROWSER") == "1":
        threading.Timer(1.0, _open_browser).start()
    uvicorn.run(app, host=HOST, port=PORT)
