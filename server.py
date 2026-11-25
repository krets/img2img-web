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
from fastapi import FastAPI, Request

import config as cfg
import db
import hash_worker
import http_cache
import pruning
import storage
from routers import config_router, export, images, manage, projects, prompts, references, results

HOST = "0.0.0.0"

app = FastAPI(title="Image-to-Image Library Manager")

app.include_router(projects.router)
app.include_router(images.router)
app.include_router(references.router)
app.include_router(prompts.router)
app.include_router(results.router)
app.include_router(export.router)
app.include_router(manage.router)
app.include_router(config_router.router)


@app.on_event("startup")
def startup():
    cfg.ensure_workspace()
    db.init_db(cfg.DB_PATH)
    storage.backfill_result_source_preprocess()
    db.backfill_prompt_hashes()
    hash_worker.start_background_hasher()
    pruning.start_background_pruner()


assets = http_cache.AssetVersioner("static")


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index_page(request: Request):
    return assets.page_response(request, "index.html")


@app.get("/manage", include_in_schema=False)
@app.get("/manage.html", include_in_schema=False)
def manage_page(request: Request):
    """The cross-library management page."""
    return assets.page_response(request, "manage.html")


app.mount("/", http_cache.VersionedStaticFiles(assets, directory="static"), name="static")
app.add_middleware(http_cache.SelectiveGZipMiddleware)


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
    # Without a timeout, uvicorn's graceful shutdown waits indefinitely for
    # existing connections to go idle -- a browser tab left open polling
    # /api/queue every 1.2s (see pollQueue in app.js) keeps its connection
    # perpetually "active", so Ctrl-C would hang at "Shutting down" forever
    # instead of just force-closing it after a short grace period.
    # use_colors=False: Windows PowerShell's console host doesn't reliably
    # render uvicorn's ANSI color codes, showing literal escape-code garbage
    # instead of colored log lines.
    uvicorn.run(app, host=HOST, port=args.port, timeout_graceful_shutdown=3, use_colors=False)
