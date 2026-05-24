# mySanskar 🪔

> *Rooted in Bhakti*

A devotional companion app for BAPS parents — play kirtan and tell spiritual stories to their children. Built as a mobile-first progressive web app (PWA): add it to your home screen and it works like a native app, no App Store required.

**Live app → [baal-shravan.vercel.app](https://baal-shravan.vercel.app)**

---

## How It's Built

**[→ View the System Design Diagram](https://htmlpreview.github.io/?https://github.com/ankitpatel5/mySanskar/blob/main/system-design.html)**

A visual overview of how all the pieces fit together — the PWA shell, Firebase, Google Drive, Gemini AI, static data bundles, and Vercel hosting.

---

## What it does

### 🎵 Devotional Music
Streams BAPS kirtan and bhajans directly from a curated Google Drive library. Songs are organized into albums (one folder = one album). The library refreshes automatically on every load so new kirtans appear without any app update.

### 📖 Story Time
A built-in story reader with 256 stories across three categories — sourced from [kids.baps.org](https://kids.baps.org/storytime):
- **Satsang Stories** — stories from Swaminarayan Sampraday
- **Hindu Stories** — tales from Hindu scriptures and mythology
- **Moral Stories** — values-based stories for young children

Stories are pre-translated into **Gujarati** and **Transliteration** and bundled as static files — no API call needed to read in any language. Stories can be read aloud using built-in text-to-speech (English only).

### ✨ AI Story Generator
Generate custom BAPS-themed children's stories using Gemini 2.5 Flash. Choose a moral/theme, main character, and length. Add a child profile in Settings and stories are personalized to them automatically.

### 👤 User Accounts & Sync
Sign in with Google to sync playlists and story progress across devices.

---

## Features

- **PWA / Add to Home Screen** — installs like a native app on iOS and Android; works offline for cached content
- **3-tab navigation** — Home (coming soon), Music (Library / Playlists / Queue), Stories
- **Mini player** — full playback controls (shuffle, prev, play/pause, next, loop, seek, ±15s skip)
- **Playlists** — create, rename, delete, and share playlists via a link
- **Queue** — add any track to *Play next* or end of queue; persists across reloads
- **Story language toggle** — switch the story list between English and Gujarati; stories open in your preferred language
- **Child profile** — save your child's name, gender, and date of birth; AI stories are personalized automatically
- **Search** — search across songs, albums, and stories
- **Media Session API** — lock-screen and Bluetooth controls (AirPods, car audio)
- **Dark / Light theme** — remembers your preference
- **No build step** — pure HTML, CSS, vanilla JS

---

## Tech stack

| Layer | Technology |
|---|---|
| Hosting | Vercel (static CDN) |
| Auth & Database | Firebase Auth + Firestore |
| Music source | Google Drive (streamed via Drive API v3) |
| Stories | Pre-bundled static JS (`stories-data.js`, 256 stories) |
| Translations | Pre-generated Gujarati + Transliteration bundles (`translations-data.js`, `title-translations.js`) |
| AI stories | Gemini 2.5 Flash API |
| Text-to-speech | Web Speech API (device built-in, English only) |
| PWA | `manifest.json` + Service Worker (cache-first shell, network-first HTML) |

---

## Setup (for your own deployment)

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
Copy `config.example.js` to `config.js` and fill in your keys:
```js
window.DRIFT_CONFIG = {
  apiKey: 'YOUR_GOOGLE_DRIVE_API_KEY',
  folderId: 'YOUR_DRIVE_FOLDER_ID',
  geminiKey: 'YOUR_GEMINI_API_KEY',
};
```
`config.js` is gitignored — never commit it. Vercel picks it up via `.vercelignore`.

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

## File layout

```
├── index.html              # all screens and markup
├── styles.css              # design system
├── app.js                  # all app logic (~3,600 lines)
├── stories-data.js         # pre-crawled story content (256 stories)
├── translations-data.js    # Gujarati + transliteration story bodies
├── title-translations.js   # story title translations (256 titles)
├── firebase-config.js      # Firebase project config (not secret)
├── config.js               # API keys (gitignored, Vercel-only)
├── config.example.js       # template for config.js
├── sw.js                   # service worker (PWA, cache-first)
├── manifest.json           # PWA manifest
├── icons/                  # app icons (192px, 512px, maskable)
├── firestore.rules         # Firestore security rules
├── system-design.html      # system architecture diagram
├── scripts/
│   ├── crawl-stories.js          # story crawler (Node + cheerio)
│   ├── generate-translations.js  # generates translations-data.js
│   └── generate-title-translations.js  # generates title-translations.js
└── vercel.json
```

---

*Jay Swaminarayan 🙏*
