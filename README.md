# Shelf

Turn your saved Instagram, TikTok and Telegram videos into a searchable page: speech transcript, on-screen text (OCR), screenshots, an LLM summary, tags, key content, and a **Places** view that groups every place mentioned in your videos by city and shows them on a map.

Everything runs locally. English | [Русский](README.ru.md)

## Important

- Downloading videos, especially with your browser cookies, may violate the terms of Instagram, TikTok and Telegram and can get your account restricted. Use it at your own risk, only for your own saved videos.
- Cookies are read locally by `yt-dlp` (`--cookies-from-browser`). This tool never sends them anywhere.
- Video text (caption, speech, on-screen text) is sent to the LLM provider you configure. With a local model (Ollama, LM Studio) nothing leaves your machine.
- Names of places are sent to Nominatim (OpenStreetMap) to find coordinates for the map, and the map loads tiles from openstreetmap.org.
- The first search downloads a small multilingual model (`paraphrase-multilingual-MiniLM-L12-v2`) from Hugging Face. After that, search runs locally.

## Requirements

macOS only (OCR uses Apple Vision through `ocrmac`), Python 3.11–3.13 (newer versions lack `onnxruntime` wheels), Node.js, ffmpeg, and one LLM: the `claude` CLI (default), an Anthropic API key, or any OpenAI-compatible endpoint.

## Setup

```bash
git clone https://github.com/DianaMak-Di/shelf.git && cd shelf
./setup.sh
.venv/bin/python server.py   # http://localhost:8765
```

Add videos in the UI with "+" (paste links, one per line), or put links into `urls.txt`, then press Sync. To use browser cookies for the download step, run `python shelf.py fetch urls.txt --cookies chrome` once by hand.

## Sources

The source is detected from the link. Cards show a source badge, and a source filter appears once you have more than one source.

- **Instagram**: `instagram.com/reel/…`, `instagram.com/p/…`. Some videos need cookies (`--cookies chrome`).
- **TikTok**: `tiktok.com/@author/video/…`, short `vm.tiktok.com/…` links. Public videos download without cookies. TikTok blocks some posts by IP or region; those are skipped with `FAIL`.
- **Telegram**: public channel posts with a video, `t.me/channel/123`. Posts without a video (text or photos only) are skipped. Private channels (`t.me/c/…`) are not supported.
- Videos older than a year are skipped (as before).

### Saved items (Telegram Saved Messages, TikTok favorites)

Sync starts with `python shelf.py saved`, which adds new saved items to `urls.txt`. Connect both in the UI: the **Sources** window opens by itself on the first start (each source has an **Add later** button) and stays one click away in the header.

- **Telegram Saved Messages**: videos and every Instagram, TikTok or `t.me` link you saved there in the last year. Log in once: in **Sources**, or in a terminal with `.venv/bin/python shelf.py tg-login`. You need `api_id` and `api_hash` (create an app at my.telegram.org → API development tools; they go to `config.json`), then your phone, the login code and your 2FA password, if you have one. Your login is saved in `telegram.session` in this folder. Anyone with this file can use your Telegram account, so never share or commit it (it is in `.gitignore`). To log out, press **Disconnect** in **Sources**, or end the session in Telegram → Settings → Devices and delete the file. Only messages newer than the last sync are read (`saved_state.json`). A video from Saved Messages opens the original channel post when it was forwarded from a public channel, otherwise the message in the Telegram app (`tg://`).
- **TikTok favorites**: a profile link is not enough. TikTok does not give out the favorites list to anyone outside the app (even when favorites are shown on the profile), and yt-dlp cannot list them. Request your data in TikTok (Profile → ☰ → Settings and privacy → Account → Download your data, format JSON) and upload the archive in **Sources**, or unzip it and put `user_data_tiktok.json` into this folder. Every sync picks up the links from it. For newer favorites, upload a fresh export.

Videos saved before sources existed get `source=instagram` with `python shelf.py migrate` (once; without it the UI treats them as Instagram).

Optional `collections.json` (see `collections.example.json`) maps collection names to video shortcodes. Collection names become the primary hashtags.

## Configuration

Copy `config.example.json` to `config.json` (`setup.sh` does it). Without a file you get Russian and the `claude` CLI.

```json
{
  "language": "en",
  "llm": { "provider": "openai", "base_url": "http://localhost:11434/v1", "strong": "llama3.1:70b", "fast": "llama3.1:8b" }
}
```

- `language`: `ru` or `en`. Sets the UI, server messages, prompts, and the language of summaries and tags. Transcripts and on-screen text stay in the original language. To add a language, copy `lang/en.py` to `lang/<code>.py`.
- `provider`: `claude-cli` (default), `anthropic` (key in `ANTHROPIC_API_KEY`), or `openai` (any OpenAI-compatible endpoint; key in `OPENAI_API_KEY`, optional for local servers). Use `api_key_env` to read the key from another variable.
- `strong` / `fast`: the model for heavy steps (key content, tags) and light steps (summaries, condensing).
- If an answer cannot be parsed, the call is retried right away: `fast` -> `strong` -> `strong` (`strong` x3 for strong steps). If all fail, the video is skipped and retried on the next sync.
- Changing the provider only affects new videos. Existing summaries and tags stay as they are.

## Export to Obsidian

```bash
python shelf.py obsidian ~/Documents/MyVault/shelf
```

Writes Markdown into the folder you give: a note per video in `videos/`, pages for cities in `places/`, for sources in `sources/` and for collections in `collections/`, and screenshots in `attachments/`. Export into a subfolder of your vault, not its root. With `--single` you get one `all.md` with every video: no hubs, no screenshots.

Run it again any time. Only the block between `%% shelf:start %%` and `%% shelf:end %%` and the properties the tool owns are rewritten. Your text outside the block and your own properties stay. The tags the tool generates go to `shelf_tags` and into `tags`; tags you added to `tags` are kept. Nothing is deleted: notes of videos that left the database stay where they are. You can rename a note or move it within `videos/`. A note moved out of `videos/` is treated as gone, and the export creates it again.

## Commands

```
python shelf.py saved                               # new items from Telegram Saved Messages and the TikTok export -> urls.txt
python shelf.py tg-login                            # once: log in to Telegram
python shelf.py fetch urls.txt [--cookies chrome]   # audio, caption, speech transcript (Instagram, TikTok, t.me)
python shelf.py migrate                             # once: add source to older videos
python shelf.py frames                              # screenshots and on-screen text
python shelf.py enrich                              # title, summary, hashtags, places...
python shelf.py keys                                # key content
python shelf.py tagmap                              # squash hashtags into ~20 general ones
python shelf.py places                              # once: add city/country to places of older videos
python shelf.py cities                              # once: unify spelling of cities/countries in the main language
python shelf.py geocode [--force]                   # coordinates for the map (Nominatim, 1 request/s)
python shelf.py build                               # build the UI
python shelf.py obsidian <vault folder> [--single]   # export to Markdown for Obsidian
python test_llm.py                                  # self-check for retries and config
python test_sources.py                              # self-check: link -> source and id
```

## License

MIT
