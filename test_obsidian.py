"""Self-check for the Obsidian export on a synthetic reel in a temp folder:  python test_obsidian.py"""
import json, re, tempfile
from pathlib import Path
import reels
from reels import obsidian, _fm_split, _items, _safe, _tag

x = {"id": "DQ-abc_1", "source": "instagram", "url": "https://instagram.com/p/DQ-abc_1/", "author": 'Ann "A": b',
     "title": 'Паста: рецепт / "быстро" #1?', "summary": "Паста за 10 минут: 200 г, %% и #хэштег", "upload_date": "20251109",
     "caption": "Смотри #pasta", "transcript": "Привет\nмир", "ocr": "a | b", "tags": ["рецепты", "3d", "2025", "two words"],
     "collections": ["Еда"], "key": [{"kind": "рецепт", "text": "макароны, соль"}], "thumbs": ["thumbs/DQ-abc_1_0.jpg"],
     "places": [{"name": "Trattoria", "city": "Valencia", "country": "Spain", "lat": 39.47, "lng": -0.37},
                {"name": "Без города", "city": "", "country": ""}]}

assert _safe('a/b:c*"d"#e') == "a b c d e" and _safe("...", "id") == "id"
assert [_tag(t) for t in ("two words", "2025", "рецепты", "#ai")] == ["two_words", "t2025", "рецепты", "ai"]

with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    (d / "thumbs").mkdir(); (d / "thumbs" / "DQ-abc_1_0.jpg").write_bytes(b"jpg1")
    reels.T = d / "thumbs"
    V = d / "vault"
    obsidian(V, items=[x])
    note = V / "reels" / f"{_safe(x['title'])} - DQ-abc_1.md"
    assert note.exists(), list((V / "reels").iterdir())
    text = note.read_text()
    blocks, rest = _fm_split(text)
    fm = dict(blocks)
    assert json.loads(fm["id"].split(": ", 1)[1]) == "DQ-abc_1" and json.loads(fm["author"].split(": ", 1)[1]) == x["author"]
    assert "date: 2025-11-09" in fm["date"]
    assert _items(fm["tags"]) == ["рецепты", "3d", "t2025", "two_words"], fm["tags"]
    assert _items(fm["collections"]) == ["[[collections/Еда|Еда]]"] and _items(fm["cities"]) == ["[[places/Valencia|Valencia]]"]
    assert _items(fm["places"]) == ["Trattoria", "Без города"]
    assert "![[attachments/DQ-abc_1_0.jpg|300]]" in rest and "#рецепты" in rest and "\\#хэштег" in rest and "% %" in rest
    assert (V / "attachments" / "DQ-abc_1_0.jpg").read_bytes() == b"jpg1"
    hub = (V / "places" / "Valencia.md").read_text()
    assert "openstreetmap.org/?mlat=39.47&mlon=-0.37" in hub and "[[reels/" in hub
    assert (V / "sources" / "Instagram.md").exists() and (V / "collections" / "Еда.md").exists()

    # user edits: text above and below the block, an own frontmatter key, an own tag
    edited = text.replace("\ntags:\n", '\nrating: 5\ntags:\n  - "mine"\n', 1)
    edited = edited.replace(reels.OBS_START, "МОЙ ЗАГОЛОВОК\n" + reels.OBS_START).replace(reels.OBS_END, reels.OBS_END + "\n\nМОЯ ЗАМЕТКА")
    note.write_text(edited)
    obsidian(V, items=[x])
    assert note.read_text() == edited, "regenerating unchanged data must not touch the note"
    x2 = {**x, "title": "Новый заголовок", "summary": "Новое summary", "tags": ["рецепты"]}
    obsidian(V, items=[x2])
    t2 = note.read_text()
    assert note.exists() and not list((V / "reels").glob("Новый*")), "name must stay stable by id"
    assert "МОЯ ЗАМЕТКА" in t2 and "МОЙ ЗАГОЛОВОК" in t2 and "rating: 5" in t2 and _items(dict(_fm_split(t2)[0])["tags"]) == ["mine", "рецепты"]  # 4: tags we generated before and no longer generate are gone, "mine" stays
    assert "Новое summary" in t2 and "Паста за 10 минут" not in t2 and t2.count(reels.OBS_START) == 1
    # second run with the same data changes nothing
    snap = {p: p.read_bytes() for p in V.rglob("*") if p.is_file()}
    obsidian(V, items=[x2])
    assert snap == {p: p.read_bytes() for p in V.rglob("*") if p.is_file()}
    # markers deleted by the user: the block is appended, the rest stays
    note.write_text(re.sub(r"%% reels-tool:start %%.*%% reels-tool:end %%", "", note.read_text(), flags=re.S))
    obsidian(V, items=[x2])
    assert "МОЯ ЗАМЕТКА" in note.read_text() and note.read_text().count(reels.OBS_START) == 1
    # a reel gone from the database is reported, not deleted
    obsidian(V, items=[{**x2, "id": "other", "title": "Other", "thumbs": []}])
    assert note.exists()
    # --single: one file, no attachments, no hubs
    S1 = d / "single"
    obsidian(S1, single=True, items=[x2])
    assert [p.name for p in S1.rglob("*") if p.is_file()] == ["all.md"]
    assert "Valencia" in (S1 / "all.md").read_text() and "[[" not in (S1 / "all.md").read_text()

