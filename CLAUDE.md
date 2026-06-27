# mySanskar — Claude Notes

## Deploy Flow — Always Follow This Order

### Step 1 — After every new feature or bug fix, deploy to staging first:
```bash
npm run deploy:staging
```
This pushes the current local code to **mysanskar-staging.vercel.app** for testing.
Always do this automatically after making changes — don't wait to be asked.

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

## iOS & Android Build Notes

- Both the iOS (Xcode) and Android (Android Studio) apps have their **own copy** of the web assets
  - iOS: `ios/App/App/public/`
  - Android: `android/app/src/main/assets/public/`
- Vercel deployments do NOT update these folders — they are completely separate
- `npm run build:ios` and `npm run build:android` each run `build-www.sh` then `npx cap sync <platform>`
- Both are **automatically included** in `npm run ship`, so every prod deploy keeps both native projects in sync
- After `ship`, rebuild in Xcode or Android Studio to get a simulator/device build with the latest changes

## iOS App Store Submission — Checklist (do this EVERY time the user mentions building/archiving for iOS app review)

When the user says anything like "build for iOS submission", "archive for App Store", "submit for review", or "generate an iOS build for approval", ALWAYS walk through this:

1. **Bump the build number** (and version if it's a new release) in `ios/App/App.xcodeproj/project.pbxproj`:
   - `CURRENT_PROJECT_VERSION` (build number) — must increase every upload, even for the same version. App Store Connect rejects duplicate build numbers.
   - `MARKETING_VERSION` — bump only for a new user-facing version (e.g. 1.3 → 1.4).
2. **Re-sync assets**: `npm run build:ios` — this also re-stamps `app-build.js` (the in-app version display reads `window.APP_BUILD`, auto-derived from `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`).
3. **Verify the archive includes the latest** — after the user archives, confirm the bundled `sw.js` cache version + feature markers match prod (`ls ~/Library/Developer/Xcode/Archives/...`).
4. **Commit the version bump** to git.
5. **Remind about the update manifest** (see below).

### Update-available banner — the manifest
- The app shows an "Update available" banner + a version in Settings → About, driven by a hosted manifest at **https://mysanskar.vercel.app/app-version.json** (`app-version.json` in repo root).
- `latest` = the version currently AVAILABLE on the store. **Bump `latest` only AFTER the new version is approved/live**, NOT at submission — otherwise users get prompted to update to a version that isn't downloadable yet.
- iOS deep link uses `appStoreId` `6774448007` (unlisted app). Android uses package `com.ankit.mysanskar`.
- So the release cadence is: submit build → (review) → once LIVE, bump `app-version.json` `latest` and `npm run ship`.

## Branch Strategy

- `staging` — active development branch, always work here
- `main` — mirrors staging exactly, never commit directly to main
- Changes flow: local code → `deploy:staging` → test → user approves → `npm run ship`

## Key URLs

- Production: https://mysanskar.vercel.app
- Staging: https://mysanskar-staging.vercel.app
