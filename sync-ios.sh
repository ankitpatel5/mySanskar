#!/bin/bash
# sync-ios.sh — copy latest source files to www/ and sync to iOS
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "📋 Copying source files to www/..."
cp index.html    www/index.html
cp app.js        www/app.js
cp styles.css    www/styles.css
cp lottie.min.js www/lottie.min.js
cp confetti.json www/confetti.json

echo "📱 Syncing to iOS..."
npx cap sync ios

echo "✅ Done! Rebuild in Xcode to see changes."
