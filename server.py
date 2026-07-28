"""FastAPI entrypoint for the Image-to-Image Library Manager.

Run with `python server.py` — starts uvicorn. Set OPEN_BROWSER=1 to also open
the app in your default browser on startup (off by default so restarts during
development don't keep popping new windows/tabs).

Use --port to run on a different port and --db to point at a different SQLite
file (this also relocates image storage alongside that file) -- handy for
running a second, isolated instance against test data without touching the
live workspace.
"""

import argparse
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


def _open_browser(port):
    webbrowser.open(f"http://{HOST}:{port}")


def parse_args():
    parser = argparse.ArgumentParser(description="Image-to-Image Library Manager server")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", 8765)),
                         help="Port to listen on (default: 8765, or $PORT)")
    parser.add_argument("--db", type=str, default=os.getenv("DB_PATH"),
                         help="Path to a SQLite database file to use instead of the default "
                              "workspace/library.db. Image storage and config.json are relocated "
                              "alongside it, so this fully isolates the run from live data.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.db:
        cfg.set_db_path(args.db)
    if os.getenv("OPEN_BROWSER") == "1":
        threading.Timer(1.0, lambda: _open_browser(args.port)).start()
    uvicorn.run(app, host=HOST, port=args.port)
