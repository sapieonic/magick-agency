# Agent app: development setup (Linux and macOS)

Step by step from a clean machine to the agent app running against your local server. Android
builds on Linux and macOS. iOS builds need a Mac with Xcode. What the app is: [`README.md`](README.md)
and [`docs/mobile.md`](../../docs/mobile.md).

## What you need

| Tool | Version | Why |
|---|---|---|
| Flutter | **3.47.7** (Dart 3.13) | The pinned SDK; CI uses the same (`.github/workflows/mobile.yml`) |
| JDK | **17** | Gradle and the Android Gradle Plugin (AGP 9.1, Gradle 9.3.1, from the wrapper) |
| Android SDK | platform-tools, platform 37, and an emulator image or a phone | The app compiles against API 37; minSdk is 28 (Android 9) |
| Xcode (macOS only) | Xcode 16 or newer, with an iOS 16+ simulator | The iOS app; deployment target 16.0 |
| CocoaPods (macOS only) | any recent | Usually not needed: the plugins resolve through Swift Package Manager. Flutter asks for CocoaPods if a plugin needs it |
| Node 22, pnpm 10, Docker | as in the root [`README.md`](../../README.md) | The local server the app talks to |

Disk and memory: about 15 GB for the SDKs and caches. Gradle is given an 8 GB heap
(`android/gradle.properties`); on a machine with less than 16 GB RAM, lower `-Xmx8G` locally
(do not commit the change).

## 1. Flutter

The same steps work on Linux and macOS. They install the pinned version from git into `~/sdk`;
any directory works.

```bash
mkdir -p ~/sdk
git clone --depth 1 --branch 3.47.7 https://github.com/flutter/flutter.git ~/sdk/flutter
echo 'export PATH="$HOME/sdk/flutter/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
export PATH="$HOME/sdk/flutter/bin:$PATH"
flutter --version          # Flutter 3.47.7 … Dart 3.13
flutter config --no-analytics
```

On Linux, the Flutter tool needs `git`, `curl`, `unzip`, `xz-utils` and `zip`:

```bash
sudo apt-get install -y git curl unzip xz-utils zip      # Debian / Ubuntu
```

If you already use a Flutter version manager (fvm, asdf, mise), pin 3.47.7 with it instead.
Another version may resolve different packages and fail the analyzer or the tests.

## 2. JDK 17

```bash
# macOS
brew install openjdk@17
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"

# Debian / Ubuntu
sudo apt-get install -y openjdk-17-jdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64     # arm64: …-arm64
```

Put the `JAVA_HOME` line in your shell profile. `java -version` should print 17.

## 3. Android SDK

**With Android Studio** (simplest on both systems):

1. Install Android Studio.
2. In *Settings › Languages & Frameworks › Android SDK*, install:
   - SDK Platform **Android 17 (API 37)**;
   - SDK Tools › **Android SDK Command-line Tools**, **Platform-Tools** and **Android Emulator**.
3. The SDK lands in `~/Library/Android/sdk` (macOS) or `~/Android/Sdk` (Linux).

**Without Android Studio** (command-line tools only):

```bash
# macOS
brew install --cask android-commandlinetools
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"

# Linux: download "Command line tools only" from developer.android.com/studio, then
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip commandlinetools-linux-*_latest.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"

# Both
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
sdkmanager "platform-tools" "platforms;android-37.0" "emulator"
```

Then, on both paths:

```bash
flutter config --android-sdk "$ANDROID_HOME"     # skip if Flutter already finds it
flutter doctor --android-licenses                # accept all
```

**Platform 37 naming.** AGP 9.1 looks for the platform as `android-37`, but the SDK installs it as
`android-37.0`, and the build fails with *"Failed to find target with hash string 'android-37'"*.
Give it the name AGP asks for, once (CI does the same):

```bash
[ -e "$ANDROID_HOME/platforms/android-37" ] || ln -s android-37.0 "$ANDROID_HOME/platforms/android-37"
```

The first Gradle build downloads the build tools, the NDK and CMake it needs on its own. That
build takes a few minutes; later ones are much faster.

### An emulator

```bash
# Apple silicon and arm64 Linux: use arm64-v8a instead of x86_64
sdkmanager "system-images;android-35;google_apis_playstore;x86_64"
avdmanager create avd -n agent-dev -k "system-images;android-35;google_apis_playstore;x86_64" -d pixel_7
emulator -avd agent-dev &
```

