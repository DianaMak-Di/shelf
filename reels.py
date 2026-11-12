"""Saved reels -> transcripts + on-screen text + screenshots + hashtags -> searchable page.
  python reels.py fetch urls.txt [--cookies chrome]  # audio + caption + speech transcript -> data/ (instagram, tiktok, t.me links)
  python reels.py saved                               # new items from Telegram Saved Messages + TikTok favorites -> urls.txt
  python reels.py tg-login                            # once, in a terminal: log in to Telegram for "saved"
  python reels.py migrate                             # once: add "source" to reels saved before sources existed
  python reels.py frames                              # screenshots + on-screen text (OCR) for each reel
  python reels.py enrich                              # summary, hashtags, recipes/places/products/tips via the LLM (config.json)
  python reels.py keys                                # key content per reel
  python reels.py tagmap                              # squash specific hashtags into ~20 general ones
  python reels.py places [--force]                    # once: add city/country/address to places of older reels
  python reels.py cities                              # once: unify spelling of cities/countries (main language)
  python reels.py geocode [--force]                   # lat/lng for places via Nominatim (OpenStreetMap), 1 request/s
  python reels.py build                               # build the UI (ui/dist); run server.py to use it
  python reels.py obsidian <vault folder> [--single]  # export to Markdown for Obsidian: note per reel + hubs; --single = one all.md
collections.json = {"collection_name": [shortcodes]}; collection names become the primary hashtags.
"""
import filecmp, json, os, re, shutil, subprocess, sys, html, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import llm

ROOT = Path(__file__).parent
S = llm.strings()  # prompts and texts in the main language (config.json)
D = ROOT / "data"
T = D / "thumbs"
YTDLP = str(ROOT / ".venv/bin/yt-dlp")


SOURCES = {"instagram.com": "instagram", "tiktok.com": "tiktok", "tiktokv.com": "tiktok", "t.me": "telegram",
           "telegram.me": "telegram"}
TG_SAVED = "tgsaved:"  # urls.txt entry for a video in Telegram Saved Messages: tgsaved:<message id>


def source_of(url):
    """instagram | tiktok | telegram | None (unsupported link)."""
    if url.startswith(TG_SAVED):
        return "telegram"
    host = urllib.parse.urlparse(url if "//" in url else "https://" + url).netloc.lower().split(":")[0]
    return next((s for d, s in SOURCES.items() if host == d or host.endswith("." + d)), None)


def rid_of(url):
    """Reel id from its link, the same before and after download: names data/<id>.json.
    instagram: shortcode (as before); tiktok: video number, short links tt_<code>; telegram: tg_<channel>_<post>."""
    if url.startswith(TG_SAVED):
        return "tgs_" + url[len(TG_SAVED):]
    path = [p for p in urllib.parse.urlparse(url if "//" in url else "https://" + url).path.split("/") if p]
    src = source_of(url)
    if src == "tiktok" and "video" in path[:-1]:
        return path[path.index("video") + 1]
    if src == "tiktok":
        return "tt_" + path[-1]  # vm.tiktok.com/<code>, tiktok.com/t/<code>
    if src == "telegram":
        if path[:1] == ["s"]:
            path = path[1:]  # t.me/s/<channel>/<post> = web preview of the same post
        return "tg_" + "_".join(path[-2:])  # t.me/<channel>/<post>; private t.me/c/<id>/<post> -> tg_<id>_<post>
    return path[-1] if path else url


def fetch(urls_file, cookies=None):
    from faster_whisper import WhisperModel
    import numpy as np
    D.mkdir(exist_ok=True)
    model = tg = None
    tmp = ROOT / "tmp"; tmp.mkdir(exist_ok=True)
    for url in Path(urls_file).read_text().split():
        src, rid = source_of(url), rid_of(url)
        if not src:
            print("SKIP (unsupported link)", url); continue
        out = D / f"{rid}.json"
        if out.exists():
            continue  # already processed (ponytail: failed/old reels get retried every sync, ~2s each)
        if url.startswith(TG_SAVED):
            # video from Saved Messages: no public link, download with the logged-in client; the mp4 and its info
            # stay in tmp/ for frames
            tg = tg or _tg()
            info = tg and _tg_download(tg, int(url[len(TG_SAVED):]), tmp / f"{rid}.mp4")
            if not info:
                print("FAIL", url, "" if tg else "(telegram: run python reels.py tg-login)"); continue
            (tmp / f"{rid}.info.json").write_text(json.dumps(info, ensure_ascii=False))
            info_p, mp3 = None, tmp / f"{rid}.mp4"
        else:
            cmd = [YTDLP, "-x", "--audio-format", "mp3", "--write-info-json", "-q", "--no-warnings",
                   "--dateafter", "today-1year", "-o", str(D / f"{rid}.%(ext)s"), url]
            if cookies:
                cmd[1:1] = ["--cookies-from-browser", cookies]
            info_p, mp3 = D / f"{rid}.info.json", D / f"{rid}.mp3"
            if subprocess.run(cmd).returncode or not info_p.exists():
                # telegram posts without video (text, photos) end up here too: yt-dlp finds nothing to download
                print("FAIL", url); info_p.unlink(missing_ok=True); continue
            info = json.loads(info_p.read_text())
        model = model or WhisperModel("small", compute_type="int8")  # auto-detects language
        pcm = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(mp3), "-f", "f32le",
                              "-ac", "1", "-ar", "16000", "-"], capture_output=True).stdout
        segs, meta = model.transcribe(np.frombuffer(pcm, dtype=np.float32))
        out.write_text(json.dumps({
            "id": rid, "source": src, "url": info.get("webpage_url", url).replace("?single=True", ""),
            "author": info.get("uploader") or info.get("channel"),  # telegram: channel name
            "caption": info.get("description") or info.get("title"), "lang": meta.language,
            "transcript": " ".join(s.text.strip() for s in segs),
        }, ensure_ascii=False, indent=1))
        if info_p:
            info_p.unlink(); mp3.unlink(missing_ok=True)
        print("OK", rid)
    if tg:
        tg.disconnect()


