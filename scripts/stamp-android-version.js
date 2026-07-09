#!/usr/bin/env node
// Re-stamp the Android bundle's app-build.js from android/app/build.gradle, so the
// in-app version on Android reflects the ANDROID versionName/versionCode — not iOS's
// MARKETING_VERSION (which build-www.sh writes, and which cap sync then copies into
// the Android assets). Run after `npx cap sync android`. Keeps the update-banner
// comparison correct on Android even if the two platforms' versions ever diverge.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRADLE = path.join(ROOT, 'android/app/build.gradle');
const DEST = path.join(ROOT, 'android/app/src/main/assets/public/app-build.js');

const gradle = fs.readFileSync(GRADLE, 'utf8');
const name = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const code = (gradle.match(/versionCode\s+(\d+)/) || [])[1];

if (!name || !code) {
  console.error('❌ Could not read versionName/versionCode from build.gradle');
  process.exit(1);
}
if (!fs.existsSync(DEST)) {
  console.error('❌ android app-build.js not found — run `npx cap sync android` first');
  process.exit(1);
}

fs.writeFileSync(DEST, `window.APP_BUILD = { version: "${name}", build: "${code}" };\n`);
console.log(`  ✓ android app-build.js stamped with v${name} (${code})`);
