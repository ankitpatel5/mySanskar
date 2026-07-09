# mySanskar — Claude Notes

**Maintenance rule (for Claude): this file is the project's memory across sessions.**
Whenever a feature ships, a key decision is made, a pipeline changes, or a gotcha is
discovered, UPDATE the relevant section here in the same session — don't wait to be
asked. Keep it curated and terse: current state + decisions, not a changelog.

## What this is
Kids' devotional app ("raising little ones with faith & values") for Gujarati/Hindu
(BAPS-leaning) families: devotional music, curated + AI stories, Learn Gujarati,
Ekadashi calendar/reminders, conversation starters, audiobooks (parents).

- **Stack**: vanilla JS single-page app — `app.js` (~8k lines, one IIFE), `index.html`,
  `styles.css`. No framework, no build step (deliberate). Capacitor 8 wraps it for
  iOS/Android. Firebase (auth + Firestore, project `baal-shravan`), Gemini 2.5 Flash
  for AI stories (key in gitignored `config.js`), Google Drive as media backend,
  Vercel for hosting + serverless (`api/ekadashi.js` scrapes BAPS calendar).
- **Owner/admin**: ankitpatel5@gmail.com (`ADMIN_EMAIL` in app.js; admin dashboard
  behind `admin-btn`; Firestore rules gate on this email).
- Team JSWDSX636T · bundle `com.ankitpatel5.mysanskar` · iOS deploy target 15.0.
- Ankit's iPhone 16 Pro Max UDID: `63EB7EB3-DB91-5E5C-89D3-9D83B48E9A2F`.

## Deploy Flow — Always Follow This Order

### Step 1 — After every new feature or bug fix, deploy to staging first:
```bash
npm run deploy:staging
```
This pushes the current local code to **mysanskar-staging.vercel.app** for testing.
Always do this automatically after making changes — don't wait to be asked.
(Staging `/api/*` is behind Vercel SSO for anonymous curl — test in browser; prod is public.)

### Step 2 — Only when the user explicitly says "push to prod" / "ship it" / "deploy to production":
```bash
npm run ship
```
This does everything:
1. `bash scripts/ship-commit.sh` — auto-commits any pending working-tree changes
   (Vercel deploys the working tree, but `git push` only moves committed work — without
   this, prod updates while git stays frozen. Override the message with
   `npm run ship --m="your message"`; defaults to a timestamp.)
2. `git push origin staging` — pushes staging to GitHub
3. Fast-forwards `main` to match staging
4. `git push origin main` — pushes main to GitHub
5. `npx vercel --prod` — deploys to mysanskar.vercel.app
6. `npm run build:ios` / `build:android` — syncs web assets into the native projects

**Never skip staging. Never push straight to prod without the user's explicit go-ahead.**

**Ship-chain gotcha (hit 2026-07-08):** the `&&`-chain can die mid-way at
`git checkout staging` on a transient `.git/index.lock` — pushes succeed but
`vercel --prod` + native builds never run, and the pipe through `tail` hides the
failure (exit 0). If ship output ends with an index.lock error: verify branch,
`git checkout staging`, then run `npx vercel --prod && npm run build:ios &&
npm run build:android` manually and verify prod sw.js got the new sha stamp.

### Service-worker cache (web users)
`sw.js` is CACHE-FIRST for all shell assets keyed on `const CACHE = 'sanskar-…'`.
**Now auto-stamped on every Vercel deploy** (scripts/generate-config.js rewrites it
from VERCEL_GIT_COMMIT_SHA) — discovered 2026-07-07 that it sat un-bumped at v79
while multiple ships went out, leaving returning web/PWA users on stale assets.
Native apps are unaffected (no SW in WKWebView). If testing web changes in the
local preview and they don't appear: unregister the SW + clear CacheStorage.

### Firestore rules
Edit `firestore.rules`, then deploy with
`npx firebase-tools deploy --only firestore:rules --project baal-shravan`
(cached CLI login on this Mac works — no interactive auth needed).

## iOS & Android Build Notes

