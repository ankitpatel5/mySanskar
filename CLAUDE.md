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
- **www whitelist gotcha (bit us 2026-07-10)**: build-www.sh copies an explicit FILES
  whitelist — a script referenced by index.html but missing from the list 404s ONLY on
  native (web serves the repo root, so staging/prod look fine). utils.js was missing →
  window.AppUtils undefined → every album crawl threw → "No music found" on iPhone.
  lyrics-data.js + lottie.min.js were ALSO silently missing from every native build to
  date (lyrics + onboarding confetti broken on native). Now guarded twice: build-www.sh
  fails loudly if any index.html script src is absent from www/, and
  tests/build-manifest.test.js fails CI if the whitelist drifts. When adding a new
  <script src> to index.html, add it to FILES in build-www.sh.
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
  Phone must be unlocked (errors 12040/FBSOpen = locked). **Error 1011 /
  "unavailable" in `devicectl list devices` = UNREACHABLE (phone not on the
  Mac's Wi-Fi or needs USB) — NOT a lock issue; retry loops must print the
  real devicectl error, never assume locked.** Reuse `./build` derived
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
- **Satsang Diksha Mukhpath** (Learn tab · shipped to staging 2026-07-19):
  `renderSdHero` (guest-locked tile) → `openSdHub` (view-sd-hub: sticky
  `.sd-fixed` header w/ tracker + repeat picker + # go-to over full 315
  catalog, `sdRenderSections`, sections of 10, per-section select) →
  `sdStartQueue` → `#sd-player` fixed overlay (`sdLoadShlok`/`sdOnEnded`
  round+handoff breaths, `sdTogglePause` veil, ambient ✕‹⏸›). Videos
  stream from Drive `SD_FOLDER_ID` (catalog cached `drift.sdCatalog.v1`
  24h). Single-audio: `sd` entry in stopAllOtherAudio map +
  stopAllOtherAudio('sd') on video 'play'. Persistence: `drift.sdMem` mirrors
  Firestore `users/{uid}/settings/sdMem {nums:[]}` (gujProgress pattern:
  debounced save, union-merge at sign-in, impersonation/guest write-guard —
  memorized survives devices/reinstalls); `drift.sdRepeat` local-only;
  selection deliberately session-only. Back: BACK_BTN_BY_VIEW + goBack closes #sd-player first.
  Wake lock: navigator.wakeLock + visibilitychange re-acquire (iOS 16.4+;
  KeepAwake plugin still open for older iOS). NOT yet done: msClaim('sd')
  lock-screen identity (utils MS_ACTION_MAP has no 'sd' — foreground
  feature v1), background-audio-on-lock spike, ghanti tick/haptics.
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
- **Push notifications (FCM)**: `initPushSettings` / `savePushToken` /
  `pushPlugin` (native-only: `Capacitor.Plugins.FirebaseMessaging`,
  @capacitor-firebase/messaging). Settings → "News & updates" toggle
  (`#push-row`/`#push-toggle`, hidden on web; `drift.pushEnabled` in
  PER_USER_LS_KEYS). Tokens live in `users/{uid}.fcmTokens` array
  (arrayUnion on enable/refresh, arrayRemove on disable; guarded against
  guest/impersonation). iOS: aps-environment entitlement in
  AppRelease.entitlements, GoogleService-Info.plist in App target,
  `FirebaseApp.configure()` in AppDelegate.
  **Sending (ad-hoc promos)**: Firebase Console → Messaging → New campaign
  (zero code, targets all app instances), or FCM HTTP v1
  `POST /v1/projects/baal-shravan/messages:send` `{message:{token, notification:{title,body}}}`
  with the cached firebase-tools OAuth token (script pattern in git history:
  reads fcmTokens from Firestore REST, sends per-token).
  GOTCHAS: Android delivers NOTHING to a force-stopped app (platform rule —
  relaunch first; background via Home is fine). Foreground pushes skip the
  system tray: they hit the `notificationReceived` listener → in-app toast.
  iOS delivery requires the APNs key uploaded in Firebase Console →
  Cloud Messaging (DONE 2026-07-16: key R5BT7UVTLG, both dev+prod slots).
  Console CAMPAIGNS deliver via production APNs only — Debug (sandbox)
  builds never receive them; direct HTTP v1 token sends reach both.
  Firebase In-App Messaging is NOT supported (no SDK; campaigns there
  reach nobody) — use the Notification-messages campaign type.
- **First-run notification soft-ask**: `maybeShowNotifAsk` — once per
  install (`drift.notifAsked`, device-level, deliberately NOT in
  PER_USER_LS_KEYS), on first home landing (boot path 2.5s delay +
  completeOnboarding hook; whichever finds `drift.onboardingDone` set and
  the overlay hidden fires — new-device returning users self-heal to next
  launch). Sheet `#notif-ask-modal` ("Stay connected — Ekadashi reminders
  and other special announcements"). The iOS system permission prompt is
  ONE-SHOT per install — it fires only on an explicit "Turn on" tap; on
  grant both Ekadashi reminders AND push auto-enable + Settings toggles
  sync (guests: Ekadashi only). Wiring guards: tests/notif-ask.test.js.
- **Sleep timer (shared music+audiobook)**: `setSleep` / `sleepCountdownTick` —
  wall-clock countdown + 15s volume fade (`SLEEP_FADE_MS`); 'eoc' = end of current
  track/chapter; UI hooks `.js-sleep-btn` / `.js-sleep-sheet`.
- **Library sections**: `AppUtils.parseAlbumFolderName` ("[NS]" Drive-folder prefix
  → section 'fun', marker stripped at ingest; tests/library-sections.test.js).
  renderLibrary partitions via `albumSection()` (cached-library fallback) and adds
  `.library-section-header` rows. Data contract: Drive folders keep the [NS]
  prefix; the string never renders.
- **Single-audio rule**: music/audiobook/story-TTS are mutually exclusive via
  `stopAllOtherAudio(starting)` → AppUtils.enforceSingleAudio; wired at music
  'play', _abAudio 'play', startTTS AND resumeTTS. tests/audio-focus.test.js
  covers the exclusion matrix AND greps app.js for the wiring (the regression
  was a play path missing the call — tests fail if any call site is removed).
- **Media-session router** (lock screen / CarPlay identity; consult 2026-07-11):
  one source at a time owns navigator.mediaSession via `_msSource` + `msClaim(src)`
  (claimed on the SAME 'play' events as the single-audio rule) / `msPaused(src)`
  (guarded by AppUtils.msShouldApply — THE race: a dying source's queued 'pause'
  event lands AFTER the new source's claim and must not stamp over it). Handlers
  are stable trampolines resolving against `_msSource` at call time. Pure logic in
  utils.js: MS_ACTION_MAP (audiobook trades prev/next for ±30s slots —
  intentional), resolveMediaAction, buildMediaSessionMeta, computeAbPositionState
  (null on non-finite — setPositionState throws). abTogglePlay/abSkip extracted
  so lock-screen commands share the in-app paths incl. dead-element recovery.
  TTS re-claims after every per-paragraph _vipAudio.play(). speechSynthesis
  fallback = no remote controls (platform limitation). Lock-screen scrubbing
  (seekto) deliberately deferred. tests/media-session.test.js guards matrix,
  metadata, position math, race guard, AND app.js wiring.
- **Play loading cue**: bufferingCueArm/Resolve/Clear + body.audio-buffering;
  ring spans (.play-loader) live inside #mini-play/#sheet-play (index.html) and
  Nitya buttons (icon in .nitya-ic child span — swapping btn.innerHTML would
  destroy the ring). Tokens: 250ms delay, 400ms min-show, 500ms stall grace,
  12s watchdog, 1.1s ring. prefers-reduced-motion honored.
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
  **Playback resilience (2026-07-11)**: _abAudio has an 'error' listener (was
  silent!); dead-element recovery in abTogglePlay + togglePlay re-resolves src at
  position (play() on an errored element rejects silently forever — the "play
  button stopped working" bug); appStateChange resume logs silent element deaths
  as gray 'diag' rows in the admin activity feed. ±30s seeks resync the virtual
  Part via AppUtils.virtualChapterIdxForPos (tests/audiobook-parts.test.js) —
  never abLoadChapter on a backward crossing (it seeks).
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
- **Back navigation**: central `goBack()` clicks the visible view's EXISTING back
  button (BACK_BTN_BY_VIEW map) — no history stack; polymorphic story-reader
  flags + guj-detail parent + ab-detail save-progress come free. Consumers:
  swipe-right gesture on #content (setupSwipeBack — strict horizontal intent,
  excludes #conv-cat-scroll/.ab-continue-scroll/sheets/scrubbers) and the
  Capacitor backButton listener (Android hardware/gesture back previously EXITED
  the app; now back → Home → minimize). Onboarding: finger-tracking pager
  (track follows the drag; left=forward mirroring each screen's primary button,
  right=back, 22% commit threshold, edge rubber-band; terminal screens
  button-only). HARD-WON RULES (2026-07-13 debugging): (1) goBack navigates by
  .click()ing the view's back button — any capture-phase click suppressor must
  be armed AFTER goBack and only for ev.isTrusted events, or it eats its own
  navigation (this exact bug shipped briefly). (2) goBack resolves the view from
  state.currentViewId (set in switchView) — never trust a DOM :not(.hidden)
  query alone. (3) Every swipe-back logs `diag | swipe-back: view=X btn=Y` to
  the admin activity feed — first stop when a misroute is reported. (4) The
  swallowing try/catch around _setupEventListenersInner means a wiring throw
  kills all LATER wiring silently — check console for 'setupEventListeners
  crashed' (console.error, NOT an uncaught exception). (5) Emulator gotcha:
  onboarding overlay intercepts physical swipes — dismiss before gesture tests;
  DevTools targets go stale across force-stop/relaunch (re-list, re-forward).
- **Learn Gujarati audio (local-first, 2026-07-13)**: 1106 clips trimmed
  (561s silence removed) + re-encoded mono 48k AAC via scripts/build-guj-audio.js
  (26.5MB Firebase → 11MB bundled in repo `guj-audio/`, copied to www by
  build-www.sh). gujPlay tries AppUtils.gujLocalAudioPath(url) first (tap→sound
  112ms vs 1802ms remote, measured on emulator), onerror falls back to the
  Firebase URL. Mapping is THE contract (tests/guj-audio.test.js); pipeline
  reuses the same function so names can't diverge. Re-run the script after
  adding new clips to gujarati-data-content.js.
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
- **Onboarding shows ONCE per user, ever** (2026-07-10): the flag is persisted on the
  Firestore profile `users/{uid}.onboardingDone` (written by completeOnboarding, merge).
  `checkOnboarding` is async: localStorage `drift.onboardingDone` is a fast cache; with no
  local flag it reads the profile BEFORE showing, so a new device/reinstall/cleared cache
  never re-triggers it. Resolves once (`_onboardingResolved` + `_onboardingChecking` guard
  against the fast-boot vs real-user double-show race); re-checked in the real-user boot
  path when auth is ready. Skipped during impersonation. This also fixes account-switch
  (the Firestore flag governs, not the wiped localStorage).
- **Admin activity log + impersonation (Debug)**: per-user `users/{uid}/activity`
  (`logActivity(type,label)` → {type,label,ts}; instrumented in playTrack, openStory,
  openSOTDStory, openAIStoryReader, openGujHub/Section, openConversationStarters,
  openAudiobook). Admin Users view: expand a user → `loadUserDetail` shows last-25
  "Recent activity" (color-coded by ACTIVITY_META) + "Top plays". Per-user **Debug**
  button → `startImpersonation(u)` stashes {uid,name,...} in sessionStorage + reloads;
  boot (`proceedAsUser`) detects it (admin only), sets `state.impersonateUid`, clears
  per-user localStorage, and `activeUid()` routes all user-scoped Firestore READS at
  the target (replaced `users/${state.user.uid}/` → `users/${activeUid()}/`; sotd callers
  too). VIEW-ONLY: writes stay on real user (state.user.uid) and are guarded by
  `isImpersonating()` (syncPlayCount, logActivity, saveAIStory, storyProgress, SOTD gen);
  target data also protected because rules only grant admin READ, not write. Purple
  "Impersonating <name>" banner (flow element atop #app) + Exit (`exitImpersonation`
  clears + reloads). Rules: admin-read added to aiStories/storyOfDay/settings/
  storyProgress + new activity collection. NOTE: activity grows unbounded per user
  (admin query limits 25; add pruning if it matters). Legacy `.admin-user-detail` CSS
  is dead — this uses `.admin-user-log`.
  IMPERSONATION DATA SAFETY (fixed 2026-07-10 after leak audit): all account-scoped
  localStorage is in one list `PER_USER_LS_KEYS` (child, aiCharacters, aiStories,
  aiUsage, imagenQuota, gujProgress, completedStories, nitya, ekRemind/ekRemindDays,
  audiobooksEnabled, playlists/playCounts/queue/library/lastTrack). On Debug-enter the
  admin's copy is snapshotted to localStorage `drift.impBackup` (once — not overwritten
  when switching targets), then cleared so only the target's data shows; boot restores
  the backup on Exit OR if the app was killed mid-session (restoreImpersonationBackup).
  Device-only keys (chips, reminders) that aren't in Firestore are therefore never lost.
  Debug is view-only: markGujDone + the sync/save writes bail on isImpersonating().
  Clicking a user's name/avatar (not just the chevron) expands their activity feed;
  onboarding is skipped during impersonation. Local-only recent-character chips show
  EMPTY in debug (not synced to Firestore, so the target's aren't knowable).
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

- 2026-07-10: **v1.6 native builds cut** (admin activity log + view-only Debug
  impersonation, onboarding persisted to Firestore profile). iOS 1.6 (1) uploaded to
  ASC (processing → create 1.6 version, attach build, still owes the 6.9" screenshot
  slot fix). Android 1.6 (2) signed AAB at
  android/app/build/outputs/bundle/release/app-release.aab (awaiting Play Console acct).
  Web already on prod (aff2fa7). Version bump committed f5a79d2 (local; rides next ship push).

- 2026-07-10 (later): **1.6 approved + LIVE on iOS.** Shipped next batch and cut
  **v1.7 (1)**: library Satsang/Fun & Rhymes sections, play-loading ring, single-audio
  rule (+103-test suite incl. wiring guards + build-manifest guard), and the
  build-www whitelist fix (utils.js/lyrics-data.js/lottie.min.js now ship to native —
  lyrics + onboarding confetti were silently broken on ALL native builds through 1.6).
  Manifest floor ios.latest → 1.6 (live). Android 1.7 (3) AAB rebuilt with same fixes.

- 2026-07-11: **1.7 approved + LIVE on iOS.** Shipped media-session router
  (lock screen/CarPlay always shows + controls the ACTIVE source: music/audiobook/
  TTS), audiobook playback resilience (error handler, dead-element recovery,
  resume diagnostics), ±30s virtual-part resync. 138-test suite. Cut **v1.8 (1)**
  iOS + **1.8 (4)** Android with all of it. Manifest floor ios.latest → 1.7.
  KNOWN v1 LIMITATION: audiobook lock-screen scrubbing (seekto) is display-only;
  audiobook lock screen shows ±30s instead of prev/next (intentional slot trade).

- 2026-07-13/14: **Shipped nav + polish batch**: swipe-right-to-go-back on all
  interior views (central goBack + Android hardware-back wiring + isTrusted
  phantom-click guard + diag logging), onboarding finger-tracking pager,
  conversation-starters sticky header, Learn Gujarati audio bundled locally
  (1106 clips, 11MB, tap→sound 112ms vs 1802ms remote). 142-test suite.
  guj-audio/ now lives in the repo (rides Vercel for web same-origin serving).

- 2026-07-16: **FCM push plumbing built + verified on Android** (staged, NOT yet
  shipped): @capacitor-firebase/messaging plugin, iOS capability/plist/configure,
  `users/{uid}.fcmTokens` registry, Settings "News & updates" toggle (see feature
  map → Push notifications). End-to-end proof on emulator: toggle → native
  permission Allow → token in Firestore → FCM HTTP v1 send 200 → notification in
  system shade. iOS Debug build with plugin installed+launched on Ankit's iPhone.
  OWNER'S HALF for iOS delivery: Apple Developer → Keys → create APNs key (.p8) →
  upload to Firebase Console → Project settings → Cloud Messaging → Apple app.
  (DONE next day — see 2026-07-16 later entry.)

- 2026-07-16 (later): **APNs key uploaded (iOS push verified end-to-end)** —
  direct HTTP v1 send delivered to Ankit's iPhone (sandbox Debug build).
  **First-run notification soft-ask built + verified on emulator** (sheet on
  home landing → one tap → Ekadashi + push both on, 11 reminders scheduled,
  toggles synced). 148-test suite. Full new-user flow also demoed on iOS
  Simulator (guest onboarding → home → sheet → iOS dialog → Allow).
  **SHIPPED to prod `f4558f0b`** (sw `sanskar-f4558f0b30`, verified serving
  soft-ask code); native www synced both platforms — still owes the 1.9 cut.
  Ship gotcha fixed: ios/App/build-sim/ (simulator derivedData) blew up the
  git push (228MB SPM pack > GitHub limit) — now gitignored; the ship-commit
  had to be amended (`git rm -r --cached`) before push succeeded.
  Soft-ask is ONCE per install by design ("Not now"/backdrop = asked forever;
  Settings toggles remain the manual path). Possible future: contextual
  re-ask from the Ekadashi sheet after a cool-down (owner aware, not built).
- 2026-07-17: **SOTD debug visibility** (staged): impersonation now shows a
  view-only placeholder tile when today's story doc is missing/stale
  ("No story generated today · generates when the user opens the app") instead
  of hiding silently — stories are generated CLIENT-SIDE on the user's device
  at open, so a missing doc usually just means they haven't opened the app
  today (confirmed against prod: every user's latest story == last active
  day). SOTD generation failures now logActivity('diag', …) so
  child-profile-but-zero-stories cases (e.g. shrivastava.arpit — single
  2-min session on 2026-07-11, likely closed app mid-generation) are
  diagnosable from the admin activity feed. Verified on emulator by
  impersonating that user.

  FIXED 2026-07-17: guest onboarding CTA clipped under the home indicator on
  iPhone 17/17 Pro. Root cause was NOT missing safe-area padding (that was
  already there) — it was the flex min-height:auto shrink trap at TWO levels:
  .ob-guest-limit AND .ob-guest-limit-body both needed `min-height: 0` so the
  feature list scrolls internally instead of pushing the footer off-screen.
  Verified on iPhone 17 sim: CTA above home indicator, tap → home → soft-ask.

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
- **2026-07-19 · Satsang Diksha Mukhpath (315 shlok karaoke videos, Learn tab) ·
  full committee (4 groups).** Artifact: Drive folder (3 test videos #313-315,
  1080×1920 ~44s ~2.4MB, karaoke word-highlight cards w/ Gujarati +
  transliteration + meaning + Mahant Swami photo). UNANIMOUS FOUNDATION:
  (1) **audio-first architecture** — it's a chant that ships inside an mp4; must
  ride the existing rails (stopAllOtherAudio, msClaim on 'play', mini-player,
  sleep timer, buffering-cue tokens) and playback MUST survive screen lock
  (car/bedtime is the core use; if lock kills audio, nothing else matters —
  lock screen = card still as artwork, prev/next-SHLOK replaces ±15s seek).
  (2) **The player is the product, the library is scaffolding** (Singer):
  default mode "repeat N times, then next-in-set"; section OPENS on a
  resume/repeat card ("Continue — Shlok 313 · played 4×"), list secondary.
  (3) **Loop-one default ON with a live visible counter** ("3 of 5"), via the
  tri-state repeat pattern — NEVER native audio.loop (ended-event drives the
  counter). (4) **Number-first navigation, zero thumbnails** (315 identical
  cards = chartjunk): milestone-set/decade-banded number-chip grid, row =
  big numeral + one line of Gujarati, NO English in rows; numeric go-to
  deferred until corpus >~30. (5) **Identity**: teal `.learn-section-label`
  section in Learn ("Satsang Diksha · Mukhpath"); the dark card supplies its
  own devotional identity; saffron only in the orbit buffering ring (around
  the shlok badge, poster frame so it never lands on black). ADJUDICATED:
  video shown WHOLE (Tufte: no app pixel over shlok pixels) with one control
  object in the card's dead zone — repeat dial ×3/×5/×11/∞ (mala numbers,
  detent haptics) — over Ive's tap-summoned overlay; single-tap does NOT
  restart (repeat automation makes it redundant; kids' stray taps). Progress:
  quiet auto `--success` dot at ≥5 plays, green not gold (one-green rule
  beats Kare's gold), NO streaks/confetti/N-of-315 meters (2026-07-13 line
  holds); parent long-press "learned" deferred. CRAFT (P2, after core):
  row→player→mini-player FLIP morph w/ badge as shared element over cached
  poster; velocity-inherited swipe-back exit; single ghanti tick + light
  haptic at repetition boundary (app silent otherwise, out of reverence);
  screenshottable completion frame (frozen last frame + badge morph +
  "chanted 5×"). v1 SCOPE (3 videos): teal section + resume card + chip row
  313-315 + fullscreen player w/ repeat dial + counter + background-audio
  survival + media-session + mini-player + `_sdProgress` localStorage
  (mirror _gujProgress). TECH SPIKE FIRST: verify <video> audio survives
  lock in WKWebView/Android WebView (else extract audio track fallback).
  Vertical swipe pager next/prev (Matas) accepted, preload ±1.
  **DELTA RECONVENE (same day) — OWNER DIRECTIVE "video is core":** session
  model = screen-on co-viewing (parent + kid, phone propped, chanting along),
  NOT locked-phone listening; background audio demoted to graceful
  degradation. Revised ruling: (1) **Set-and-forget** (LukeW/Singer): repeat
  count picked PRE-FLIGHT (×3/×5/×11/∞ on the shlok/resume card) → zero
  required inputs after propping. (2) **Wake-lock + portrait lock asserted
  explicitly** (KeepAwake plugin or navigator.wakeLock w/ visibilitychange
  re-acquire; don't trust inline-video to hold Android awake); auto-dim
  mid-chant = system failure; now v1-core, not polish. (3) **The watched
  boundary breath** (Allen+Trivedi+Singer+Matas merged): between rounds, one
  composed ~1.5-2s beat — final-frame hold, dim to 88%, waveform
  inhale-glow, LARGE "Round 2 of 5" (beat screen is where round messaging
  lives; during chant only one small counter chip "2/5", Andersson's
  one-overlay rule, Kare's armed-×N whisper merged into it), ghanti tick +
  light haptic, 0.97 scale-return. (4) **Tap ADJUDICATED**: single tap =
  pause + reveal control veil (Victor's pause-and-say teaching freeze +
  LukeW whole-screen pause; 2 groups beat Brichter's restart — restart is a
  64pt button on the veil, one tap away while paused); controls auto-hide
  2.5s; all targets ≥56-64pt (kid fingers, couch distance). (5) **Gesture
  guards while playing** (Family/Trivedi): vertical paging needs deliberate
  flick (>0.6px/ms, >60px), swipe-back needs edge-origin (24px) + velocity;
  rejected kid-touches rubber-band 8px w/ spring — respond, never lock.
  (6) **Two-beat completion frame** (de With): kid's payoff first ("You
  chanted it 5 times", 600ms badge bloom + gold tilak dot), parent's
  progress + share fades in 1.2s later. Unchanged: teal section mount,
  resume card entry, chip grid/numeral rows, audio-rails plumbing
  (single-audio + msClaim + mini-player when backgrounded), green-dot-only
  progress, no streaks. Decision: consult recorded — awaiting owner's
  go-ahead to build.
  **REV 2 (same day) — OWNER DIRECTIVES + transport-controls consult:**
  (1) Learn tile titled "Satsang Diksha Mukhpath" (full name, no NEW badge).
  (2) Hub: resume card OUT; top = memorized tracker "N of 315 memorized" +
  quiet green progress bar (owner overrides the no-meters line);
  mark-memorized is PARENT-ASSERTED via long-press on a shlok chip.
  Repeat picker = ×1/×3/×5/∞ (×11 dropped). Browse = multi-select chips
  building a practice queue → single pinned "Start playing · N shloks"
  button → fullscreen session. (3) Completion celebration screen CUT —
  between shloks the boundary breath carries "Next · Shlok NNN" (saffron
  rule, same ~2s rhythm, chip morph); end of queue resolves to hub.
  (4) CONTROL SPEC (Dye/Matas/Brichter/de With/Family/LukeW focused
  consult): two layers — resting ambient glyphs + the veil (same elements
  brightened, nothing appears/disappears wholesale). Rest: ✕ top-left
  17pt/0.32 opacity/48pt target; ‹ ⏸ › bottom edge 20-22pt glyphs/0.32-0.38
  /56pt targets, thumb-arc; all bare glyphs w/ baked radial soft shadow
  (black 40% 8pt blur) — NO bars/strips/edge-hotspots. Touch-down →0.90
  over 120ms + light haptic. Glyphs strictly = gestures (✕=guarded
  swipe-back path; ‹›=pager flick to prev/next SELECTED shlok, disabled
  0.15 at queue ends; ⏸=tap-anywhere veil). ONE chip top-right carries
  rounds+queue "2/3 · 1 of 4" (Inter semibold 13pt + 11pt 70% trailing),
  morphs into breath's "Next·Shlok" label — never two counters.
  Mockup (interactive, verified): claude.ai/code/artifact/ca3da394-ad27-4dbe-839b-78d7e2b2bd72
  **REV 3 (same day) — browse ergonomics consult (LukeW/Nielsen/Tufte/
  Brichter/Singer) + owner:** horizontal strip scrolling all 315 REJECTED
  (63 screen-widths of flicking, no landmarks). RULING = two surfaces, two
  jobs: hub keeps ONE short curated non-scrolling strip ("This week ·
  311-315", header gains "Select week" text button scoped to that set) +
  "View all 315 →" row; VIEW ALL = fullscreen vertical list in sections of
  10, row = numeral + first-Gujarati-phrase, same tap-select/hold-memorize
  grammar as chips, section headers carry "n/10 memorized" + per-section
  Select/Deselect toggle (scoped to their ten). NO global select-all-315
  anywhere; the only global control is "Clear (N)" next to Start on both
  surfaces (deselect only). "#" numeric go-to in View All nav → scrolls +
  flash-highlights, does NOT auto-select. Owner confirmations: video play
  claims single-audio rule (stopAllOtherAudio + msClaim, same as every
  player — pauses music/TTS/audiobooks). CONTENT BUG found in source
  assets: "Shloka #315.mp4" renders badge "Shloka #314" inside the video —
  flag to asset producer before the 315-batch render.
  Decision: rev-3 recorded — awaiting owner's go-ahead to build.
  **REV 4 (same day) — OWNER KILLS THE STRIP:** no curated "This week" chip
  strip at all. The hub IS the catalog: locked (non-scrolling) header =
  navrow (+ "#" go-to) + memorized tracker + repeat picker ×1/×3/×5/∞;
  beneath it the full 315-shlok sectioned list scrolls within the screen
  (sections of 10, "n/10 memorized" headers, per-section Select/Deselect,
  tap-select/hold-memorize rows, numeral + first-Gujarati-phrase). One
  surface, no separate View All screen. Global Clear + pinned Start
  unchanged. Player/breath/handoff unchanged from rev 2-3.
  Decision: rev-4 recorded — awaiting owner's go-ahead to build.
  **SHIPPED TO PROD 2026-07-19** (owner tested on iPhone → "ship it";
  prod sw.js stamp + sd code verified live; both native projects synced). All 315 videos now in
  the Drive folder (SD_FOLDER_ID in app.js). Content status 2026-07-19:
  owner deleted the dupe "Shloka #224 (2).mp4" (ingest prefers plain names
  anyway, so it never mattered); #315's chant/audio is CORRECT — only the
  baked-in badge graphic says "314" (typo for the video producer to fix in
  the source template; no app change needed). Copy tweaks: section headers just
  "Shloks 1 – 10" (no Pratham Prakaran), tile has no subtitle.
- **2026-07-13 · FULL UX AUDIT (v1.8, 15 live emulator screenshots) · full committee.**
  VERDICT: "the trust floor is far below the craft ceiling" — foundation (tile
  color identities, Fraunces/Inter, glyph-gradient covers, 4-tab skeleton,
  one-green discipline, Virtue sheet, Ekadashi status copy) unanimously praised;
  the gaps are FINISHING shipped systems, not new features. TOP GAPS (post
  fact-check): (1) mini-player expand — VERIFIED REAL: only #mini-row (title
  strip) opens the sheet, container+transport dead for expansion, no affordance;
  merge w/ audit gap 8 (8 cramped targets, ±15s useless for kirtans). NOTE: the
  audit's "Ekadashi tile dead tap" was a capture artifact — tile verified working.
  (2) Story of the Day opens to a grey "Painting your illustration…" void —
  pre-generate daily art server-side, shimmer + glyph-gradient fallback for live
  gen. (3) cover system stops halfway (story thumbnails near-black, audiobook
  olive placeholders, coverless album header, generic mini/Nitya art) — make
  glyph-gradient the universal fallback. (4) subtitle==title ("Arti / Arti") +
  indistinguishable virtual-part rows — one conditional. (5) masthead stacks over
  local chrome on interior screens (5 nav layers on album) — page-shell rule:
  masthead on tab roots only. (6) four competing language controls — one
  component, one stored pref, text drives voice. (7) Home hero = fast 13 days out
  while Nitya clips below fold — proximity-weighted layout. (9) "Mischevious"
  typo in flagship story (list+reader+baked art) + title spell pass. (10, OWNER'S
  CALL — adjacent to rejected calendar-add) in-sheet "Remind me" pill flipping
  the existing notification toggle. QUICK WINS batch: red VIDEO tag→neutral chip,
  (!)→chevron on ab More Details, durations in lists + ab elapsed/total, SOTD
  badge violet→rose, story-tile chevron, EN/GU corner badge on twin covers,
  "7% done"→"4h 12m left", conv-starters gradient→warm register, ab section
  headers→caps-label style, "Other Kirtans" junk drawer. RESURFACED (flagged,
  NOT ranked): virtue "Mark as read"/"Ask tonight" (edges toward completion
  mechanics). Decision: NOTHING BUILT — awaiting owner's picks.

- **2026-07-10 · Library sections + play-loading feedback · full committee (10 groups).**
  **Q1 (Satsang/[NS] grouping) DECISION**: one scrolling grid, two inline non-sticky
  full-width headers reusing `.learn-section-label` verbatim — "Satsang · Kirtans,
  dhuns & prayers" first, "Fun & Rhymes · Nursery rhymes, lullabies & sing-alongs"
  second. Headers ONLY when both sections non-empty. Sections strictly equal
  (order alone = priority; no dots/counts/colors — all rejected as demotion
  signals). [NS] stripped at INGEST (makeAlbum → AppUtils.parseAlbumFolderName)
  so it never renders anywhere incl. lock screen; albumDisplay never shows an NS
  tag even from stale caches. Downloaded card → full-width utility row above both
  sections. REJECTED: pill toggle (hidden-mode error), collapsible, sub-tab,
  labels "Non-Satsang"/"More Music"/"Just for Fun"/"Kids' Corner". Escape hatch
  (only if Satsang >~14 albums): anchor chips that SCROLL, never filter.
  **Q2 (loading cue) DECISION**: two layers. Layer 1 = 0ms acknowledgment
  (press-scale 0.94 spring + the already-optimistic play→pause swap). Layer 2 =
  270° saffron orbit ring ON the button's own edge (white-tint on saffron Nitya
  discs), through a 250ms delay gate + 400ms min-show; track rows get NO spinner —
  equalizer bars freeze + pulse ("pre-roll"); 500ms stall grace mid-track; 12s
  watchdog → error reverts icon to play (the retry affordance) + toast. Implemented
  as body.audio-buffering CSS keyed off one cue engine (bufferingCueArm/Resolve/
  Clear in app.js). DEFERRED (P2): pointerdown Drive-redirect prefetch, 8s
  "RECONNECTING…" caption, buffered-range band on scrubber, haptics/shake, toast
  Retry button.

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

- 2026-07-17 (later): **SHIPPED to prod `2fe653de`** (sw `sanskar-2fe653dec0`,
  verified): SOTD debug placeholder + diag-on-failure, guest-onboarding CTA
  flex fix. main == staging. Native www synced both platforms — the whole
  FCM/soft-ask/CTA/SOTD-debug batch still owes the **1.9 cut** (iOS archive +
  ASC upload, Android AAB) to reach store users.

- 2026-07-17 (later): **v1.9 CUT**. iOS 1.9 (1) archived + uploaded to ASC
  (App + NityaWidget lockstep; archive verified: soft-ask/push/SOTD-debug/CTA
  fix/1106 guj clips/GoogleService-Info/aps-environment). Android 1.9 (5)
  signed AAB at android/app/build/outputs/bundle/release/app-release.aab
  (verified same markers; still awaiting Play Console account).
  GOTCHA: Release archive FAILS with "unable to resolve module dependency:
  FirebaseCore" unless it reuses the resolved derived data — always pass
  `-derivedDataPath ./build` to the archive command too.
  ASC web-UI steps still owed (owner): create 1.9 version, attach build 1,
  fix the 6.9" screenshot slot (~/Desktop/appstore-shots/out-69/), submit.
