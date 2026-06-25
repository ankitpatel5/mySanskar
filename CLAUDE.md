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

## Branch Strategy

- `staging` — active development branch, always work here
- `main` — mirrors staging exactly, never commit directly to main
- Changes flow: local code → `deploy:staging` → test → user approves → `npm run ship`

## Key URLs

- Production: https://mysanskar.vercel.app
- Staging: https://mysanskar-staging.vercel.app