- Pick a **Play Store** image: Google sign-in needs Google Play services.
- **Linux:** the emulator needs KVM. Check with `ls -l /dev/kvm`. If it is missing or not
  yours, enable virtualisation in the BIOS, then:

  ```bash
  sudo apt-get install -y qemu-kvm
  sudo usermod -aG kvm "$USER"
  ```

  Log out and back in.

### A physical Android phone

1. Turn on *Developer options › USB debugging*.
2. Plug the phone in and run `adb devices` (accept the prompt on the phone).
3. See step 7 for reaching your local server from it.

## 4. Xcode and the iOS simulator (macOS only)

```bash
xcode-select --install                                   # command-line tools
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS                         # the iOS simulator runtime
brew install cocoapods                                   # only if flutter doctor asks for it
open -a Simulator
```

For a physical iPhone:

1. Open `ios/Runner.xcworkspace` in Xcode.
2. Under *Runner › Signing & Capabilities*, pick your team. Change the bundle id if
   `com.magickagency.agent` is taken on your account; do not commit that change.
3. On the phone, turn on *Settings › Privacy & Security › Developer Mode*.

## 5. Check the toolchain

```bash
flutter doctor -v
```

What it should report:

- **Linux:** Flutter and Android toolchain green.
- **macOS:** Flutter, Android toolchain and Xcode green.

You can ignore Chrome, Linux desktop and Visual Studio: this app builds for Android and iOS only.

## 6. The local server

The app talks to the same server as the web console. Follow the root [`README.md`](../../README.md)
"Dev setup" once:

1. `pnpm install`
2. `pnpm infra:up`
3. Copy and fill `apps/server/.env`.
4. `pnpm migrate:up`
5. Create the first super-admin.

Then start the server:

```bash
pnpm --filter @magick-agency/server dev      # http://localhost:3021, listens on all interfaces
curl localhost:3021/client-config            # {"mobile":{"min_supported":"0.1.0","latest":"0.1.0"}}
```

To take a call from the app you need:

- an **agent account** (invite one from the console's Team page);
- the dialer flag **`agency_dialer_enabled`** on for its tenant (super-admin console, *Flags*);
- a **running campaign** the agent is staffed on (console › campaign › Agents). An unstaffed
  agent is refused with "You're not assigned to this campaign".

The **Phone tab** (the soft phone) shows only when the soft-phone flag
**`agency_softphone_enabled`** is on for the agent's account. It is off by default. Turn it on
in the super-admin console › the tenant › *Feature Flags*, for the tenant or for one of its
accounts; or set `FF_AGENCY_SOFTPHONE=true` in `apps/server/.env` and restart the server, which
makes it the default everywhere (an override row still wins). Every agent has the permission it
needs (`agency.softphone.dial`). A dial needs a caller ID: a number assigned to the account
(super-admin console › *Phone Numbers*), or one of the campaign's when the call is logged to it.
Without a carrier a dial ends `failed` and unplaced, which is enough to see the screens and the
refusals.

The server's mobile settings (`MOBILE_MIN_SUPPORTED_VERSION`, `MOBILE_LATEST_VERSION`, store
URLs) have working defaults for development.

## 7. Configure the app

`env/dev.json` holds the build-time config. It contains no secrets, but your project's values are
yours: copy it to `env/dev.local.json` (git-ignored, like any `env/*.local.json`) and edit that copy.

```bash
cp env/dev.json env/dev.local.json
```

| Key | Value |
|---|---|
| `API_ORIGIN` | Where the app reaches your server (below) |
| `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID` | The **same Firebase project** as the server's `FIREBASE_PROJECT_ID` and the console's `VITE_FIREBASE_*` |
| `FIREBASE_APP_ID_ANDROID`, `FIREBASE_APP_ID_IOS` | Register an Android app (`com.magickagency.agent.dev`) and an iOS app (`com.magickagency.agent`) in that project, then copy each App ID |
| `GOOGLE_SERVER_CLIENT_ID` | The project's **Web** OAuth client id (Firebase › Authentication › Google › Web SDK configuration). Google sign-in on Android needs it |
| `GOOGLE_IOS_CLIENT_ID` | The iOS OAuth client id. Google sign-in on iOS also needs its reversed form as a URL scheme in `ios/Runner/Info.plist` (`CFBundleURLTypes`). The committed scheme is this repo's Firebase project's; with another project, replace it with yours |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Optional. A PostHog project key turns telemetry on (failures and call events, `docs/mobile.md` "Logs and telemetry"); empty means none. The host defaults to PostHog's US cloud |

