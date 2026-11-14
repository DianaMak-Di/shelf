"""sync(): a failed step is reported (later steps still run) and lands in state["error"]; n/total track progress. No real shelf.py steps run."""
import subprocess, tempfile
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
print("ok")
