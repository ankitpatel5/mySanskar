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
  styles.css
  stories-data.js
  gujarati-data-content.js
  translations-data.js
  title-translations.js
  firebase-config.js
  conversation-starters.js
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

echo "✅ www/ ready ($(ls "$DEST" | wc -l | tr -d ' ') files)"
