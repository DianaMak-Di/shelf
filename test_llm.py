"""python test_llm.py - retry/escalation chain and config defaults (no network, no LLM)."""
import tempfile
from pathlib import Path

import llm

CFG = {**llm.DEFAULT_LLM, "strong": "S", "fast": "F"}


def run(role, answers, opener="{"):
    used = []

    def fn(prompt, model, cfg):
        used.append(model)
        a = answers[len(used) - 1]
        if isinstance(a, Exception):
            raise a
        return a
    return llm.ask_json("p", role, opener, CFG, fn, log=lambda s: None), used


def test():
    assert run("fast", ['ok {"a":1} ok'])[1] == ["F"]                                  # first try wins
    assert run("fast", ["junk", "junk", '{"a":1}']) == ({"a": 1}, ["F", "S", "S"])      # fast -> strong -> strong
    assert run("strong", ["x", RuntimeError("down"), '[1]'], "[") == ([1], ["S", "S", "S"])
    assert run("fast", ["x", "x", "x"]) == (None, ["F", "S", "S"])                      # all failed -> None, skip reel
    with tempfile.TemporaryDirectory() as d:                                            # no config.json -> defaults
        c = llm.config(Path(d) / "config.json")
        assert c["language"] == "ru" and c["llm"] == llm.DEFAULT_LLM
        (Path(d) / "config.json").write_text('{"language":"en","llm":{"provider":"openai"}}')
        c = llm.config(Path(d) / "config.json")
        assert c["language"] == "en" and c["llm"]["provider"] == "openai" and c["llm"]["strong"] == "sonnet"
    assert {"prompt", "ui"} <= set(llm.strings("ru")) == set(llm.strings("en"))        # languages stay in sync


def test_geocode():
    import json
    import shelf
    asked = []

    def find(q):
        asked.append(q)
        return {"Cafe, Lisbon": (38.7, -9.1), "Tower": (1.0, 2.0), "Rua A 1, Lisbon": (5.0, 6.0), "Porto, Portugal": (41.1, -8.6)}.get(q)
    with tempfile.TemporaryDirectory() as d:
        shelf.D = Path(d)
        (Path(d) / "a.json").write_text(json.dumps({"id": "a", "places": [
            {"name": "Cafe", "city": "Lisbon", "country": "Portugal"}, "Tower", {"name": "Nowhere"},
            {"name": "Shop", "city": "Lisbon", "country": "Portugal", "address": "Rua A 1, Lisbon"},
            {"name": "Bakery", "city": "Porto", "country": "Portugal"}]}))
        shelf.geocode(find=find, pause=0)
        ps = json.loads((Path(d) / "a.json").read_text())["places"]
        assert (ps[0]["lat"], ps[0]["lng"]) == (38.7, -9.1)                 # found by the 2nd query
        assert asked[:2] == ["Cafe, Lisbon, Portugal", "Cafe, Lisbon"]
        assert "Cafe" not in asked and ps[1]["lat"] == 1.0                  # bare name is asked only when nothing else is known
        assert ps[2]["geo"] == "none"                                       # no city, nothing found -> marked
        assert ps[3]["lat"] == 5.0 and "approx" not in ps[3]                # address first
        assert ps[4]["lat"] == 41.1 and ps[4]["approx"] is True             # city centre as the last resort
        n = len(asked)
        shelf.geocode(find=find, pause=0)
        assert len(asked) == n                                              # marked/found places are not asked again
        shelf.geocode(force=True, find=find, pause=0)
        assert len(asked) > n


def test_cities():
    import json
    import shelf
    real = shelf.llm.ask_json
    shelf.llm.ask_json = lambda *a, **kw: [{"city": "Валенсия", "country": "Испания"}] * 2
    try:
        with tempfile.TemporaryDirectory() as d:
            shelf.D = Path(d)
            (Path(d) / "a.json").write_text(json.dumps({"id": "a", "places": [
                {"name": "X", "city": "Valencia", "country": "Spain", "lat": 1.0, "lng": 2.0}, {"name": "Y", "city": "Валенсия", "country": ""}]}))
            shelf.cities()
            ps = json.loads((Path(d) / "a.json").read_text())["places"]
            assert {(q["city"], q["country"]) for q in ps} == {("Валенсия", "Испания")}   # one spelling
            assert ps[0]["lat"] == 1.0                                                   # coordinates survive
    finally:
        shelf.llm.ask_json = real


if __name__ == "__main__":
    test()
    test_geocode()
    test_cities()
    print("ok")