TG_SESSION = ROOT / "telegram"  # Telethon session = telegram.session: your logged-in account, keep it private
TG_STATE = ROOT / "saved_state.json"  # last Saved Messages id already looked at


def _cfg():
    f = ROOT / "config.json"
    return json.loads(f.read_text()) if f.exists() else {}


def _tg():
    """Logged-in Telethon client, or None until python reels.py tg-login has been run."""
    c = _cfg().get("telegram") or {}
    if not c or not TG_SESSION.with_suffix(".session").exists():
        return None
    from telethon.sync import TelegramClient
    cl = TelegramClient(str(TG_SESSION), int(c["api_id"]), c["api_hash"])
    cl.connect()
    if cl.is_user_authorized():
        return cl
    cl.disconnect()


def tg_login():
    """Once, in a terminal: api_id/api_hash from my.telegram.org go to config.json, then phone + code (+ 2FA password)
    are asked by Telethon itself. The session file stays on this machine."""
    cfg = _cfg()
    if not cfg.get("telegram"):
        print("my.telegram.org -> API development tools -> create an app, then paste its api_id and api_hash")
        cfg["telegram"] = {"api_id": int(input("api_id: ").strip()), "api_hash": input("api_hash: ").strip()}
        (ROOT / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    from telethon.sync import TelegramClient
    with TelegramClient(str(TG_SESSION), int(cfg["telegram"]["api_id"]), cfg["telegram"]["api_hash"]) as c:
        name = c.get_me().first_name
    _save_cfg(telegram={**cfg["telegram"], "user": name})
    print("OK, logged in as", name)


def _save_cfg(**kv):
    cfg = {**_cfg(), **kv}
    (ROOT / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2))


def tg_web(step, **f):
    """Telegram login from the UI, one HTTP request per step; each step opens the saved session again, so the steps can
    run in different server threads. step: "code" {api_id, api_hash, phone} -> {"hash"};
    "sign_in" {phone, code, hash} -> {"ok"} or {"password": True}; "password" {password} -> {"ok"};
    "logout" -> {"ok"}. Errors -> {"error": text}. The phone, code and password are not stored."""
    import asyncio
    from telethon import TelegramClient, errors

    async def run():
        if step == "code":
            _save_cfg(telegram={"api_id": int(str(f["api_id"]).strip()), "api_hash": str(f["api_hash"]).strip()})
        c = _cfg().get("telegram") or {}
        if not c:
            return {"error": "no api_id/api_hash"}
        cl = TelegramClient(str(TG_SESSION), int(c["api_id"]), c["api_hash"])
        await cl.connect()
        try:
            if step == "code":
                return {"hash": (await cl.send_code_request(f["phone"])).phone_code_hash}
            if step == "sign_in":
                try:
                    await cl.sign_in(phone=f["phone"], code=str(f["code"]).strip(), phone_code_hash=f["hash"])
                except errors.SessionPasswordNeededError:
                    return {"password": True}
            if step == "password":
                await cl.sign_in(password=f["password"])
            if step == "logout":
                await cl.log_out()  # ends the session in Telegram too, then removes the file
                TG_SESSION.with_suffix(".session").unlink(missing_ok=True)
                _save_cfg(telegram={k: v for k, v in c.items() if k != "user"})
                return {"ok": True}
            me = await cl.get_me()
            _save_cfg(telegram={**c, "user": me.first_name})  # marks the login as finished
            return {"ok": True, "user": me.first_name}
        finally:
            await cl.disconnect()

    try:
        return asyncio.run(run())
    except (ValueError, KeyError) as e:
        return {"error": f"bad input: {e}"}
    except Exception as e:  # noqa: BLE001 - telethon RPC errors: wrong code, flood wait, bad api_hash...
        return {"error": str(e) or type(e).__name__}