# review regressions: one assert each
import contextlib, io
def run(V, items):
    with contextlib.redirect_stdout(io.StringIO()):
        obsidian(V, items=items)
base = {"id": "A1", "source": "instagram", "url": "u", "title": "T", "places": [], "tags": ["x"], "collections": []}
with tempfile.TemporaryDirectory() as d:
    d = Path(d); reels.T = d / "thumbs"
    # 1: keys of ours elsewhere are not ours: user keys on a reel (type, date) and on a hub (url, author) survive
    V = d / "k"; run(V, [base]); n = next((V / "reels").glob("*.md"))
    n.write_text(n.read_text().replace("---\n", "---\ntype: recipe\ndate: 2024-01-01\n", 1)); run(V, [base])
    h = V / "collections" / "Food.md"; h.parent.mkdir(exist_ok=True)
    h.write_text("---\nurl: https://my\nauthor: me\nsource: book\n---\nMy food notes\n")
    run(V, [{**base, "collections": ["Food"]}])
    assert all(s in n.read_text() + h.read_text() for s in ("type: recipe", "date: 2024-01-01", "url: https://my", "author: me", "source: book", "My food notes"))
    # 2: only the END marker deleted: text typed after it survives two more runs
    V = d / "m"; run(V, [base]); n = next((V / "reels").glob("*.md"))
    n.write_text(n.read_text().replace(reels.OBS_END, "") + "\nMY NOTE AFTER\n"); run(V, [base]); run(V, [{**base, "summary": "s2"}])
    assert "MY NOTE AFTER" in n.read_text() and "s2" in n.read_text()
    # 3: no temp file is left behind, and a failing write leaves the old note intact
    assert not [p for p in V.rglob("*.tmp")]
    old = n.read_text(); real = reels.os.replace
    reels.os.replace = lambda *a: (_ for _ in ()).throw(OSError("disk"))
    try:
        run(V, [{**base, "summary": "s3"}]); raise SystemExit("expected OSError")
    except OSError:
        pass
    finally:
        reels.os.replace = real
    assert n.read_text() == old and not [p for p in V.rglob("*.tmp")]
    # 5: BOM + CRLF note is still found by id (no second note) and keeps its user key
    n.write_bytes(("\ufeff" + n.read_text().replace("---\n", "---\nrating: 5\n", 1)).replace("\n", "\r\n").encode()); run(V, [base])
    assert len(list((V / "reels").glob("*.md"))) == 1 and "rating: 5" in n.read_text()
    # 6: Food/food and a/b vs a b are one hub each
    V = d / "c"; run(V, [{**base, "collections": ["Food"]}, {**base, "id": "A2", "collections": ["food"]}, {**base, "id": "A3", "collections": ["a/b"]}, {**base, "id": "A4", "collections": ["a b"]}])
    assert len(list((V / "collections").iterdir())) == 2
    # 8: %% and [[ in texts do not break the comment block or create links
    V = d / "g"; run(V, [{**base, "title": "50%% off", "author": "a%%b", "collections": ["c"], "transcript": "see [[Secret]]"}])
    assert "%%" not in "".join(l for p in V.rglob("*.md") for l in p.read_text().splitlines() if "reels-tool" not in l and not l.startswith(("author", "url")))
    assert "\\[\\[Secret]]" in next((V / "reels").glob("*.md")).read_text()
print("ok obsidian")
