"""Self-check for link -> source / id:  python test_sources.py"""
from shelf import source_of, rid_of

cases = {
    "https://www.instagram.com/reel/ABCDEFGHIJK/": ("instagram", "ABCDEFGHIJK"),
    "https://www.instagram.com/p/ABCDEFGHIJK": ("instagram", "ABCDEFGHIJK"),
    "https://www.tiktok.com/@scout2015/video/6718335390845095173": ("tiktok", "6718335390845095173"),
    "https://vm.tiktok.com/ZMabc123/": ("tiktok", "tt_ZMabc123"),
    "https://www.tiktok.com/t/ZTabc/": ("tiktok", "tt_ZTabc"),
    "https://t.me/telegram/387": ("telegram", "tg_telegram_387"),
    "https://t.me/s/telegram/387": ("telegram", "tg_telegram_387"),
    "t.me/c/1234567/89": ("telegram", "tg_1234567_89"),
    "https://youtube.com/watch?v=x": (None, None),
    "https://notinstagram.com/p/x": (None, None),
}
for url, (src, rid) in cases.items():
    assert source_of(url) == src, (url, source_of(url))
    if src:
        assert rid_of(url) == rid, (url, rid_of(url))
print("ok", len(cases))

# saved items: telegram Saved Messages entries, TikTok export links, links inside message text
import json, tempfile
from pathlib import Path
from shelf import _tiktok_favorites, _links
assert source_of("tgsaved:42") == "telegram" and rid_of("tgsaved:42") == "tgs_42"
assert rid_of("https://www.tiktokv.com/share/video/7234567890123456789/") == "7234567890123456789"
assert _links("look https://www.instagram.com/reel/ABC/?igsh=x, and https://youtube.com/x") == ["https://www.instagram.com/reel/ABC/"]
export = {"Your Activity": {"Favorite Videos": {"FavoriteVideoList": [
    {"Date": "2026-01-02 10:00:00", "Link": "https://www.tiktokv.com/share/video/7234567890123456789/"},
    {"Date": "2026-01-03 10:00:00", "Link": "https://example.com/x"}]}},
    "Activity": {"Like List": {"ItemFavoriteList": [{"Link": "https://www.tiktokv.com/share/video/1/"}]}}}
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "user_data_tiktok.json"; p.write_text(json.dumps(export))
    assert _tiktok_favorites(p) == ["https://www.tiktokv.com/share/video/7234567890123456789/"], _tiktok_favorites(p)
print("ok saved")