def tiktok_import(raw):
    """TikTok data export (the .zip as downloaded, or user_data_tiktok.json from it) -> user_data_tiktok.json here.
    Returns the number of favorite videos found; raises ValueError if it is not a TikTok export."""
    import io, zipfile
    if raw[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                names = [n for n in z.namelist() if n.endswith(".json")]
                if not names:
                    raise ValueError("no JSON file in the archive")
                raw = z.read(next((n for n in names if "user_data" in n), names[0]))
        except zipfile.BadZipFile as e:
            raise ValueError(f"broken archive: {e}")
    tmp = ROOT / "user_data_tiktok.json.part"
    tmp.write_bytes(raw)
    try:
        n = len(_tiktok_favorites(tmp))
    except (json.JSONDecodeError, UnicodeDecodeError):
        tmp.unlink(); raise ValueError("not a JSON export")
    tmp.replace(ROOT / "user_data_tiktok.json")
    return n


def sources_status():
    """What the onboarding shows: Telegram logged in? TikTok export present (and how many favorites)? Items put off."""
    f = ROOT / "user_data_tiktok.json"
    c = _cfg()
    return {"telegram": (c.get("telegram") or {}).get("user") if TG_SESSION.with_suffix(".session").exists() else None,
            "tiktok": len(_tiktok_favorites(f)) if f.exists() else None, "later": c.get("later", [])}


def _is_video(m):
    return bool(m and m.video and not m.gif)  # gifs carry the video attribute too


def _tg_download(c, mid, path):
    """Saved Messages video -> path; returns yt-dlp-like info, None if the message is gone or has no video."""
    m = c.get_messages("me", ids=mid)
    if not _is_video(m) or not c.download_media(m, file=str(path)):
        return None
    f = m.forward
    ch = f and (f.chat or f.sender)
    name = getattr(ch, "title", None) or " ".join(filter(None, [getattr(ch, "first_name", None), getattr(ch, "last_name", None)]))
    user = getattr(ch, "username", None)
    if f and user and f.channel_post:
        url = f"https://t.me/{user}/{f.channel_post}"  # forwarded from a public channel: open the original post
    else:
        url = f"tg://openmessage?user_id={c.get_me().id}&message_id={mid}"  # opens the message in the Telegram app
    return {"webpage_url": url, "uploader": name or (f and f.from_name) or (f and "Telegram") or c.get_me().first_name,
            "description": m.raw_text or "", "upload_date": ((f and f.date) or m.date).strftime("%Y%m%d"),
            "duration": m.file.duration or 0, "view_count": m.views or 0, "like_count": 0}


def _links(text):
    return [u.split("?")[0].rstrip(").,") for u in re.findall(r"https?://\S+", text or "") if source_of(u)]


def _tiktok_favorites(path):
    """Links from TikTok's data export (Settings -> Account -> Download your data, JSON): every "FavoriteVideoList"."""
    out = []
    def walk(v):
        if isinstance(v, dict):
            for k, w in v.items():
                if k == "FavoriteVideoList" and isinstance(w, list):
                    out.extend(i.get("Link") or i.get("link") for i in w if isinstance(i, dict))
                else:
                    walk(w)
        elif isinstance(v, list):
            for w in v:
                walk(w)
    walk(json.loads(Path(path).read_text()))
    return [u for u in out if u and source_of(u)]


def saved():
    """New saved items -> urls.txt; fetch picks them up. Sources, each skipped when not set up:
    Telegram Saved Messages (after tg-login): videos + Instagram/TikTok/t.me links in messages, saved within a year;
    TikTok favorites: user_data_tiktok*.json export files in this folder (yt-dlp cannot list favorites, and its public
    collection extractor returns nothing as of 2026.10)."""
    uf = ROOT / "urls.txt"
    known = uf.read_text().split() if uf.exists() else []
    add = []
    c = _tg()
    if c:
        st = json.loads(TG_STATE.read_text()) if TG_STATE.exists() else {}
        last, since = st.get("last_id", 0), datetime.now(timezone.utc) - timedelta(days=365)
        for m in c.iter_messages("me", reverse=True, min_id=last, offset_date=since):  # oldest first
            last = max(last, m.id)
            if _is_video(m):
                add.append(f"{TG_SAVED}{m.id}")
            add += _links(m.raw_text) + _links(" ".join(getattr(e, "url", "") or "" for e in m.entities or []))
        TG_STATE.write_text(json.dumps({"last_id": last}))
        c.disconnect()
    for f in sorted(ROOT.glob("user_data_tiktok*.json")):
        add += _tiktok_favorites(f)
    have = set(known) | {rid_of(u) for u in known}
    new = [u for u in dict.fromkeys(add) if u not in have and rid_of(u) not in have]
    if new:
        uf.write_text("\n".join(known + new) + "\n")
    print("saved:", len(new), "new")


def migrate_source():
    """Once: write "source" into reels saved before sources existed (all were instagram). Run: python reels.py migrate"""
    n = 0
    for p in sorted(D.glob("*.json")):
        x = json.loads(p.read_text())
        if "source" not in x:
            x["source"] = source_of(x.get("url", "")) or "instagram"
            p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); n += 1
    print("migrate:", n, "reels")


