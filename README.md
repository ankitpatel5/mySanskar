# Drift — minimal music player for a public Google Drive folder

A static, mobile-first web app that streams MP3s from a public Google Drive folder organized into sub-folders (each sub-folder becomes an "album"). Dark Spotify-inspired UI. Playlists persist in `localStorage`. Always pulls the latest folder contents on load.

## Features

- **Auto-discovery** — every public sub-folder under your root folder becomes an album. Loose files in the root appear as "Loose tracks". One additional nested level is also crawled.
- **Always fresh** — on every load the app re-fetches the folder index from Drive. A cached copy renders instantly while the refresh runs in the background.
- **Playlists** — create, rename, delete. Persisted in browser storage per device.
- **Queue** — add any track to *Play next* or to the end of the queue. The queue persists across reloads.
- **Loop track** — toggle on the expanded player, or with the `L` key.
- **Shuffle** — within an album or playlist.
- **Search** — substring match across track and album names.
- **Mobile-first** — bottom tab bar, swipe-down player sheet, lock-screen / Bluetooth controls via Media Session API.
- **Keyboard** — Space = play/pause, Shift + ← / → = prev/next, L = loop, S = shuffle, Esc = close player.

## Setup

You need a **Google Drive API key**. Your folder is already shared as "Anyone with the link can view", which is required.

### 1. Create an API key

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create or select a project.
3. Enable the **Google Drive API** (APIs & Services → Library → "Google Drive API" → Enable).
4. Credentials → **Create credentials** → **API key**.
5. **Restrict the key** (important — see security note below):
   - **API restrictions** → restrict to *Google Drive API* only.
   - **Application restrictions** → *HTTP referrers* → add your deploy URLs, for example:
     - `https://your-site.vercel.app/*`
     - `https://your-site.netlify.app/*`
     - `http://localhost:*/*` (for local dev)

### 2. Configure the app

Open `config.js` and either:

**Option A — Hard-code the key (simplest for personal deploys):**
```js
window.DRIFT_CONFIG = {
  apiKey: 'YOUR_API_KEY_HERE',
  folderId: '1ob4gWC7yU4sWBnksReqVNRZk_N732BR-',
};
```

**Option B — Leave blank; users enter it themselves on first load:**
```js
window.DRIFT_CONFIG = { apiKey: '', folderId: '' };
```
A setup screen appears, and the values are saved to localStorage.

> **Security note.** A client-side API key is safe to ship *if and only if* you restricted it to your domain via HTTP referrer in step 5. Otherwise anyone can scrape it and burn your quota.

## Deploy

### Vercel

```bash
npm i -g vercel
vercel deploy --prod
```

`vercel.json` is preconfigured. After deploy, add the resulting domain (e.g. `https://drift-xyz.vercel.app/*`) to your API key's referrer restrictions.

### Netlify

Drag-and-drop the project folder onto [app.netlify.com/drop](https://app.netlify.com/drop), or:

```bash
npm i -g netlify-cli
netlify deploy --prod --dir=.
```

### Local / self-hosted

It's a static site. Any HTTP server works:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080`. **Don't** open `index.html` directly via `file://` — the Drive API call needs an `http(s)://` origin.

## Folder structure expected

```
Your Drive folder/
├── Album 1/
│   ├── 01 - Track.mp3
│   ├── 02 - Track.mp3
│   └── ...
├── Album 2/
│   └── ...
└── Loose song.mp3   ← grouped under "Loose tracks"
```

Supported formats: `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac` (browser support varies; mp3 is universal).

## How streaming works

Files are streamed directly from `https://drive.google.com/uc?export=download&id={FILE_ID}`. This is the standard public-file streaming endpoint; it supports HTTP range requests, so audio scrubbing works.

## Caveats

- **Quota** — the free Google Drive API tier allows 1 billion requests/day per project, so a single user won't realistically hit it. Each library refresh costs roughly `1 + (number of subfolders)` API calls.
- **Drive virus-scan page** — Drive shows an interstitial "can't scan for viruses" page for files >100 MB, which blocks direct streaming. MP3s are usually well under that.
- **Per-device playlists** — since the folder is public and there's no per-user login, playlists are stored per-device in `localStorage`. Use the same browser to keep them.
- **First load** — initial library build does N+1 API calls (one for the root, one per subfolder). For a few hundred subfolders this is still under a second. Subsequent loads use the cached tree and refresh in the background.
- **Files outside the folder won't appear** — only files inside your root folder (and one level deeper) are listed.

## File layout

```
.
├── index.html       # markup & screens
├── styles.css       # full design system
├── app.js           # Drive client + audio engine + UI controller
├── config.js        # your API key & folder ID
├── vercel.json      # Vercel headers
├── netlify.toml     # Netlify headers
└── README.md
```

No build step. No dependencies. Around 60 KB total.

## License

MIT — yours to fork and modify.
