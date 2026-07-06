# Nitya Home-Screen Widget — setup record

> **STATUS: DONE (2026-07-04).** The widget target was created programmatically
> (xcodeproj gem), the App Group was registered via `xcodebuild
> -allowProvisioningUpdates`, and the widget is verified working on device.
> Nothing below needs to be repeated — kept as a record + test checklist.
> Gotcha for future changes: `npx cap sync ios` copies `www/` AS-IS; after
> editing app.js you must run `npm run build:ios` (build-www + sync) or the
> native app ships stale web assets.

## What's already done (in the repo)
- `App/NityaWidgetPlugin.swift` — Capacitor plugin that writes the Nitya list to the App Group and reloads the widget.
- `NityaWidget/NityaWidget.swift` — the SwiftUI widget (medium + large), each row deep-links via `mysanskar://nitya/play?id=<trackId>`.
- `NityaWidget/Info.plist`, `NityaWidget/NityaWidget.entitlements`.
- `App/AppRelease.entitlements` — App Group `group.com.ankitpatel5.mysanskar` added.
- `App/Info.plist` — `mysanskar` URL scheme registered.
- `app.js` — syncs the list on every change and handles the play deep link (warm + cold launch).
- `@capacitor/app` added to package.json.

## Steps in Xcode (~15 min)

1. **Sync Capacitor** (Terminal): `npm install && npx cap sync ios`
   (installs @capacitor/app, so `Capacitor.Plugins.App` exists at runtime).

2. **Create the widget target**: File ▸ New ▸ Target ▸ **Widget Extension**.
   - Product name: `NityaWidget`  ·  uncheck "Include Live Activity" / "Include Configuration Intent".
   - When prompted "Activate scheme?", click Activate.
   - Delete the auto-generated `NityaWidget.swift`/bundle Xcode created, then
     **add the existing** `NityaWidget/NityaWidget.swift` to the new target
     (File ▸ Add Files…, and check the NityaWidget target only).
   - Point the target's Info.plist / entitlements at the ones in `NityaWidget/`.

3. **App Group** — Signing & Capabilities ▸ **+ Capability ▸ App Groups** on BOTH
   the `App` target and the `NityaWidget` target. Add `group.com.ankitpatel5.mysanskar`.
   (Register it on developer.apple.com if it isn't there — team `JSWDSX636T`.)

4. **Widget deployment target**: set NityaWidget's Minimum Deployments to iOS 15.0
   (matches the app; the code has an iOS-17 `containerBackground` fallback).

5. **Confirm the plugin is registered** — `NityaWidgetPlugin.swift` conforms to
   `CAPBridgedPlugin`, so Capacitor auto-loads it. Nothing else needed.

6. **Build & run** on device. Then long-press the home screen ▸ **+** ▸ search
   "mySanskar" ▸ add the **Nitya** widget.

## Test checklist
- Edit Nitya in the app → widget updates within a few seconds.
- Tap a song on the widget with the app closed → app cold-launches and plays it.
- Tap a song with the app already open → it switches to that track.
- Empty Nitya → widget shows the "Add songs" empty state.

## Notes
- `npx cap sync ios` only copies web assets; it never touches the widget target or these files.
- Playback is "open app + play" by design (no AppIntents) so it works on iOS 15+.
