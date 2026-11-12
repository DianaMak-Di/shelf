"""English: LLM prompts, server messages, UI texts. A new language = a copy of this file (lang/<code>.py)."""
S = {
    "other": "other",  # fallback tag
    "kind_order": ["params", "recipe", "steps", "place", "takeaway"],
    "hidden_kinds": ["tip", "product"],
    "start": "Starting", "done": "Done",
    "steps": ["Collecting Telegram and TikTok saved items", "Downloading and transcribing speech", "Frames and on-screen text", "Titles, tags, summaries", "Place coordinates",
              "Key content", "General hashtags"],
    "prompt": """Below are the caption, the speech (transcript) and the on-screen text (OCR) of one video. Return ONLY JSON, no explanations:
{"title":"short title, 3-8 words","summary":"1 sentence in English, up to 110 characters: concrete details first (numbers, names, settings), no filler","category":"recipe|place|tip|product|tutorial|humor|music|other",
"hashtags":["4-6 tags"],"recipes":[{"name":"","ingredients":[],"steps":""}],"places":[{"name":"","city":"","country":"","address":""}],"products":[""],"tips":[""]}
Rules for hashtags: lowercase, no #, in English, one word or words joined by _,
broad recurring topics (for example: ai, 3d_printing, recipes, plants, work, design, music), not unique details.
For places: city and country from the video's context (speech, caption, on-screen text), in English in the usual spelling (Valencia, Spain); if unknown, leave an empty string.
address of a place: the street address or the official name of the object in the local language together with the city, as you would find it on a map, e.g. "Torre de la Cárcel, Segorbe"; take it from the caption, speech, on-screen text; for descriptive names ("the prison tower") give the known name of the object; if you do not know, leave an empty string.
Leave empty lists empty, invent nothing. Use both the speech and the on-screen text.

CAPTION: %s

SPEECH: %s

ON-SCREEN TEXT: %s""",
    "keyprompt": """Below are the caption, the speech and the on-screen text of one video. Extract the KEY content: what people save it for.
Return ONLY a JSON array of 1-3 objects {"kind":"...","text":"..."}.
kind: params | recipe | steps | place | takeaway (do not use tip or product; each kind at most once)
Rules: only concrete details from the video: numbers, settings with units (e.g. "Temperature 240°C"), ingredients with amounts,
names of places and products, the main tip in one sentence. A recipe is one object: ingredients separated by commas, then brief steps.
Each text up to 110 characters, specifics first, no filler or generic phrases. Invent nothing; if there are no specifics, give 1-2 objects with kind=takeaway.

CAPTION: %s

SPEECH: %s

ON-SCREEN TEXT: %s""",
    "condense": """Shorten the video description to exactly half, keeping the meaning. The summary must START with specifics (numbers, names, settings, products, places), not general words:
not "The author talks about settings" but the settings themselves. Halve the key texts too, do not change kind. Invent nothing.
Return ONLY JSON {"summary":"...","key":[{"kind":"...","text":"..."}]} with the same number of key items.

%s""",
    "tagprompt": """Here are hashtags from a personal collection of saved videos (tag: count).
Map EVERY tag to one general tag. There must be few general tags (at most %d in total), and they must be broad:
for example 3d_printing, ai, design, career, plants, recipes, music, tools, learning, lifehacks.
Existing general tags (prefer these): %s
Return ONLY a JSON object {"original_tag":"general_tag", ...} for all tags in the list.

TAGS: %s""",
    "placesprompt": """For each place from the video, give the city and country using the video's context (caption, speech, on-screen text), in English in the usual spelling (Valencia, Spain).
If unknown, leave an empty string, invent nothing. Return ONLY a JSON array of objects
{"name":"the name as is","city":"","country":"","address":"street address or official name in the local language together with the city, as found on a map; for descriptive names give the known name of the object; if unknown, an empty string"} in the same order and with the same number of items.

PLACES: %s

CAPTION: %s

SPEECH: %s

ON-SCREEN TEXT: %s""",
    "citiesprompt": """Below are city/country pairs from a personal collection of videos. Normalize every pair to one spelling in English:
city and country in the usual English form (Валенсия -> Valencia, Испания -> Spain), the same place is always written the same way.
Leave empty values empty, invent nothing. Return ONLY a JSON array of objects {"city":"","country":""}
in the same order and with the same number of items.

PAIRS: %s""",
    "obs": {  # Obsidian export (python shelf.py obsidian): section titles
        "key": "Key content", "caption": "Caption", "places": "Places", "transcript": "Transcript", "ocr": "On-screen text",
        "shots": "Screenshots", "tags": "Tags", "collections": "Collections", "reels": "Videos", "map": "map", "approx": "approximate",
    },
    "ui": {
        "title": "Shelf", "shown_of": "{n} of {m}",
        "sorts": {
            "saved": "Saved: newest first", "saved_old": "Saved: oldest first",
            "date": "Published: newest first", "date_old": "Published: oldest first",
            "likes": "Most likes", "views": "Most views", "short": "Shortest first",
            "long": "Longest first", "author": "Author A–Z", "title": "Title A–Z",
        },
        "sync": "Sync", "add_links": "Add links", "paste_links": "Paste links to videos (one per line):", "links_hint": "Instagram, TikTok, or a public Telegram post with a video (t.me/channel/123).", "links_skipped": "Links not recognized: {n}. Use Instagram, TikTok or t.me links.", "source": "Source", "all_sources": "All sources",
        "add_sync": "Add and sync ({n})", "sync_failed": "Sync failed: {e}. Try again.",
        "no_server": "no connection to the server", "tags": "Tags", "skip": "Skip to content",
        "close": "Close", "theme": "Theme", "theme_light": "Light", "theme_dark": "Dark", "theme_system": "System",
        "open_reel": "Open video", "open_reel_by": "Open video by @{a}", "collapse": "Collapse", "expand": "Show more",
        "search": "Search", "search_ph": "For example: pasta recipe", "sort": "Sort", "reset": "Clear filters",
        "load_failed": "Could not load videos. Check that server.py is running and try again.", "retry": "Retry",
        "loading": "Loading…", "nothing": "Nothing found.", "nothing_q": "Nothing found for “{q}”.",
        "empty": "No videos yet. Press “+” to add links.",
        "mode_reels": "Videos", "mode_places": "Places", "mode": "View",
        "ob_open": "Sources", "ob_title": "Connect your saved items",
        "ob_desc": "Sync will pick up videos and links from Telegram Saved Messages and your TikTok favorites. You can also do this later with the “Sources” button.",
        "ob_later": "Add later", "ob_done": "Done", "ob_sync_hint": "Press “Sync” to load what is new.", "ob_error": "That did not work: {e}",
        "tg_title": "Telegram Saved Messages", "tg_connected": "Connected: {u}", "tg_logout": "Disconnect",
        "tg_step1": "Open my.telegram.org and log in with your phone number.",
        "tg_step2": "API development tools → enter any App title and Short name → Create application.",
        "tg_step3": "Copy api_id and api_hash here, then enter your phone.",
        "tg_phone": "Phone", "tg_get_code": "Get code", "tg_code": "Login code",
        "tg_code_hint": "The code arrives in the Telegram app, in the “Telegram” chat, not by SMS.", "tg_sign_in": "Log in",
        "tg_password": "Two-step verification password", "tg_back": "Change number",
        "tg_privacy": "The login is kept only on this computer, in telegram.session. The phone, code and password are not stored.",
        "tt_title": "TikTok favorites", "tt_loaded": "Favorite videos: {n}",
        "tt_why": "TikTok does not give out favorites by a profile link, so it takes a data export from the app.",
        "tt_step1": "In TikTok: Profile → ☰ → Settings and privacy → Account → Download your data.",
        "tt_step2": "Choose the JSON format and request the data. TikTok takes from a few hours to a couple of days.",
        "tt_step3": "Download the archive and upload it here, no need to unzip.",
        "tt_upload": "Upload archive", "tt_replace": "Upload a newer export", "tt_uploading": "Uploading…",
        "obs_title": "Obsidian",
        "obs_desc": "The export creates notes in a subfolder of your vault. Edits outside the markers stay, notes are never deleted.",
        "obs_path": "Vault folder", "obs_export": "Export", "obs_exporting": "Exporting…",
        "obs_result": "Done: {n} new, {u} updated, {s} unchanged",
        "ob_path_err": "Enter the full path of an existing folder, for example ~/Documents/Vault/shelf.",
        "ob_busy": "A sync or an export is running. Wait and try again.",
        "no_city": "City not specified", "on_map": "Open in Google Maps", "no_coords": "Not on the map", "approx": "Approximate (city centre)", "places_empty": "No places yet.",
    },
}