def frames(cookies=None):
    """Download each video, grab 5 frames, OCR them (Apple Vision, ru+en), keep 2 as screenshots."""
    from ocrmac import ocrmac
    T.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / "tmp"; tmp.mkdir(exist_ok=True)
    for p in sorted(D.glob("*.json")):
        x = json.loads(p.read_text())
        if "upload_date" in x:
            continue
        rid = x["id"]
        v = tmp / f"{rid}.mp4"
        cmd = [YTDLP, "-q", "--no-warnings", "--write-info-json", "-f", "best[height<=720]/best", "-o", str(v), x["url"]]
        if cookies:
            cmd[1:1] = ["--cookies-from-browser", cookies]
        if not v.exists() and rid.startswith("tgs_"):  # Saved Messages video, normally left in tmp/ by fetch
            tg = _tg()
            info = tg and _tg_download(tg, int(rid[4:]), v)
            tg and tg.disconnect()
            if info:
                (tmp / f"{rid}.info.json").write_text(json.dumps(info, ensure_ascii=False))
        elif not v.exists():
            subprocess.run(cmd)
        if not v.exists():
            print("FAIL", rid); continue
        ij = tmp / f"{rid}.info.json"
        info = json.loads(ij.read_text()) if ij.exists() else {}
        ij.unlink(missing_ok=True)
        # key moments = scene changes; fall back to even spacing for static videos
        for old in T.glob(f"{rid}_*.jpg"):
            old.unlink()
        subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-i", str(v), "-vf", "select='gt(scene,0.3)',scale=540:-2",
                        "-vsync", "vfr", "-frames:v", "40", "-q:v", "4", str(tmp / f"{rid}_s%02d.jpg")])
        pool = sorted(tmp.glob(f"{rid}_s*.jpg"))
        if len(pool) < 3:
            dur = float(info.get("duration") or 10)
            for n, f in enumerate([.15, .5, .85]):
                img = tmp / f"{rid}_f{n}.jpg"
                subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-ss", str(dur * f), "-i", str(v), "-frames:v", "1",
                                "-vf", "scale=540:-2", "-q:v", "4", str(img)])
                if img.exists():
                    pool.append(img)
        pick = lambda k: [pool[round(i * (len(pool) - 1) / max(k - 1, 1))] for i in range(min(k, len(pool)))]
        seen, lines = set(), []
        for img in dict.fromkeys(pick(8)):
            for text, conf, _ in ocrmac.OCR(str(img), recognition_level="accurate",
                                            language_preference=["ru-RU", "en-US"]).recognize():
                if conf > .5 and text.lower() not in seen:
                    seen.add(text.lower()); lines.append(text)
        thumbs = []
        for n, img in enumerate(dict.fromkeys(pick(3))):
            img.rename(T / f"{rid}_{n}.jpg"); thumbs.append(f"thumbs/{rid}_{n}.jpg")
        for left in tmp.glob(f"{rid}_*.jpg"):
            left.unlink()
        x.update(ocr=" | ".join(lines), thumbs=thumbs, upload_date=info.get("upload_date") or "",
                 likes=info.get("like_count") or 0, views=info.get("view_count") or 0,
                 duration=info.get("duration") or 0)
        p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); v.unlink(); print("OK", rid)


def keys(workers=6, force=False):
    from concurrent.futures import ThreadPoolExecutor

    def one(p):
        x = json.loads(p.read_text())
        if "key" in x and not force:
            return
        k = llm.ask_json(S["keyprompt"] % ((x["caption"] or "")[:1500], x["transcript"][:6000], x.get("ocr", "")[:2500]),
                         "strong", "[")
        if k is None:
            return print("FAIL", x["id"])
        x["key"] = k
        p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, sorted(D.glob("*.json"))))


def condense(workers=8, force=False):
    """Halve summary and key texts in place; originals kept in summary_full / key_full (also marks the reel as done)."""
    from concurrent.futures import ThreadPoolExecutor

    def one(p):
        x = json.loads(p.read_text())
        if "summary_full" in x and not force:
            return
        src = json.dumps({"summary": x.get("summary", ""), "key": x.get("key", [])}, ensure_ascii=False)
        n = llm.ask_json(S["condense"] % src, "fast")
        try:
            x["summary_full"], x["key_full"] = x.get("summary_full", x.get("summary", "")), x.get("key_full", x.get("key", []))
            x["summary"], x["key"] = n["summary"], n["key"]
            p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])
        except (TypeError, KeyError):
            print("FAIL", x["id"])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, sorted(D.glob("*.json"))))


def collections_of():
    f = ROOT / "collections.json"
    out = {}
    for name, ids in (json.loads(f.read_text()) if f.exists() else {}).items():
        for i in ids:
            out.setdefault(i, []).append(name)
    return out


def enrich(workers=6, force=False):
    from concurrent.futures import ThreadPoolExecutor
    cols = collections_of()

    def one(p):
        x = json.loads(p.read_text())
        if "hashtags" in x and not force:
            return
        r = llm.ask_json(S["prompt"] % ((x["caption"] or "")[:1500], x["transcript"][:5000], x.get("ocr", "")[:2000]), "fast")
        if r is None:
            return print("FAIL", x["id"])
        x.update(r)
        x["collections"] = cols.get(x["id"], [])
        p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, sorted(D.glob("*.json"))))


def place(v, name=""):
    """A place as stored by the UI: str (older reels) or dict -> {"name", "city", "country"}."""
    v = v if isinstance(v, dict) else {"name": v}
    s = lambda k: str(v.get(k) or "").strip()
    out = {"name": s("name") or name, "city": s("city"), "country": s("country")}
    if s("address"):
        out["address"] = s("address")
    out.update({k: v[k] for k in ("lat", "lng", "geo", "approx") if k in v})  # geocoder result, kept as is
    return out


def places(workers=6, force=False):
    """One-off: add city/country/address to places stored as plain strings (older reels); --force redoes all places
    (then run geocode --force). Run by hand: python reels.py places"""
    from concurrent.futures import ThreadPoolExecutor

    def one(p):
        x = json.loads(p.read_text())
        sel = lambda q: force or isinstance(q, str)
        old = [place(q)["name"] for q in x.get("places", []) if sel(q)]
        if not old:
            return
        r = llm.ask_json(S["placesprompt"] % (json.dumps(old, ensure_ascii=False), (x["caption"] or "")[:1500],
                                              x["transcript"][:5000], x.get("ocr", "")[:2000]), "fast", "[")
        if not isinstance(r, list) or len(r) != len(old):
            return print("FAIL", x["id"])
        it = iter(r)
        x["places"] = [place(next(it), place(q)["name"]) if sel(q) else place(q) for q in x["places"]]
        p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, sorted(D.glob("*.json"))))


