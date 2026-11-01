# apps/mobile

The agent-only Flutter app (Android and iOS): sign in, go on duty on a campaign, take
power-dialled calls, dial on the soft phone, write up calls, see own stats. A second client of the
same server API and station socket the console uses. Not a pnpm package: pnpm scripts do not
build or test it.

Read first: `README.md` (layout, commands), `docs/mobile.md` (scope, the foreground rule and
`device_away`, the station socket with `client=mobile&media=alaw8`, inside the app, UX rules,
what is not verified), `dev-setup.md` (toolchain, emulators, `API_ORIGIN`, Firebase keys).

## Commands

Flutter **3.47.7** (Dart 3.13), pinned in `.github/workflows/mobile.yml`. From this directory:

```bash
flutter pub get
flutter analyze
flutter test
(cd packages/agency_wire && dart test)
(cd packages/agent_audio && flutter test)
node ../../tooling/contracts-literals.mjs --check
flutter run --flavor dev --dart-define-from-file=env/dev.local.json   # Android; iOS has no flavours
```

## Rules

- **Wire types are hand-written** in `packages/agency_wire` against `packages/contracts`, and are
  checked by its fixtures (`packages/contracts/fixtures/agent/*.json`, including `literals.json`).
  A contract change lands with the Dart change in the same commit; see
  `packages/contracts/CLAUDE.md` for regenerating the literals.
- **UI seams:** station screens read only `lib/core/station/station_view.dart`; soft-phone
  screens only `lib/core/softphone/softphone_view.dart`. Do not reach into the controllers.
- **The app gate** (`lib/core/auth/app_gate.dart`) decides every top-level screen. A 401 never
  signs out during a live call, wrap-up or an owed soft-phone outcome; offline never signs out.
- **Media path:** no per-frame JSON or copies on the 50 fps audio path; one platform message per
  20 ms frame. Native audio lives in `packages/agent_audio` (Kotlin and Swift).
- **Telemetry** (`lib/core/telemetry/`): logs and PostHog events are PII-masked, and event names
  match the console's (`apps/console/src/analytics/`).
- Theme tokens in `lib/app/theme/` mirror `packages/web-ui/src/global.css` by hand.
- Config is build-time only (`env/*.json`, no secrets). Personal copies go in
  `env/*.local.json` (git-ignored); never commit Firebase keys.
- `pubspec.yaml` `version:` belongs to release-please (component `mobile`, `release-type: dart`);
  store build numbers come from CI. Never edit it by hand.
- iOS does not build yet (a CocoaPods/SPM dependency conflict, `docs/mobile.md` "Not verified
  yet"), and nothing has run on a real phone or carrier. Do not claim either works.