- Both the iOS (Xcode) and Android (Android Studio) apps have their **own copy** of the web assets
  - iOS: `ios/App/App/public/`
  - Android: `android/app/src/main/assets/public/`
- Vercel deployments do NOT update these folders — they are completely separate
- `npm run build:ios` and `npm run build:android` each run `build-www.sh` then `npx cap sync <platform>`
- Both are **automatically included** in `npm run ship`, so every prod deploy keeps both native projects in sync
- **Stale-www gotcha**: `npx cap sync ios` copies `www/` AS-IS — after editing
  app.js/index.html/styles.css you MUST run `npm run build:ios` (build-www + sync)
  or the native app ships stale assets (this caused the "empty Nitya widget" bug).

## Google Play release (Android) — prepped 2026-07-09 for UNLISTED production
- **Signing** already set up: upload keystore `~/mysanskar-release.jks`, gitignored
  `android/keystore.properties` (alias `mysanskar`). Build the store bundle:
  `cd android && JAVA_HOME=<AS jbr> ./gradlew bundleRelease`
  → `android/app/build/outputs/bundle/release/app-release.aab` (signed; `jar verified`).
  On first Play upload opt into **Play App Signing** (upload key becomes resettable).
- **Version**: build.gradle `versionName` kept in lockstep with iOS (now 1.5);
  `versionCode` is the monotonic int (now 1, +1 each upload). `build:android` now runs
  `scripts/stamp-android-version.js` after cap sync so the Android bundle's app-build.js
  reports the ANDROID version (not iOS's) — fixes the update-banner version-stamp gap.
- **android.latest** in app-version-defaults.json is MANUAL (no Play version API) — bump
  it per Play release; that's what fires the Android in-app update banner.
- **Listing kit** (copy, data-safety answers, unlisted steps, asset paths):
  `~/Desktop/appstore-shots/PLAY_LISTING.md`. Feature graphic (1024×500):
  `~/Desktop/appstore-shots/play-feature-graphic.{html,png}`. Icon: `icons/icon-512.png`.
  Screenshots: reuse `out-69/` (1320×2868). Privacy policy already live at /privacy.
- **Target audience = adults (parents)**, NOT Designed-for-Families (parent Audiobooks
  shelf has adult titles). Ekadashi + update-banner verified working on Android.

## Android CLI build + emulator (verified working 2026-07-09)
- **No Java on PATH** — Gradle needs JAVA_HOME. Use Android Studio's bundled JBR:
  `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` (JDK 21).
- **Build debug APK**: `npm run build:android` (build-www + cap sync — re-stamps
  app-build.js from iOS MARKETING_VERSION, so it reads 1.5 even though the Android
  package version is separate) then `cd android && ./gradlew assembleDebug`
  → `android/app/build/outputs/apk/debug/app-debug.apk`.
- **Emulator**: SDK at `~/Library/Android/sdk`; one AVD `Pixel_10`. Boot:
  `~/Library/Android/sdk/emulator/emulator -avd Pixel_10 -no-snapshot-load`.
  Wait for boot: `until [ "$(adb shell getprop sys.boot_completed|tr -d '\r')" = 1 ]`.
  Install/launch: `adb -s emulator-5554 install -r <apk>` then
  `adb -s emulator-5554 shell monkey -p com.ankit.mysanskar -c android.intent.category.LAUNCHER 1`.
  (A phantom `emulator-5556 offline` entry may appear — harmless; target 5554 with `-s`.)
- **Android package** `com.ankit.mysanskar`; build.gradle versionName/Code are still
  the template `1.0`/`1` — bump before any Play Store submission (in-app "Version"
  shows the iOS-derived 1.5(1) from app-build.js, which is display-only).
- **Screenshots via adb**: `adb -s emulator-5554 exec-out screencap -p > out.png`.

## iOS native builds — ALWAYS verify the bundle (don't trust incremental builds)

`npm run build:ios` correctly syncs `www/` → `ios/App/App/public/`, BUT a subsequent
`xcodebuild` with an existing `-derivedDataPath` can do an **incremental build that does
NOT re-copy the updated `public/` resources** — so the installed `.app` ships STALE web
assets (old `sw.js` cache version, missing new files) even though the install "succeeds".
This silently shipped a build with no Learn Gujarati feature once.

**Rule — before installing any device build, verify the actual `.app` bundle:**
```bash
APP="ios/App/build/Build/Products/Debug-iphoneos/App.app"   # or wherever -derivedDataPath points
grep -m1 "CACHE =" "$APP/public/sw.js"        # must equal the current sw.js cache version
ls "$APP/public/<any-new-file>.js"            # new feature files must be PRESENT
```
If the bundle is stale: `rm -rf ios/App/build` then `xcodebuild clean …` and full rebuild.
Never tell the user "installed" until the bundle is verified to contain the expected assets.

## iOS CLI pipeline (no Xcode GUI needed — all verified working)

- **Device build + install**:
  ```bash
  cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -destination 'generic/platform=iOS' -derivedDataPath ./build \
    -allowProvisioningUpdates build
  xcrun devicectl device install app --device <UDID> build/Build/Products/Debug-iphoneos/App.app
  xcrun devicectl device process launch --device <UDID> com.ankitpatel5.mysanskar
  ```
  Phone must be unlocked (errors 12040/FBSOpen = locked). Reuse `./build` derived
  data or SPM resolution appears to hang. Run long builds in background with file logging.
- **Simulator**: same but `-destination 'platform=iOS Simulator,id=<sim-udid>'`
  `-derivedDataPath ./build-sim`; install/launch via `simctl`. **Live JS/bridge console**:
  `xcrun simctl launch --console-pty <udid> com.ankitpatel5.mysanskar` (⚡️-prefixed
  Capacitor lines — the way to debug auth/JS issues in the sim).
- **Xcode project surgery** (targets, files, build settings): script it with the ruby
  `xcodeproj` gem (`gem install --user-install xcodeproj`; parses objectVersion 60).
  The whole NityaWidget extension target was created this way.
  `-allowProvisioningUpdates` auto-registers new bundle IDs and App Groups.
- **App-local Capacitor plugins**: register in `ViewController.capacitorDidLoad` via
  `bridge?.registerPluginInstance(...)`. In plugin Swift, cast bridged JS array
  elements to `[String: Any]`, never `JSObject` (silently fails).

## iOS App Store Submission — Checklist (do this EVERY time the user mentions building/archiving for iOS app review)

When the user says anything like "build for iOS submission", "archive for App Store", "submit for review", or "generate an iOS build for approval", ALWAYS walk through this:

1. **Bump the build number** (and version if it's a new release) in `ios/App/App.xcodeproj/project.pbxproj`:
   - `CURRENT_PROJECT_VERSION` (build number) — must increase every upload, even for the same version. App Store Connect rejects duplicate build numbers.
   - `MARKETING_VERSION` — bump only for a new user-facing version (e.g. 1.3 → 1.4). ASC rejects re-used marketing versions once approved ("train closed").
   - **Bump BOTH targets (App + NityaWidget) in lockstep** — App Store requires
     extension/app version parity, and `build-www.sh` greps the first match for the
     in-app version stamp (it warns loudly on drift). Use the ruby xcodeproj gem.
2. **Re-sync assets**: `npm run build:ios` — this also re-stamps `app-build.js` (the in-app version display reads `window.APP_BUILD`, auto-derived from `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`).
3. **Archive + upload (CLI works end-to-end)**:
   ```bash
   cd ios/App
   xcodebuild -project App.xcodeproj -scheme App -configuration Release \
     -destination 'generic/platform=iOS' archive -archivePath ./build/App.xcarchive \
     -allowProvisioningUpdates
   xcodebuild -exportArchive -archivePath ./build/App.xcarchive \
     -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
   ```
   (`ExportOptions.plist`: method app-store-connect, destination upload — uploads
   directly using the Xcode-signed-in Apple ID.)
4. **Verify the archive includes the latest** — confirm the bundled `sw.js` cache version + feature markers.
5. **Commit the version bump** to git (rides the next ship).
6. **Remind about the update manifest** (see below).

### Update-available banner — SELF-UPDATING for iOS (since 2026-07-07)
- The app fetches **https://mysanskar.vercel.app/app-version.json**, which is now a
  Vercel **rewrite → `api/app-version.js`**: the function looks up the LIVE App Store
  version via the iTunes Lookup API (`itunes.apple.com/lookup?id=6774448007`) and
  serves it as `ios.latest` (CDN-cached 30 min). **No manual bump needed for iOS** —
  when a release goes live on the App Store, every installed app sees the banner
  within ~30 min, including old clients (same URL they always fetched).
- `app-version-defaults.json` (repo root) = fallback values + Android (`latest` there
  is still MANUAL — bump it when a Play Store release goes live) + `min` + appStoreId.
- iOS deep link uses `appStoreId` `6774448007` (unlisted app). Android uses package `com.ankit.mysanskar`.
- Release cadence now: submit build → (review) → live → banner appears automatically.
  Only remaining manual step is Android's `latest` in `app-version-defaults.json`.
- **Update manifest — ROOT CAUSE of the "no iOS banner" bug (found 2026-07-09)**:
  Apple's iTunes Lookup API is edge-cached PER REGION and lags. From Vercel's `iad1`
  region the lookup returned a stale **1.4** for a day+ after 1.5 went live (local
  lookups returned 1.5). The old `api/app-version.js` did `ios.latest = live`
  unconditionally, so it served that stale 1.4 → 1.4 users saw "you're on latest", no
  banner. FIX: the function now takes `max(fallback, live)` via cmpVersion — a stale
  lookup can't lower it below the fallback, a genuinely newer release still wins. So you
  MUST keep `app-version-defaults.json` ios.latest == the live version each release
  (it's the floor). Diagnose anytime with `/app-version.json?debug=1` → shows
  `{fallback, live, chosen, region}`. (Verified: chosen=1.5 while live still 1.4.)
- **Android upgrade tile VERIFIED end-to-end 2026-07-09**: built a 1.4 debug APK, and
  with prod android.latest=1.5 the tile appeared organically ("Version 1.5 is ready",
  no DOM hack), and "Update" opened the Play Store (com.android.vending) via
  market://details?id=com.ankit.mysanskar (shows "Item not found" until published).

## Feature map (find things in app.js by function name, not line number)
- **Nitya home-screen widget**: `nityaSyncToWidget` / `playNityaFromWidget`; native
  `App/NityaWidgetPlugin.swift` + `NityaWidget/NityaWidget.swift` (WidgetKit target);
  App Group `group.com.ankitpatel5.mysanskar`, key `nitya.items`; deep link
  `mysanskar://nitya/play?id=<trackId>` (Link-based, iOS 15+, opens app + plays).
  Setup record: `ios/App/NITYA_WIDGET_SETUP.md`.
- **Ekadashi**: `getEkadashiList` (localStorage key `drift.ekadashiCache.v2`, 6h TTL —
  bump suffix when API payload shape/window changes), Home tile + `openEkadashiSheet`
  (bottom sheet: full remaining year, month groups, Nirjala badge, next-up hero).
  `api/ekadashi.js` scrapes current month→December in parallel.
  **Reminders**: `syncEkadashiReminders` — @capacitor/local-notifications, 9:00 AM
  local, N days before (`drift.ekRemind`/`drift.ekRemindDays`, default 1), IDs 618000+,
  title format: "Tomorrow (Jul 11) is Yogini Ekadashi (Regular Fast)", empty body.
- **Sleep timer (shared music+audiobook)**: `setSleep` / `sleepCountdownTick` —
  wall-clock countdown + 15s volume fade (`SLEEP_FADE_MS`); 'eoc' = end of current
  track/chapter; UI hooks `.js-sleep-btn` / `.js-sleep-sheet`.
- **Music player**: tri-state repeat `state.repeat` off→all→one (saffron "1" badge,
  `REPEAT_CYCLE`); NEVER use native `audio.loop` (breaks ended-event logic).
- **Audiobooks**: `abBookProgress` estimates whole-book % via average chapter duration;
  linear progress bars only (rings removed by design); transport prev·−30s·play·+30s·next
  with speed+sleep accessory row.
  **Covers** (`abCoverUrl` / `__abCoverFallback`): primary = lh3 CDN
  `lh3.googleusercontent.com/d/<fileId>=w400` (direct, fast); on error → retry via
  `drive.google.com/thumbnail?id=<id>&sz=w400` → then gradient placeholder. Fixes
  broken-image icons from Drive's /thumbnail throttling a cold burst of ~31 covers.
  NEVER leave a Drive `<img>` without an onerror fallback.
- **AI stories**: `buildStoryPrompt` — LANGUAGE RULES block targets 3–4-year-old
  vocabulary (short sentences, everyday words, sounds/repetition, no abstractions).
  Bump `STORY_PROMPT_VERSION` on material prompt changes → cached Stories of the Day
  regenerate same-day for all users (Firestore doc gated on `promptVersion`).
  `saveAIStory(story, {overwrite:true})` replaces same-id copies.
  Cultural hard rules: family terms Mummy/Pappa/Baa/Dada only; NEVER "Bapa" for a
  parent (sacred, Guru-only); no garden/seed metaphors.
- **Learn Gujarati**: `renderGujHero` (guest-locked: dimmed + lock icon + toast —
  same pattern as locked story cards), hub `openGujHub`, progress `_gujProgress`.
  Featured in onboarding (card 3) + guest benefits list (locked group, first).
- **Guest gating pattern**: `isGuestMode()` + `.story-cat-lock-badge` + benefit-copy
  sub + toast. Free for guests: music, 10 sample stories/category, Ekadashi calendar.
- **Feedback pipeline**: Settings "Suggest a feature" → `feedback` collection
  ({text, uid, email, displayName, createdAt, read:false}; rules: signed-in create
  own-uid only, admin-only read/manage) → admin dashboard Feedback tab
  (`loadAdminFeedback`, mark read/unread) + admin-only Home tile
  (`renderAdminFeedbackTile`, count of read==false).
- **Eternal Virtues (daily prasang)**: master content = `eternal-virtues.md`
  (208 true prasangs across 21 virtues from "Eternal Virtues" book; format
  `## Virtue · English · Gujarati` + `### Title` + 4–7 sentence story; NO source
  field by design — the tile name references the book; Kirtihi·Manaha chapter
  skipped = testimonial quotes only). Publish: `node scripts/build-eternal-virtues.js`
  (parses MD, interleaves round-robin across virtues, uploads → Firestore doc
  `content/eternalVirtues` {version,count,updatedAt,json}; auth = firebase-tools
  cached token, same pattern as prerender-tts.js; `--dry-run` for stats).
  Client: `loadEternalVirtueTile` / `renderVirtueTile` / `openVirtueSheet` in app.js —
  localStorage cache `drift.eternalVirtues.v1` (~3-day re-fetch), day index =
  local-calendar `daysSinceEpoch % count` so every user sees the same snippet on
  the same date. Rules: `/content/{docId}` public read, admin write. NOTE: ANY republish
  that changes the count remaps `day % count` for everyone (append-only included);
  clients re-fetch daily so they converge within ~a day — keep republishes rare.
- **Settings**: reference-style redesign — `.settings-chip` color chips
  (rose=child/stories, violet=night/vrat, saffron=core, green=storage, teal=learn),
  account card + separate CHILD section, "Share the sanskar" group
  (`settings-share-app` → navigator.share of mysanskar.vercel.app). Child age shows
  "Under 1" below 12 months (`childSummaryText`).

## Design system
- Tokens in `styles.css :root`: `--accent` saffron #e8a33d (light theme #b26b12);
  `--success` #4caf68 family — ONE green for every done/completed state (light #2e7d32);
  `--learn*` teal family — intentional Learn Gujarati sub-brand; `--danger`.
  **Never hardcode greens/teals — route through tokens.**
- Tile color identity: Ekadashi=violet, story=rose, Nitya/devotion=saffron, learn=teal, Eternal Virtue=gold (#262012 bg / #e3c88a icon).
- Fonts: Fraunces (`--font-display`) + Inter (`--font-ui`).
- Sheets: `.modal` + `.modal-backdrop` + `.modal-sheet`. The sheet itself is the ONE
  scroller (max-height + overflow-y) with a sticky header — nested scrollers break
  iOS WKWebView touch scrolling, and Safari mislays out flex children under
  max-height parents. Desktop-Chrome preview passing means nothing for iOS touch.

## Web preview & verification
- `.claude/launch.json` → `drift-local` (python http server :3333→8081). No `/api`
  locally — seed `localStorage['drift.ekadashiCache.v2']` for Ekadashi UI work.
- Guest entry in preview: un-hide `#guest-signin-btn` → click → `ob-next-2` →
  `ob-guest-enter`. Google popup is blocked in preview; signed-in flows need device/sim.
- **Debug the running Android app's WebView (no Chrome UI needed)**: it's a
  Capacitor debug build, so DevTools is exposed. `PID=$(adb -s emulator-5554 shell
  pidof com.ankit.mysanskar)`; `adb forward tcp:9222 localabstract:webview_devtools_remote_$PID`;
  `curl -s localhost:9222/json` → grab the page's webSocketDebuggerUrl; drive it with a
  tiny Node script (global WebSocket, Node 22+) calling Runtime.evaluate to read live DOM
  / eval JS in-page. This is how the audiobook-cover failure was diagnosed (read img
  naturalWidth, compared lh3 vs /thumbnail endpoints). Note: page origin is `https://localhost`.
- Gemini prompts testable headless: extract prompt from app.js, node fetch with
  `geminiKey` from `config.js` (this is how prompt v2 was verified, with before/after
  sentence-length metrics).

## App Store marketing assets
- `~/Desktop/appstore-shots/` — one HTML compositor per frame + `capture-all.sh`
  (headless Chrome → PNG). iPhone frames output **1284×2778** (6.7" slot — this
  listing rejects 1320×2868); iPad frames **2064×2752** (13" slot, native sim size).
  Workflow: drop/replace screenshot PNGs (home.png, moral.png, …), rerun script.
  Style: saffron+ivory Fraunces two-line headline, warm gradient, floating icon
  chips, device frame bleeding off the bottom.

## Branch Strategy

- `staging` — active development branch, always work here
- `main` — mirrors staging exactly, never commit directly to main
- Changes flow: local code → `deploy:staging` → test → user approves → `npm run ship`

## Key URLs

- Production: https://mysanskar.vercel.app
- Staging: https://mysanskar-staging.vercel.app

## Current state (update me!)
- 2026-07-07: prod = `45bae40`; **v1.4 (2) uploaded to ASC** (widget, Ekadashi
  calendar+reminders, sleep timers, tri-state repeat, prompt v2 + story auto-refresh,
  settings redesign, feedback pipeline, Learn Gujarati onboarding + guest gate,
  green-token cleanup). Awaiting ASC submission — pick build 2 (build 1 stale).
  iPhone + iPad marketing screenshot sets generated. App Store description rewrite
  drafted in chat, not yet pasted into ASC.
- 2026-07-07 (later): **v1.4 approved + live on the App Store.** Update banner made
  self-serving for iOS (see manifest section) — shipped to prod (`91f4e52`) and
  verified: prod `/app-version.json` serves live ios.latest from Apple's lookup.

- 2026-07-08: **Eternal Virtues SHIPPED to prod** (`c1b501f`): 208-snippet master
  MD from the full 129-page book pass → Firestore `content/eternalVirtues` →
  gold "Today's Eternal Virtue" Home tile + sheet (works for guests). Before
  shipping, a 33-agent review fact-checked all 208 snippets against the book
  (29 content fixes incl. 2 factual errors) and confirmed 5 code bugs (render-
  before-cache, light-theme sheet, Space-key propagation, uploader zero-guard,
  rotation remap on republish → daily re-fetch). Same ship carried the
  icon/cover system (#4) + sw.js auto-stamp — verified live: prod sw.js =
  `sanskar-c1b501f6fc` (first sha-stamped deploy). Native www synced (iOS +
  Android); device install still pending for the next iOS build.

- 2026-07-08 (later): **v1.5 (1) uploaded to ASC** (App + NityaWidget in lockstep,
  MARKETING_VERSION 1.4→1.5, build reset to 1 — fresh train). Carries the Eternal
  Virtues tile + icon/cover system to native. Archive+export+upload all via CLI,
  verified archived bundle = 1.5(1) both targets + virtue-tile present.
  **Still to do in ASC web UI**: create the 1.5 version, fix the 6.9" screenshot
  slot with `~/Desktop/appstore-shots/out-69/` (native 1320×2868 — the 6.9"/Pro-Max
  slot still holds v1.3 media), then submit for review.

## Open items / known bugs
- **Android update-banner version stamp (fix before Play release)**: `build-www.sh`
  stamps `app-build.js` from iOS `MARKETING_VERSION` only, so on Android the app
  reports the iOS version (e.g. "1.5") instead of the Android `versionName` ("1.0").
  Mechanism + UI both verified working on Android (2026-07-09: platform='android',
  manifest.android block fetched, banner renders). But real Android update detection
  needs (a) platform-aware stamping (Android reads android versionName) and (b)
  `android.latest` bumped manually per Play release — no auto-lookup like iOS iTunes.
  Ekadashi fully verified working on Android (API returns 12 dates, calendar sheet OK).
- **iPad Google sign-in hang** ("Signing in…" after OAuth completes): native token
  exchange succeeded but Firebase credential step didn't visibly run; worked on
  retry. Debug rig: `simctl launch --console-pty` + watch ⚡️ lines. Real-user risk.
- Marketing frames 7 (Music) + 8 (Learn) show pre-icon-system UI (old emoji
  tiles / letter covers) — re-capture those two screenshots when convenient.
- **Oval play button**: `#sheet-play` computes 52×68 with border-radius:50% —
  force a square box (P0 from design audit).
- **Guest Home hero** leads with a locked Story of the Day — audit recommends one
  free playable story with the gate on the second (P1; product decision pending).
- Discussed but NOT approved (don't build unprompted): audiobook offline downloads,
  nightly streak mechanic, Ekadashi row → add-to-calendar, storybook-mode reader,
  moral share cards, guest free first story, fluid shared-element transitions.

# Design & UX committee

A standing review board for mySanskar's design decisions. Each member is channeled
through their published principles, essays, talks, and shipped work — these
are lenses, not endorsements or affiliations. Convene the full committee for
foundational flows (onboarding, Home, stories, notifications); convene a single
group for narrower questions (motion → iOS craft; copy/forms → product leaders).

## The foundational thinkers — how we evaluate interfaces

| Member | Lens they bring |
| --- | --- |
| **Don Norman** | Human-centered design, affordances, error tolerance; *The Design of Everyday Things*. Asks: does the design match the user's mental model, and does it forgive? |
| **Jakob Nielsen** | The ten usability heuristics every review still runs on. Asks: visibility of status, user control, recognition over recall, error prevention. |
| **Dieter Rams** | Ten principles of good design (Braun); the DNA of minimal UI. Asks: is it honest, unobtrusive, and as little design as possible? |
| **Edward Tufte** | Information design, data-ink, chartjunk. Asks: does every pixel of the tiles/cards/lists earn its ink? |
| **Bret Victor** | *Inventing on Principle*, *Magic Ink*; information software as understanding. Asks: does the interface show consequences before commitment? |

## The Apple lineage — the aesthetic bar

| Member | Lens they bring |
| --- | --- |
| **Jony Ive** | Care, inevitability, materials; iMac→iPhone, LoveFrom. Asks: does it feel inevitable and cared-for down to the corner radii? |
| **Susan Kare** | Icon language, friendliness at small sizes; the original Mac vocabulary. Asks: do the symbols speak without labels? |
| **Alan Dye** | Current Apple HIG voice; Liquid Glass era. Asks: does it feel native to the platform's present tense? |
| **Mike Matas** | Touch-era interaction design (original iPhone UI, Paper, Push Pop Press). Asks: is the content the interface? |
| **Loren Brichter** | Pull-to-refresh; gesture-driven economy (Tweetie). Asks: what would this flow feel like as one continuous gesture? |

## Product design leaders — scaling judgment

| Member | Lens they bring |
| --- | --- |
| **Julie Zhuo** | Product design judgment, team-scale quality; *The Making of a Manager*. Asks: what does the user believe this product is after 60 seconds? |
| **Luke Wroblewski** | Mobile-first, forms and input research. Asks: is every keystroke justified, and does the keyboard type match the field? |
| **Ryan Singer** | *Shape Up*; what a screen is *for*. Asks: what job is this screen hired to do, and is anything else on it? |
| **Karri Saarinen** | Design systems (Airbnb), craft-as-brand (Linear). Asks: is the system coherent enough that new surfaces design themselves? |
| **Rasmus Andersson** | Typography and systems (early Spotify, Figma). Asks: does the type carry the hierarchy without decoration? |

## The current iOS craft scene — the bar mySanskar competes on

| Member | Lens they bring |
| --- | --- |
| **Sebastiaan de With** | Lux (Halide, Kino); ex-Apple. Release-notes-as-design-essays; tactile, purposeful polish. Asks: where's the craft moment users screenshot? |
| **Andy Allen** | !Boring Software; ADA winner. Texture, sound, maximal delight without losing usability. Asks: what does this flow *sound and feel* like? |
| **Benji Taylor & the Family team** | "Family Values" fluid interfaces; wallet transitions as reference point. Asks: do states *transform* into each other or just get replaced? |
| **Janum Trivedi** | Spring physics, fluid-interface motion, SwiftUI-era open source. Asks: is every animation interruptible, physical, and driven by gesture velocity? |

## How a consult works

1. Give the committee the artifact (design doc, mocks, or build) and the goal.
2. Each member reacts through their lens: verdict + the single highest-leverage
   change they'd demand, grounded in their actual published thinking.
3. Synthesis ranks the changes by impact against mySanskar's brand (warm,
   devotional, premium) — a change that violates the Design system section
   above loses automatically.
4. Consult output is recorded below (Committee consults) next to the decision
   it produced.

## Committee consults
- **2026-07-07 · full app (v1.4) · full committee.** Top-5 10x–100x bets, ranked:
  1. **Storybook Mode** — paged picture-book reader, read-aloud paints each word
     (Matas/Victor/Brichter). Core-product 10x.
  2. **Moral share cards** — story ends in a celebration card (moral + child's
     name) → WhatsApp share (de With/Allen). Distribution 100x via family groups.
  3. **Guest's first story free**, gate the second (Zhuo/Norman). Activation.
  4. **Owned icon+cover language** — 12 saffron glyphs replace emoji; generated
     covers replace letter tiles (Kare/Saarinen/Ive). Retires the `[` bug.
  5. **Fluid transformations** — story-card→reader shared-element morph,
     gesture/velocity-driven pages (Family/Trivedi).
  Passes noted: typography hierarchy (Andersson), forms (Wroblewski), status
  visibility (Nielsen). Craft debt named by Ive: oval play button, `[` covers.
  Before/after mocks delivered in chat 2026-07-07. **Decision: #4 APPROVED and
  built same day (drawn white icon family for story tiles — temple was the
  existing benchmark; Gujarati cover glyphs ન/અ/ચ via GUJ_GLYPHS map; warm-only
  PALETTES so covers + player sheet stay on-brand; `[Tag]` album names parsed to
  "Title · Tag"). #1/#2/#3/#5 REJECTED by Ankit — do not build.**