def cities():
    """One LLM call over the unique (city, country) pairs: rewrites them to one spelling in the main language, so the
    same city is one group in the UI. Run by hand: python reels.py cities (ponytail: one call, fine up to a few hundred pairs)."""
    files = {p: json.loads(p.read_text()) for p in sorted(D.glob("*.json"))}
    pairs = sorted({(q["city"], q["country"]) for x in files.values() for q in map(place, x.get("places", []))
                    if q["city"] or q["country"]})
    if not pairs:
        return
    r = llm.ask_json(S["citiesprompt"] % json.dumps([{"city": c, "country": k} for c, k in pairs], ensure_ascii=False),
                     "strong", "[")
    if not isinstance(r, list) or len(r) != len(pairs):
        return print("cities: failed, nothing changed")
    new = {pr: (str(n.get("city") or "").strip(), str(n.get("country") or "").strip()) for pr, n in zip(pairs, r)
           if isinstance(n, dict)}
    for p, x in files.items():
        ps = [place(q) for q in x.get("places", [])]
        out = [{**q, **dict(zip(("city", "country"), new.get((q["city"], q["country"]), (q["city"], q["country"]))))}
               for q in ps]
        if out != ps:
            x["places"] = out
            p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])
    print("cities:", len(pairs), "->", len(set(new.values())))


def _nominatim(q):
    """(lat, lng) of the best match, None if nothing found; network errors raise OSError."""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "json", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": "reels-tool (personal, local)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    return (float(d[0]["lat"]), float(d[0]["lon"])) if d else None


def geocode(force=False, find=_nominatim, pause=1.0):
    """lat/lng for every place without them. Queries, precise to simple: address, name+city+country, name+city, then the
    city centre ("approx": true); empty parts skipped. Network errors retry the same query. Nothing found -> "geo": "none",
    no retry until --force.
    Sequential: Nominatim allows 1 request/s. Names of places leave your machine for Nominatim."""
    cache = {}  # same query twice in one run -> one request

    def lookup(q):
        for _ in range(3):
            try:
                if q not in cache:
                    time.sleep(pause)
                    cache[q] = find(q)
                return cache[q]
            except OSError as e:
                print("  geocode error:", e)
        return None

    for p in sorted(D.glob("*.json")):
        x = json.loads(p.read_text())
        todo = [q for q in map(place, x.get("places", [])) if force or "lat" not in q and "geo" not in q]
        if not todo:
            continue
        done = {q["name"] + "|" + q["city"]: q for q in todo}
        for q in done.values():
            for k in ("lat", "lng", "geo", "approx"):
                q.pop(k, None)
            j = lambda *parts: ", ".join(filter(None, parts))
            tries = [q.get("address"), j(q["name"], q["city"], q["country"]), j(q["name"], q["city"] or q["country"])]
            for t in dict.fromkeys(filter(None, tries)):  # drops repeated queries
                hit = lookup(t)
                if hit:
                    q["lat"], q["lng"] = hit
                    break
            else:
                hit = lookup(j(q["city"], q["country"])) if q["city"] else None  # city centre, shown as approximate
                if hit:
                    q["lat"], q["lng"], q["approx"] = hit[0], hit[1], True
                else:
                    q["geo"] = "none"
        x["places"] = [done.get(q["name"] + "|" + q["city"], q) for q in map(place, x["places"])]
        p.write_text(json.dumps(x, ensure_ascii=False, indent=1)); print("OK", x["id"])


TAGMAP = ROOT / "tagmap.json"


def tagmap(limit=22):
    m = json.loads(TAGMAP.read_text()) if TAGMAP.exists() else {}
    cnt = {}
    for p in D.glob("*.json"):
        for h in json.loads(p.read_text()).get("hashtags", []):
            h = h.strip().lstrip("#").lower().replace(" ", "_")
            if h not in m:
                cnt[h] = cnt.get(h, 0) + 1
    if not cnt:
        return
    new = {}
    for chunk in [sorted(cnt.items(), key=lambda kv: -kv[1])[i:i + 400] for i in range(0, len(cnt), 400)]:
        r = llm.ask_json(S["tagprompt"] % (limit, sorted(set(m.values()) | set(new.values())),
                                           ", ".join(f"{k}:{v}" for k, v in chunk)), "strong")
        if r is None:
            return print("tagmap: failed, will retry on next sync")
        new.update(r)
    m.update({k.strip().lstrip("#").lower().replace(" ", "_"): v.strip().lstrip("#").lower().replace(" ", "_")
              for k, v in new.items()})
    for h in cnt:
        m.setdefault(h, S["other"])
    TAGMAP.write_text(json.dumps(m, ensure_ascii=False, indent=1))
    print("tagmap:", len(set(m.values())), "general tags")


_emb = {"model": None, "vec": {}}