For **Google sign-in on Android**, add your debug keystore's SHA-1 to the Android app in Firebase.
Print it with:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA1
```

With the Firebase keys empty, or without this platform's `FIREBASE_APP_ID_*`, the app starts
and stays on the sign-in screen. If Firebase fails to start for another reason, the app logs it
and starts the same way.

**`API_ORIGIN` by device:**

| Device | `API_ORIGIN` | Notes |
|---|---|---|
| Android emulator | `http://10.0.2.2:3021` (the default) | `10.0.2.2` is the host machine |
| Android phone over USB | `http://localhost:3021` | Run `adb reverse tcp:3021 tcp:3021` after each plug-in |
| iOS simulator | `http://localhost:3021` | The simulator shares the Mac's network |
| Phone on the same Wi-Fi | `http://<your machine's LAN IP>:3021` | macOS: `ipconfig getifaddr en0`; Linux: `hostname -I`. Allow port 3021 through the firewall |

Plain HTTP is for development only: Android release builds allow HTTPS only.

## 8. Run it

```bash
cd apps/mobile
flutter pub get
flutter devices                                                   # what is connected

# Android: always name the flavour
flutter run --flavor dev --dart-define-from-file=env/dev.local.json

# iOS (no flavours on iOS yet)
flutter run --dart-define-from-file=env/dev.local.json

# Pick a device when several are connected
flutter run -d <device-id> --flavor dev --dart-define-from-file=env/dev.local.json
```

In the running app, press `r` to hot reload and `R` to hot restart. The station's state lives in
providers, so after changing station code prefer `R`, or leave the station and join again.

The `dev` flavour installs as **"MA Agent Dev"** (`com.magickagency.agent.dev`), next to staging
and production builds.

## 9. Before you push

Run the same checks as CI:

```bash
cd apps/mobile
flutter analyze
flutter test
(cd packages/agency_wire && dart test)
(cd packages/agent_audio && flutter test)
node ../../tooling/contracts-literals.mjs --check
flutter build apk --debug --flavor dev --dart-define-from-file=env/dev.json
```

- **Changing a contract** in `packages/contracts`: run `node tooling/contracts-literals.mjs` from
  the repo root, then commit the regenerated `literals.json` with the change. Add or update the
  sample in `packages/contracts/fixtures/agent/` the app decodes.
- **Native tests for the audio engine** (Kotlin), from `android/`, after one `flutter build apk`
  or `flutter run` has written `android/local.properties`:

  ```bash
  ./gradlew :agent_audio:testDebugUnitTest
  ```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to find target with hash string 'android-37'` | The platform symlink in step 3 |
| `:app is currently compiled against android-36` | An old checkout. `android/app/build.gradle.kts` compiles against 37 |
| Gradle stops with "Could not resolve …" or HTTP 429 from Maven Central | A rate limit or proxy. Retry, or point Gradle at a mirror in `~/.gradle/init.d/` (local only, never in the repo) |
| Gradle runs out of memory, or the machine swaps | Lower `org.gradle.jvmargs` in `android/gradle.properties` locally; don't commit it |
| The splash says "You're offline or the connection dropped" (or "took too long") and keeps retrying | Check `API_ORIGIN` for your device (step 7), that the server is up (`curl <origin>/healthz`), and `adb reverse` for a USB phone |
| Signed in, but "We don't recognise that account" | That Firebase user has no membership. Invite it from the console and accept the invite first |
| "You're not assigned to this campaign" | Staff the agent on the campaign in the console |
| Google sign-in fails on Android with code 10 | The debug SHA-1 is missing from the Firebase Android app, or `GOOGLE_SERVER_CLIENT_ID` is not the Web client id |
| The emulator is very slow, or will not start on Linux | KVM (step 3); use an image matching your CPU architecture |
| Microphone checks fail in pre-flight on an emulator | Turn on the emulator's microphone: *Extended controls › Microphone › Virtual microphone uses host audio input* |
| iOS: `CocoaPods not installed` | `brew install cocoapods`, then `flutter run` again |
| iOS: signing errors on a phone | Pick your team in Xcode (step 4). The simulator needs no signing |
| Android: a release build fails on signing | Android release builds need `android/key.properties` with `storeFile`, `storePassword`, `keyAlias` and `keyPassword` (`storeFile` relative to `android/app`) and fail without them. To sign a local release build with the debug key on purpose: `ORG_GRADLE_PROJECT_allowDebugSigning=true flutter build apk --release --flavor <env> --dart-define-from-file=env/<env>.json` |
