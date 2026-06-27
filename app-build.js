// app-build.js — carries the installed app's version into the web layer.
// This committed file is the WEB fallback (no native version on the PWA).
// For native builds, scripts/build-www.sh overwrites this in www/ with the
// real MARKETING_VERSION / CURRENT_PROJECT_VERSION read from the Xcode project.
window.APP_BUILD = { version: null, build: null };