def search(q, limit=60):
    """Semantic search: [(reel_id, cosine)] best first. Local multilingual model, vectors cached in memory per reel."""
    import numpy as np
    from fastembed import TextEmbedding
    if _emb["model"] is None:
        _emb["model"] = TextEmbedding("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    items = export_items()
    text = lambda x: " . ".join(filter(None, [x.get("title"), x.get("summary"), " ".join(x.get("specific_tags", [])),
                                              " ".join(k["text"] for k in x.get("key", [])), (x.get("caption") or "")[:300],
                                              (x.get("transcript") or "")[:500]]))
    todo = [x for x in items if x["id"] not in _emb["vec"]]
    if todo:
        for x, v in zip(todo, _emb["model"].embed([text(x) for x in todo])):
            _emb["vec"][x["id"]] = v
    qv = next(iter(_emb["model"].query_embed(q)))
    sc = sorted(((x["id"], float(np.dot(qv, _emb["vec"][x["id"]]) / (np.linalg.norm(qv) * np.linalg.norm(_emb["vec"][x["id"]])))) for x in items), key=lambda t: -t[1])
    return sc[:limit]


def export_items():
    """Everything the UI needs, one dict per reel. Primary tags = collections, general = squashed from hashtags."""
    m = json.loads(TAGMAP.read_text()) if TAGMAP.exists() else {}
    cols = collections_of()
    uf = ROOT / "urls.txt"
    order = {rid_of(u): n for n, u in enumerate(uf.read_text().split() if uf.exists() else [])}
    out = []
    for p in D.glob("*.json"):
        x = json.loads(p.read_text())
        norm = lambda h: h.strip().lstrip("#").lower().replace(" ", "_")
        general = sorted({m.get(norm(h), S["other"]) for h in x.get("hashtags", [])})
        x["thumbs"] = [f"thumbs/{Path(t).name}" for t in x.get("thumbs", []) if (T / Path(t).name).exists()]
        x["places"] = [q for q in (place(v) for v in x.get("places", [])) if q["name"]]
        out.append({**x, "source": x.get("source") or source_of(x.get("url", "")) or "instagram", "collections": cols.get(x["id"], []), "tags": general, "order": order.get(x["id"], 9999),
                    "specific_tags": sorted({norm(h) for h in x.get("hashtags", [])})})
    return out


OBS_START, OBS_END = "%% reels-tool:start %%", "%% reels-tool:end %%"  # Obsidian comments: hidden in preview
SOURCE_NAMES = {"instagram": "Instagram", "tiktok": "TikTok", "telegram": "Telegram"}


def _safe(s, fallback="_", n=80):
    """Text -> file name stem that is safe on every file system and in [[links]]."""
    s = re.sub(r"%{2,}", "%", re.sub(r'[\\/:*?"<>|#^\[\]\x00-\x1f]+', " ", str(s or "")))  # %% would open a comment in [[links]]
    return " ".join(s.split())[:n].strip(" .") or fallback


def _tag(t):
    """Valid Obsidian tag: letters (any alphabet), digits, _ - /, not only digits."""
    t = re.sub(r"[^\w/-]+", "_", str(t).strip().lstrip("#")).strip("_")
    return "t" + t if t and re.fullmatch(r"[\d_/-]+", t) else t


def _t(s):
    """Reel text for a note: no accidental #tags from captions, no [[links]], no %% that would end the comment block."""
    return re.sub(r"(?<![\w&\\])#(?=\w)", r"\\#", str(s or "").replace("%%", "% %").replace("[[", "\\[\\[")).strip()


def _yaml(k, v):
    """One top-level frontmatter key. Strings as JSON strings: valid YAML, quotes/colons/newlines escaped."""
    if isinstance(v, list):
        return f"{k}:" + ("".join(f"\n  - {json.dumps(i, ensure_ascii=False)}" for i in v) if v else " []")
    return f"{k}: {v.isoformat() if hasattr(v, 'isoformat') else json.dumps(v, ensure_ascii=False)}"  # date unquoted = Obsidian date


def _fm_split(text):
    """Note text -> ([[key, yaml text of that key], ...], text after the frontmatter). Not a YAML parser: top-level keys
    are cut as they are, so keys we do not know survive byte for byte."""
    m = re.match(r"---[ \t]*\n(.*?)^---[ \t]*(?:\n|\Z)", text, re.S | re.M)
    if not m:
        return [], text
    blocks = []
    for line in m.group(1).splitlines():
        k = re.match(r"([^\s#:\-][^:]*):(?:\s|$)", line)
        if k:
            blocks.append([k.group(1).strip().strip("\"'"), line])
        elif blocks:
            blocks[-1][1] += "\n" + line
        else:
            blocks.append([None, line])
    return blocks, text[m.end():]


def _items(txt):
    """Values of a list key: block (- a), flow ([a, b]) or "a, b"."""
    first, _, rest = txt.partition("\n")
    v = first.split(":", 1)[1].strip()
    raw = v.strip("[]").split(",") if v else re.findall(r"^\s*-\s+(.*)$", rest, re.M)
    return [r.strip().strip("\"'") for r in raw if r.strip()]


def _read(p):
    return p.read_text("utf-8").replace("\r\n", "\n").lstrip("\ufeff")  # Windows editors: CRLF, BOM


def _note(path, fm, body):
    """Create or update a note. Ours: the block between the markers and the frontmatter keys in `fm` (empty list = [],
    so a key is never silently dropped); every other key and all text outside the block stay. `tags`: your own tags are
    kept, the tags we generated last time (`reels_tags`) are replaced by the new ones. Markers gone or half gone -> a new
    block is appended at the end, nothing you wrote is eaten. Written to a temp file and renamed. Returns
    "new" | "updated" | "same"."""
    old = _read(path) if path.exists() else None
    blocks, rest = _fm_split(old) if old is not None else ([], "")
    was, new, out, seen = dict(blocks), {}, [], set()
    for k, v in fm.items():
        new[k] = v
        if k == "tags":  # generated tags: v; old tags that we did not generate are yours
            prev = _items(was["reels_tags"]) if "reels_tags" in was else []
            mine = [i for i in _items(was["tags"]) if i not in prev] if "tags" in was else []
            new.update(tags=mine + [i for i in v if i not in mine], reels_tags=v)
    block = f"{OBS_START}\n{body}\n{OBS_END}"
    j = rest.rfind(OBS_END)  # the last complete pair; a lone marker is just text
    i = rest.rfind(OBS_START, 0, j) if j >= 0 else -1
    rest = rest[:i] + block + rest[j + len(OBS_END):] if i >= 0 else (rest.rstrip("\n") + "\n\n" if rest.strip() else "") + block + "\n"
    for k, txt in blocks:
        if k not in new:
            out.append(txt); continue
        seen.add(k)
        out.append(_yaml(k, new[k]))
    out += [_yaml(k, v) for k, v in new.items() if k not in seen]
    text = "---\n" + "\n".join(out) + "\n---\n" + rest
    if text == old:
        return "same"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        tmp.write_text(text, "utf-8")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return "new" if old is None else "updated"


def _obs_index(d):
    """Existing notes: reel id -> path (read from the `id` key, so renaming or moving a note inside d is fine). Two notes
    with one id: the first one (by path) is updated, a warning names both."""
    idx = {}
    for p in sorted(d.rglob("*.md")):
        try:
            for k, txt in _fm_split(_read(p))[0]:
                if k == "id":
                    i = txt.split(":", 1)[1].strip().strip("\"'")
                    if i in idx:
                        print(f"obsidian: warning: id {i} is in two notes, only the first is updated: {idx[i]} and {p}")
                    idx.setdefault(i, p)
        except UnicodeDecodeError:
            pass
    return idx


def _osm(q):
    return f"https://www.openstreetmap.org/?mlat={q['lat']}&mlon={q['lng']}#map=16/{q['lat']}/{q['lng']}"


def _iso(x):
    try:
        return datetime.strptime(x.get("upload_date") or "", "%Y%m%d").date()
    except ValueError:
        return None


def obsidian(vault, single=False, items=None):
    """Export the database to Markdown for Obsidian (python reels.py obsidian <vault folder> [--single]).
    Per reel reels/<title> - <id>.md (+ attachments/ with screenshots), hubs places/<city>.md, sources/<source>.md,
    collections/<name>.md. --single: only all.md, no attachments, no hubs. Run again any time: only the generated block
    between the %% markers and our frontmatter keys are rewritten; nothing is deleted (reels removed from the database
    are only counted). Same data -> byte-identical files."""
    O, V = S["obs"], Path(vault).expanduser()
    items = sorted(items if items is not None else export_items(), key=lambda x: (x.get("upload_date") or "", x["id"]), reverse=True)
    stat = {"new": 0, "updated": 0, "same": 0}

    def put(path, fm, body):
        stat[_note(path, fm, body)] += 1

    # one hub per city+country and per collection, however the name is cased (file systems ignore case): key -> first spelling
    hk = lambda q: (_safe(q["city"]).casefold(), q["country"].casefold())
    hubs = {}
    for q in sorted((q for x in items for q in x["places"] if q["city"]), key=lambda q: (q["city"], q["country"])):
        hubs.setdefault(hk(q), q)
    city = {k: _safe(f"{q['city']} ({q['country']})" if q["country"] and sum(o[0] == k[0] for o in hubs) > 1 else q["city"]) for k, q in hubs.items()}  # same city in two countries -> "City (Country)"
    ck = lambda c: _safe(c).casefold()
    cols = {}
    for c in sorted({c for x in items for c in x.get("collections", [])}):
        cols.setdefault(ck(c), c)
    idx = {} if single else _obs_index(V / "reels")
    target = {x["id"]: (idx[x["id"]].relative_to(V) if x["id"] in idx else Path("reels", f"{_safe(x.get('title') or x.get('caption'), x['id'])} - {x['id']}.md")).with_suffix("").as_posix() for x in items}
    alias = lambda s: " ".join(re.sub(r"[|\[\]]", " ", str(s).replace("%%", "% %")).split())  # | [] %% would break a [[link|alias]]
    link = lambda t, s: alias(s) if single else f"[[{t}|{alias(s)}]]"  # --single has no hubs: plain text instead of links
    rlink = lambda x: link(target[x["id"]], x.get("title") or x["id"])
    h = 2 if single else 1

    def body(x):
        H = lambda n, t: f"{'#' * (h + n)} {t}"
        tags = list(dict.fromkeys(filter(None, map(_tag, x.get("tags", [])))))
        P = [H(0, _t(" ".join((x.get("title") or x["id"]).split())))]
        if single:  # no frontmatter per reel: source, author, date, link go into the text
            P.append(" · ".join(map(str, filter(None, [SOURCE_NAMES.get(x["source"], x["source"]), _t(x.get("author")), _iso(x), x["url"]]))))
        if x.get("summary"):
            P.append("> " + _t(x["summary"]))
        if tags:
            P.append(f"**{O['tags']}:** " + " ".join("#" + t for t in tags))
        if x.get("collections"):
            P.append(f"**{O['collections']}:** " + ", ".join(link(f"collections/{_safe(cols[ck(c)])}", c) for c in x["collections"]))
        keys = [k for k in x.get("key") or [] if isinstance(k, dict) and k.get("text")]
        if keys:
            P.append(H(1, O["key"]) + "\n\n" + "\n".join(f"- {'**' + _t(k['kind']) + ':** ' if k.get('kind') else ''}{_t(k['text'])}" for k in keys))
        if x["places"]:
            P.append(H(1, O["places"]) + "\n\n" + "\n".join("- " + _place(q) for q in x["places"]))
        for key, text in (("caption", x.get("caption")), ("transcript", x.get("transcript")), ("ocr", x.get("ocr"))):
            if text and text.strip():
                P.append(H(1, O[key]) + "\n\n" + _t(text))
        if x.get("thumbs") and not single:
            P.append(H(1, O["shots"]) + "\n\n" + "\n".join(f"![[attachments/{Path(t).name}|300]]" for t in x["thumbs"]))
        return "\n\n".join(P)

    def _place(q):
        c = ", ".join(filter(None, [q["city"], q["country"]]))
        s = f"**{_t(q['name'])}**"
        if q["city"]:
            s += " — " + link(f"places/{city[hk(q)]}", q["city"]) + (f", {_t(q['country'])}" if q["country"] else "")
        elif c:
            s += f" — {_t(c)}"
        if "lat" in q:
            s += f" · [{O['map']}]({_osm(q)})" + (f" ({O['approx']})" if q.get("approx") else "")
        return s

    def rlist(xs):
        return "\n".join(f"- {rlink(x)}" + (f" — {_t(x['summary'])}" if x.get("summary") else "") for x in xs)

    if single:
        put(V / "all.md", {"type": "all"}, f"# {S['ui']['title']}\n\n" + "\n\n".join(map(body, items)))
    else:
        for x in items:
            q = [q for q in x["places"] if q["city"]]
            d = _iso(x)
            put(V / (target[x["id"]] + ".md"),
                {"id": x["id"], "source": x["source"], "url": x["url"], **({"author": x["author"]} if x.get("author") else {}),
                 **({"date": d} if d else {}),  # unknown author/date: the key is not ours, a value you typed stays
                 "tags": list(dict.fromkeys(filter(None, map(_tag, x.get("tags", []))))),
                 "cities": list(dict.fromkeys(link(f"places/{city[hk(p)]}", p["city"]) for p in q)),
                 "collections": list(dict.fromkeys(link(f"collections/{_safe(cols[ck(c)])}", c) for c in x.get("collections", []))),
                 "places": [p["name"] for p in x["places"]]}, body(x))
        for key, q0 in hubs.items():  # city hubs: places with a map link, then the reels
            here = [x for x in items if any(q["city"] and hk(q) == key for q in x["places"])]
            lines = [f"- **{_t(q['name'])}**" + (f" · [{O['map']}]({_osm(q)})" + (f" ({O['approx']})" if q.get("approx") else "") if "lat" in q else "") + f" — {rlink(x)}"
                     for x in here for q in x["places"] if q["city"] and hk(q) == key]
            put(V / "places" / f"{city[key]}.md", {"type": "place"},
                f"# {_t(q0['city'])}\n\n{_t(q0['country'])}\n\n## {O['places']}\n\n" + "\n".join(lines) + f"\n\n## {O['reels']}\n\n" + rlist(here))
        for src in sorted({x["source"] for x in items}):
            n = SOURCE_NAMES.get(src, src)
            put(V / "sources" / f"{_safe(n)}.md", {"type": "source"}, f"# {_t(n)}\n\n## {O['reels']}\n\n" + rlist([x for x in items if x["source"] == src]))
        for key, c in cols.items():
            put(V / "collections" / f"{_safe(c)}.md", {"type": "collection"}, f"# {_t(c)}\n\n## {O['reels']}\n\n" + rlist([x for x in items if any(ck(k) == key for k in x.get("collections", []))]))
        copied = 0
        for x in items:  # screenshots: copy only new or changed files
            for t in x.get("thumbs", []):
                src, dst = T / Path(t).name, V / "attachments" / Path(t).name
                if src.exists() and not (dst.exists() and filecmp.cmp(src, dst, shallow=False)):
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst); copied += 1
        gone = len(set(idx) - {x["id"] for x in items})
        print(f"obsidian: {len(items)} reels, screenshots copied: {copied}")
        gone and print(f"obsidian: {gone} note(s) of reels no longer in the database were left in {V / 'reels'} (not deleted)")
    print(f"obsidian: {V}: {stat['new']} new, {stat['updated']} updated, {stat['same']} unchanged")


