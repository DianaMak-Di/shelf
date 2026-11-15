"""sync(): a failed step is reported (later steps still run) and lands in state["error"]; n/total track progress. No real shelf.py steps run.
Host/token checks (--lan) run against a real server on 127.0.0.1:8798; the "remote" client address is faked via X-Test-Remote."""
import contextlib, http.client, io, subprocess, tempfile, threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
import server

server.ROOT = Path(tempfile.mkdtemp())  # urls.txt of the real project stays untouched
server.STEPS = [("one", ["a"]), ("two", ["b"]), ("three", ["c"])]
calls = []


def fake(code_at):
    def run(cmd, **kw):
        calls.append(cmd[-1])
        return SimpleNamespace(returncode=1 if cmd[-1] == code_at else 0, stdout="", stderr="boom")
    return run


server.subprocess.run = fake("b")
server.state.update(running=True, error="", n=0)
server.sync([])
assert calls == ["a", "b", "c"], calls  # later steps still run
assert not server.state["running"] and server.state["n"] == 2
assert server.state["step"] == "two" and "boom" in server.state["error"]

calls.clear(); server.subprocess.run = fake(None)
server.state.update(running=True, error="", n=0)
server.sync([])
assert calls == ["a", "b", "c"] and server.state["n"] == 3 and not server.state["error"]
assert server.state["step"] == server.S["done"]

stub = server.H.__new__(server.H); stub.token, stub.client_address = "SECRET", ("1.2.3.4", 1)  # handler without a socket
buf = io.StringIO()
with contextlib.redirect_stderr(buf):  # the token never reaches the log
    stub.log_message('"%s" %s', "GET /?k=SECRET HTTP/1.1", "302")
assert "SECRET" not in buf.getvalue() and "***" in buf.getvalue(), buf.getvalue()
server.H.log_message = lambda *a: None  # no request log noise
PORT, TOK = 8798, "tok-123"


def ask(method, path, host=f"127.0.0.1:{PORT}", **headers):
    c = http.client.HTTPConnection("127.0.0.1", PORT)
    c.request(method, path, body=b"{}" if method == "POST" else None, headers={"Host": host, **headers})
    r = c.getresponse(); r.read(); c.close()
    return r


class Lan(server.H):
    token, lan_hosts = TOK, {f"192.168.1.50:{PORT}"}
    def remote(self): return self.headers.get("X-Test-Remote", "127.0.0.1")


def serving(cls):
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# default (no --lan): as before
httpd = serving(server.H)
assert ask("GET", "/api/sync").status == 200
assert ask("GET", "/api/sync", host=f"localhost:{PORT}").status == 200
assert ask("GET", "/api/sync", host="evil.com").status == 403
assert ask("GET", "/api/sync", host=f"192.168.1.50:{PORT}").status == 403  # LAN host is not allowed without the flag
assert ask("GET", "/api/sync", **{"X-Test-Remote": "192.168.1.9"}).status == 200  # handler has no remote hook: header ignored
assert ask("POST", "/api/nope").status == 403  # no X-Shelf
assert ask("POST", "/api/nope", **{"X-Shelf": "1"}).status == 404  # passed the checks
assert ask("POST", "/api/nope", **{"X-Shelf": "1", "Origin": "http://evil.com"}).status == 403
httpd.shutdown(); httpd.server_close()

# --lan
httpd = serving(Lan)
lan, h = {"X-Test-Remote": "192.168.1.50"}, f"192.168.1.50:{PORT}"
assert ask("GET", "/api/sync").status == 200  # loopback needs no token
assert ask("POST", "/api/nope", **{"X-Shelf": "1"}).status == 404
assert ask("GET", "/api/sync", host=h, **lan).status == 403  # no token
assert ask("GET", "/api/sync?k=wrong", host=h, **lan).status == 403
assert ask("GET", "/api/sync", host=h, **{"X-Test-Remote": "192.168.1.50", "Cookie": "shelf_k=wrong"}).status == 403
assert ask("GET", "/api/sync", host=h, **{"X-Test-Remote": "192.168.1.50", "Cookie": "shelf_k=\u00e9"}).status == 403  # non-ASCII: no crash
assert ask("GET", "/", host=h, **lan).status == 403  # static files too
r = ask("GET", f"/api/sync?x=1&k={TOK}", host=h, **lan)  # right key: cookie + redirect to a fixed "/"
assert r.status == 302 and r.getheader("Location") == "/", r.getheader("Location")
assert ask("GET", f"/\\evil.com?k={TOK}", host=h, **lan).getheader("Location") == "/"  # no open redirect
ck = r.getheader("Set-Cookie")
assert ck == f"shelf_k={TOK}; Path=/; HttpOnly; SameSite=Strict", ck
cookie = {**lan, "Cookie": f"shelf_k={TOK}"}
assert ask("GET", "/api/sync", host=h, **cookie).status == 200
assert ask("GET", "/api/sync", host="evil.com", **cookie).status == 403  # foreign Host is refused even with the cookie
assert ask("GET", f"/?k={TOK}", host="evil.com", **lan).status == 403
assert ask("POST", "/api/nope", host=h, **{"X-Shelf": "1", **lan}).status == 403  # POST without cookie
assert ask("POST", "/api/nope", host=h, **{"X-Shelf": "1", **cookie}).status == 404  # with cookie: passes
assert ask("POST", "/api/nope", host=h, **{"X-Shelf": "1", "Origin": "http://evil.com", **cookie}).status == 403
assert ask("POST", "/api/nope", host=h, **{"X-Shelf": "1", "Origin": f"http://{h}", **cookie}).status == 404
httpd.shutdown(); httpd.server_close()
print("ok")
