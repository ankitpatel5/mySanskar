# Sanskar 🕉️

> *"Sanskar"* — Sanskrit for *a child listening* (to the divine).

A devotional companion app for BAPS parents to play kirtan and tell spiritual stories to their newborns and young children. Built as a mobile-first progressive web app (PWA) — add it to your home screen and it works like a native app.

**Live app → [baal-shravan.vercel.app](https://baal-shravan.vercel.app)**

---

## What it does

### 🎵 Devotional Music
Streams BAPS kirtan and bhajans directly from a curated Google Drive library. Songs are organized into albums (one folder = one album). The library refreshes automatically on every load so new kirtans appear without any app update.

### 📖 Story Time
A built-in story reader with 227 stories across three categories — sourced from [kids.baps.org](https://kids.baps.org/storytime):
- **Satsang Stories** (121) — stories from Swaminarayan Sampraday
- **Hindu Stories** (61) — tales from Hindu scriptures and mythology
- **Moral Stories** (45) — values-based stories for young children

Each story can be **read aloud** using built-in text-to-speech. A voice picker lets parents choose from all available voices on their device — on iOS, downloading an "Enhanced" voice from Settings gives near-natural quality.

### 👤 User Accounts & Sync
Sign in with Google to sync playlists across devices. Play history is tracked per user.

---

## Features

- **PWA / Add to Home Screen** — installs like a native app on iOS and Android; works offline for cached content
- **Mini player** — full playback controls (shuffle, prev, play/pause, next, loop, seek, ±15s skip) visible on the main screen without opening the full player
- **Playlists** — create, rename, delete, and share playlists via a link
- **Queue** — add any track to *Play next* or end of queue; persists across reloads
- **Search** — search across songs, albums, and stories
- **Media Session API** — lock-screen and Bluetooth controls (AirPods, car audio)
- **Dark / Light theme** — remembers your preference
- **No build step** — pure HTML, CSS, vanilla JS; ~60 KB app shell

---

## Tech stack

| Layer | Technology |
|---|---|
| Hosting | Vercel (static) |
| Auth & Database | Firebase Auth + Firestore |
| Music source | Google Drive (public folder, streamed via Drive API) |
| Stories | Static JSON generated from kids.baps.org (one-time crawl) |
| Text-to-speech | Web Speech API (device built-in, free) |
| PWA | `manifest.json` + Service Worker (cache-first shell, network-first HTML) |

---

## Setup (for your own deployment)

You'll need a **Google Drive API key** pointing to a public folder of MP3s.

### 1. Google Drive API key
1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → Create API key
2. Enable the **Google Drive API**
3. Restrict the key to your deploy domain (HTTP referrers) and to the Drive API only

### 2. Firebase project
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication** (Google sign-in provider)
3. Enable **Firestore** (start in production mode, apply `firestore.rules`)
4. Copy your config to `firebase-config.js`

### 3. Configure
Copy `config.example.js` to `config.js` and fill in your API key and Drive folder ID:
```js
window.DRIFT_CONFIG = {
  apiKey: 'YOUR_GOOGLE_DRIVE_API_KEY',
  folderId: 'YOUR_DRIVE_FOLDER_ID',
};
```
`config.js` is gitignored — never commit it.

### 4. Deploy
```bash
npx vercel --prod
```
Add the resulting domain to your API key's HTTP referrer restrictions.

---

## Drive folder structure

```
Your Drive folder/
├── Album Name/
│   ├── 01 - Song.mp3
│   └── 02 - Song.mp3
└── Loose song.mp3
```

Supported formats: `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`

---

## Refreshing stories

Stories are pre-crawled and bundled as `stories-data.js`. To refresh from kids.baps.org:

```bash
npm install          # installs cheerio
node scripts/crawl-stories.js
```

This regenerates `stories-data.js` with the latest stories.

---

## File layout

```
├── index.html          # all screens and markup
├── styles.css          # design system
├── app.js              # audio engine, UI, Firebase sync
├── stories-data.js     # pre-crawled story content (227 stories)
├── firebase-config.js  # Firebase project config (not secret)
├── config.js           # API key + folder ID (gitignored)
├── config.example.js   # template for config.js
├── sw.js               # service worker (PWA)
├── manifest.json       # PWA manifest
├── firestore.rules     # Firestore security rules
├── scripts/
│   └── crawl-stories.js  # one-time story crawler (Node + cheerio)
└── vercel.json
```

---

*Jay Swaminarayan 🙏*
