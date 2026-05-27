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
  styles.css
  stories-data.js
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

# Copy config.js if present (API keys — gitignored, never committed)
if [ -f "$ROOT/config.js" ]; then
  cp "$ROOT/config.js" "$DEST/config.js"
  echo "  ✓ config.js copied (API keys included)"
else
  echo "  ⚠️  config.js not found — AI features and TTS will not work in the app"
fi

echo "✅ www/ ready ($(ls "$DEST" | wc -l | tr -d ' ') files)"