def build():
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "ui")


if __name__ == "__main__":
    a = sys.argv[1:]
    ck = a[a.index("--cookies") + 1] if "--cookies" in a else None
    if a[:1] == ["fetch"]:
        fetch(a[1], ck)
    elif a[:1] == ["frames"]:
        frames(ck)
    elif a[:1] == ["enrich"]:
        enrich(force="--force" in a)
    elif a[:1] == ["keys"]:
        keys(force="--force" in a)
    elif a[:1] == ["condense"]:
        condense()
    elif a[:1] == ["places"]:
        places(force="--force" in a)
    elif a[:1] == ["cities"]:
        cities()
    elif a[:1] == ["geocode"]:
        geocode(force="--force" in a)
    elif a[:1] == ["saved"]:
        saved()
    elif a[:1] == ["tg-login"]:
        tg_login()
    elif a[:1] == ["migrate"]:
        migrate_source()
    elif a[:1] == ["tagmap"]:
        tagmap()
    elif a[:1] == ["obsidian"]:
        args = [i for i in a[1:] if not i.startswith("--")]
        obsidian(args[0], "--single" in a) if args else print("usage: python reels.py obsidian <vault folder> [--single]")
    elif a[:1] in ([], ["build"]):
        build()
    else:
        print(__doc__)
