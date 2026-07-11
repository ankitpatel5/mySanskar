#!/bin/bash
# build-www.sh — copies web source files into www/ for Capacitor to pick up.
# Run this before `npx cap sync` whenever you change app.js, styles.css, etc.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/www"

echo "→ Cleaning www/"
rm -rf "$DEST"
mkdir -p "$DEST"

echo "→ Copying web files…"
FILES=(
  index.html
  app.js
  app-build.js
  utils.js
  styles.css
  stories-data.js
  gujarati-data-content.js
  translations-data.js
  title-translations.js
  firebase-config.js
  conversation-starters.js
  lyrics-data.js
  lottie.min.js
  manifest.json
  baal.png
  sw.js
)

for f in "${FILES[@]}"; do
  if [ -f "$ROOT/$f" ]; then
    cp "$ROOT/$f" "$DEST/$f"
  else
    echo "  ⚠️  Missing: $f"
  fi
done

# Copy icons directory
if [ -d "$ROOT/icons" ]; then
  cp -r "$ROOT/icons" "$DEST/icons"
fi

# Inject the real installed version into www/app-build.js, read from the Xcode
# project so it always matches the build the user is shipping. (Native bundles
# load these bundled assets; this keeps the in-app version display accurate.)
PBXPROJ="$ROOT/ios/App/App.xcodeproj/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
  VER=$(grep -m1 'MARKETING_VERSION' "$PBXPROJ" | sed 's/.*= *//; s/;//' | tr -d ' ')
  BLD=$(grep -m1 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | sed 's/.*= *//; s/;//' | tr -d ' ')
  # Guard: the App target and NityaWidget extension must share one version
  # (App Store requires it, and grep -m1 above assumes it). Warn on drift.
  VER_COUNT=$(grep 'MARKETING_VERSION' "$PBXPROJ" | sed 's/.*= *//; s/;//' | tr -d ' ' | sort -u | wc -l | tr -d ' ')
  BLD_COUNT=$(grep 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | sed 's/.*= *//; s/;//' | tr -d ' ' | sort -u | wc -l | tr -d ' ')
  if [ "$VER_COUNT" != "1" ] || [ "$BLD_COUNT" != "1" ]; then
    echo "  ⚠️  VERSION MISMATCH between App and NityaWidget targets in project.pbxproj —"
    echo "     bump them together (App Store rejects extensions whose version differs from the app)."
  fi
  printf 'window.APP_BUILD = { version: "%s", build: "%s" };\n' "$VER" "$BLD" > "$DEST/app-build.js"
  echo "  ✓ app-build.js stamped with v$VER ($BLD)"
fi

# Copy config.js if present (API keys — gitignored, never committed)
if [ -f "$ROOT/config.js" ]; then
  cp "$ROOT/config.js" "$DEST/config.js"
  echo "  ✓ config.js copied (API keys included)"
else
  echo "  ⚠️  config.js not found — AI features and TTS will not work in the app"
fi

# Guard: every local <script src> in index.html MUST exist in www/ — a missing
# file 404s only on NATIVE (web serves the repo root), which is how utils.js
# silently broke the iOS music library once. Fail loudly instead.
MISSING=0
for src in $(grep -oE 'src="[A-Za-z0-9._-]+\.js[^"]*"' "$ROOT/index.html" | sed 's/src="//; s/"//; s/\?.*//' | sort -u); do
  if [ ! -f "$DEST/$src" ]; then
    echo "  ❌ index.html references $src but it is NOT in www/ — add it to FILES in build-www.sh"
    MISSING=1
  fi
done
if [ "$MISSING" = "1" ]; then
  echo "❌ build-www.sh aborted: native bundle would be broken."
  exit 1
fi

echo "✅ www/ ready ($(ls "$DEST" | wc -l | tr -d ' ') files)"
