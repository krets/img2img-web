"""Run a flux3_edit_*ref.json workflow against a ComfyUI server.

python run_workflow.py primary.png support1.png --prompt "..." --steps 4 --seed 1
Local image paths are uploaded to the server's input folder. Results are
saved to --out and the wall time is printed.
"""
import argparse
import json
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).parent


def upload(server, path):
    boundary = uuid.uuid4().hex
    data = Path(path).read_bytes()
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{Path(path).name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + data
    body += (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n').encode()
    req = urllib.request.Request(f"{server}/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req))["name"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+", help="1-4 reference images; the first is the primary")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--mp", type=float, nargs="+", help="megapixels per reference (default 1.0 0.7 0.5 0.5); the first also sets the output size")
    ap.add_argument("--vl", action="store_true", help="also feed the references into the Qwen3-VL text encoder itself (custom_nodes/flux3_vl_edit) -- experimental")
    ap.add_argument("--server", default="http://127.0.0.1:8188")
    ap.add_argument("--out", default=str(HERE / "results"))
    args = ap.parse_args()

    n = len(args.images)
    wf = json.loads((HERE / f"flux3_edit_{'vl_' if args.vl else ''}{n}ref.json").read_text())
    wf["prompt"]["inputs"]["text"] = args.prompt
    wf["noise"]["inputs"]["noise_seed"] = args.seed
    wf["scheduler"]["inputs"]["steps"] = args.steps
    for i, img in enumerate(args.images, 1):
        wf[f"load_{i}"]["inputs"]["image"] = upload(args.server, img) if Path(img).exists() else img
        if args.mp:
            wf[f"scale_{i}"]["inputs"]["megapixels"] = args.mp[i - 1]

    t = time.time()
    req = urllib.request.Request(f"{args.server}/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req))["prompt_id"]
    while True:
        hist = json.load(urllib.request.urlopen(f"{args.server}/history/{pid}"))
        if pid in hist:
            break
        time.sleep(0.5)
    elapsed = time.time() - t
    entry = hist[pid]
    if entry["status"]["status_str"] != "success":
        raise SystemExit(json.dumps(entry["status"]["messages"][-1], indent=1))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    for im in entry["outputs"]["save"]["images"]:
        q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
        dest = Path(args.out) / im["filename"]
        dest.write_bytes(urllib.request.urlopen(f"{args.server}/view?{q}").read())
        print(f"{elapsed:.1f}s  {dest}")


if __name__ == "__main__":
    main()
