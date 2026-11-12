"""Local server for the reels UI:  python server.py  ->  http://localhost:8765
GET /api/reels, GET /api/lang (language + UI texts), GET /api/sync (status), POST /api/sync {"urls":[...]} (add links + process everything new).
Onboarding: GET /api/sources, POST /api/telegram/<code|sign_in|password|logout>, POST /api/tiktok (export file), POST /api/later {"item"}.
POSTs need the header X-Reels: 1. Any request needs Host localhost:<port> or 127.0.0.1:<port> (DNS rebinding)."""
import json, subprocess, urllib.parse, threading, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import reels

ROOT = Path(__file__).parent
PY = str(ROOT / ".venv/bin/python")
state = {"running": False, "step": "", "log": "", "error": ""}
lock = threading.Lock()
S = reels.S
STEPS = list(zip(S["steps"], [["saved"], ["fetch", "urls.txt"], ["frames"], ["enrich"], ["geocode"], ["keys"], ["tagmap"]]))


def sync(urls):
    try:
        uf = ROOT / "urls.txt"
        known = uf.read_text().split() if uf.exists() else []
        add = [u.split("?")[0] for u in urls if u.split("?")[0] not in known]
        if add or not uf.exists():
            uf.write_text("\n".join(known + add) + "\n")
        for name, args in STEPS:
            state["step"] = name
            r = subprocess.run([PY, "reels.py", *args], cwd=ROOT, capture_output=True, text=True)
            state["log"] = (r.stdout + r.stderr)[-600:]
        state["step"] = S["done"]
    except Exception as e:  # noqa: BLE001
        state["error"] = str(e)
    finally:
        state["running"] = False


class H(BaseHTTPRequestHandler):
    def send(self, body, ctype="application/json", code=200):
        body = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def allowed(self, post=False):
        # DNS rebinding: a page on evil.com rebound to 127.0.0.1 still sends Host: evil.com (and Origin on POST)
        hosts = {f"localhost:{self.server.server_address[1]}", f"127.0.0.1:{self.server.server_address[1]}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in hosts and not (post and origin and origin not in {f"http://{h}" for h in hosts})

    def do_GET(self):
        if not self.allowed():
            return self.send({"error": "forbidden"}, code=403)
        path = self.path.split("?")[0]
        if path == "/api/reels":
            return self.send(reels.export_items())
        if path == "/api/lang":
            return self.send({"language": reels.llm.config()["language"], "ui": S["ui"], "kind_order": S["kind_order"],
                              "hidden_kinds": S["hidden_kinds"]})
        if path == "/api/sync":
            return self.send(state)
        if path == "/api/sources":
            return self.send(reels.sources_status())
        if path == "/api/search":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("q", [""])[0].strip()
            return self.send(reels.search(q) if q else [])
        base, rel = (reels.T, path[8:]) if path.startswith("/thumbs/") else (ROOT / "ui/dist", path.lstrip("/") or "index.html")
        f = (base / rel).resolve()
        if base.resolve() not in f.parents or not f.is_file():
            return self.send({"error": "not found"}, code=404)
        self.send(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")

    def do_POST(self):
        # custom header = browsers send a CORS preflight first, which this server never answers: other sites open in
        # the browser cannot post here (log in to Telegram, start syncs)
        if self.headers.get("X-Reels") != "1" or not self.allowed(post=True):
            return self.send({"error": "forbidden"}, code=403)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/api/tiktok":
            try:
                return self.send({"count": reels.tiktok_import(raw)})
            except (ValueError, OSError) as e:
                return self.send({"error": str(e)}, code=400)
        body = json.loads(raw or b"{}")
        if self.path.startswith("/api/telegram/"):
            r = reels.tg_web(self.path.rsplit("/", 1)[1], **body)
            return self.send(r, code=400 if "error" in r else 200)
        if self.path == "/api/later":
            later = sorted(set(reels._cfg().get("later", [])) | {body.get("item")} - {None})
            reels._save_cfg(later=later)
            return self.send(reels.sources_status())
        if self.path != "/api/sync":
            return self.send({"error": "not found"}, code=404)
        with lock:
            if state["running"]:
                return self.send(state, code=409)
            state.update(running=True, step=S["start"], log="", error="")
        threading.Thread(target=sync, args=(body.get("urls", []),), daemon=True).start()
        self.send(state)


if __name__ == "__main__":
    threading.Thread(target=lambda: reels.search("warmup"), daemon=True).start()  # load model + index before first query
    print("http://localhost:8765")
    ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
