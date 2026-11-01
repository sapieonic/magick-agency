# Magick Agency agent app

The agent-only mobile app: one Flutter project that builds the Android and the iOS app. Agents
sign in, go on duty on a campaign, take power-dialled calls, write up each call and see their own
numbers. There is nothing for supervisors or admins here; those stay in the web consoles.

It is a second client of the same server the web console uses: the public API under `/auth`,
`/accounts`, `/proxy/agency/*`, and the station WebSocket `/proxy/agency/station/:sessionId`, which
carries the station's frames and the call audio. How the server side works is in
`docs/architecture.md`; the reasoning behind the app's shape is in `docs/mobile.md`.

## Layout

```
apps/mobile/
  pubspec.yaml          the app, and the root of a Dart pub workspace (the two packages below)
  lib/
    main.dart           start-up: env, client identity, Firebase, providers
    app/                router, tabbed shell, theme (tokens mirrored from packages/web-ui)
    core/
      api/              ApiClient: Firebase bearer, X-Tenant-Id/X-Account-Id, X-Client, typed errors
      auth/             the app gate (signed out → ready), Firebase sign-in
      station/          station socket, state machine, actions; station_view.dart is the UI seam
      audio/            AudioEngine facade over packages/agent_audio
      lifecycle/        foreground/background rules (the device_away pause), wake lock
      telemetry/        PII-masking log
    features/           one folder per screen family: auth, join, accounts, campaigns, preflight,
                        station, performance, calls, settings
    ui/                 shared primitives (pills, cards, the live dot)
  packages/
    agency_wire/        wire types for the API and the station socket, hand-written against
                        packages/contracts and checked by its fixtures (packages/contracts/fixtures/agent)
    agent_audio/        the native voice engine: capture, playback, echo cancellation, routes,
                        CallKit (iOS) and the on-duty foreground service (Android)
  android/  ios/        the platform hosts
  env/                  dev.json, staging.json, prod.json: build-time config (no secrets);
                        your own copies go in *.local.json (git-ignored)
  assets/               bundled fonts and the brand mark
  brands/magick-agency/ source artwork for icons
  dev-setup.md          setting up a Linux or macOS machine to build and run the app
```

## Setting up and running

**[`dev-setup.md`](dev-setup.md)** takes a Linux or macOS machine from nothing to the app running
against your local server: Flutter, JDK, the Android SDK and an emulator, Xcode, the server, the
Firebase keys, the right `API_ORIGIN` for each kind of device, and the usual failures.

In short, once set up:

```bash
cd apps/mobile
flutter pub get
cp env/dev.json env/dev.local.json            # once; fill in your Firebase values (git-ignored)
flutter run --flavor dev --dart-define-from-file=env/dev.local.json   # Android
flutter run --dart-define-from-file=env/dev.local.json                # iOS (no flavours yet)
```

- Toolchain: Flutter **3.47.7** (Dart 3.13), pinned in `.github/workflows/mobile.yml`; JDK 17; the
  Android SDK with platform 37; Xcode on a Mac for iOS.
- `API_ORIGIN`: `http://10.0.2.2:3021` on the Android emulator (the default), `http://localhost:3021`
  on the iOS simulator or on a USB Android phone with `adb reverse tcp:3021 tcp:3021`.
- Plain HTTP is allowed only in Android debug builds and only to `10.0.2.2` and `localhost`
  (`android/app/src/debug/res/xml/network_security_config.xml`); release builds are HTTPS/WSS only.

## Tests

```bash
cd apps/mobile
flutter analyze
flutter test                          # the app
(cd packages/agency_wire && dart test)
(cd packages/agent_audio && flutter test)
node ../../tooling/contracts-literals.mjs --check   # TS literal unions vs the Dart enums' source
```

## Releases and builds

- Version: `pubspec.yaml` `version:` belongs to release-please (component `mobile`, `release-type: dart`);
  never edit it by hand (root `CLAUDE.md`). Store build numbers come from CI (`--build-number`).
- Android flavours `dev`, `staging`, `prod` install side by side (`com.magickagency.agent[.dev|.staging]`).
  Release signing reads `android/key.properties` (never committed); a release build fails without a
  complete one unless `-PallowDebugSigning=true` is passed.
- Invite links: `https://<console host>/agency/join/<token>` opens the app when the console host
  serves `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` (see
  `DEPLOYMENT.md`) and the host is set in `android/app/build.gradle.kts` (`appLinkHost`) and
  `ios/Runner/Runner.entitlements`.
