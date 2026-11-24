# Changelog

## [0.20.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.19.0...mobile-v0.20.0) (2026-11-24)


### Features

* **domain,server,db,console,contracts,observability:** abandonment grace per campaign (default 3 s), a Resume warning and answer-to-audio on the dashboard ([#124](https://github.com/sapieonic/magick-agency/issues/124)) ([9cf0280](https://github.com/sapieonic/magick-agency/commit/9cf02808fb1101b968791a2bb4129430be91a015))
* **server,console,mobile,contracts,domain:** More details under the agent station's customer card (AS20) ([#123](https://github.com/sapieonic/magick-agency/issues/123)) ([7fc1aa5](https://github.com/sapieonic/magick-agency/commit/7fc1aa58b09ab0475c02c733a9ce3e8e1dcf2714))

## [0.19.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.18.0...mobile-v0.19.0) (2026-11-23)


### Features

* **server,console,mobile,contracts,db:** one call log for dialler, soft-phone and inbound calls, and "Every call must belong to a campaign" ([#120](https://github.com/sapieonic/magick-agency/issues/120)) ([9f4e07e](https://github.com/sapieonic/magick-agency/commit/9f4e07e60ff3468bf21a284c8369f1d6aa0e8f49))

## [0.18.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.17.0...mobile-v0.18.0) (2026-11-21)


### Features

* **server,console,mobile,contracts,domain:** supervisors choose the customer card's facts, with per-campaign script keys (AS19) ([#114](https://github.com/sapieonic/magick-agency/issues/114)) ([5a55653](https://github.com/sapieonic/magick-agency/commit/5a556535f59d22f2cc60e67c61e93fec4340552f))

## [0.17.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.16.0...mobile-v0.17.0) (2026-11-20)


### Features

* **server,console,mobile,contracts,db:** the agent station redesign, phases 0 to 2 ([#110](https://github.com/sapieonic/magick-agency/issues/110)) ([d3d50e2](https://github.com/sapieonic/magick-agency/commit/d3d50e295e377d42c4bb583dbce05e46dff89c92))

## [0.16.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.15.0...mobile-v0.16.0) (2026-11-19)


### Features

* **console,server,mobile:** the Live floor's Phase 3 ([#102](https://github.com/sapieonic/magick-agency/issues/102)) ([8ef92ac](https://github.com/sapieonic/magick-agency/commit/8ef92acfc0262adaa4a6c2af0771ef327eea824c))

## [0.15.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.14.0...mobile-v0.15.0) (2026-11-17)


### Features

* **server,console,mobile:** live call listening for supervisors ([#94](https://github.com/sapieonic/magick-agency/issues/94)) ([53dbadc](https://github.com/sapieonic/magick-agency/commit/53dbadcc931827421960f5dda7ae0968d747746c))

## [0.14.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.13.0...mobile-v0.14.0) (2026-11-16)


### Features

* **server,console,mobile,contracts,db,report-renderer:** honour recording off, promise to pay, Do Not Call scope, soft-phone results and a checked import ([#90](https://github.com/sapieonic/magick-agency/issues/90)) ([69c4ffc](https://github.com/sapieonic/magick-agency/commit/69c4ffc0816044abad051eba6f44199c2965a325))

## [0.13.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.12.0...mobile-v0.13.0) (2026-11-15)


### Features

* **server,console,mobile:** show "Dialling a customer…" while a hidden dial rings ([#88](https://github.com/sapieonic/magick-agency/issues/88)) ([fc2527c](https://github.com/sapieonic/magick-agency/commit/fc2527c8ef15021d5ba7b44aff06f4c3a8b0b2fb))

## [0.12.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.11.0...mobile-v0.12.0) (2026-11-13)


### Features

* **server,mobile:** ring an away agent's phone for inbound calls (Mode B) ([#80](https://github.com/sapieonic/magick-agency/issues/80)) ([f3e2e53](https://github.com/sapieonic/magick-agency/commit/f3e2e53fd7ccbfb31c15de120f84fe01a4d06fdc))

## [0.11.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.10.0...mobile-v0.11.0) (2026-11-12)


### Features

* **server,console,mobile,contracts,db:** one station per agent, on one device, across tenants ([#75](https://github.com/sapieonic/magick-agency/issues/75)) ([35a7608](https://github.com/sapieonic/magick-agency/commit/35a7608ff98bd938c2a2387daf51e711679d4bc7))

## [0.10.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.9.1...mobile-v0.10.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **console,server,contracts,db,mobile:** AgencyHomeCampaign drops callbacks_overdue for allocation, staffing, today and settings.

### Features

* **console,server,contracts,db,mobile:** one console shell with Home, a Settings hub and one search ([#76](https://github.com/sapieonic/magick-agency/issues/76)) ([71960ed](https://github.com/sapieonic/magick-agency/commit/71960ed438e219fd63e922066af0b41b84cc8b79))

## [0.9.1](https://github.com/sapieonic/magick-agency/compare/mobile-v0.9.0...mobile-v0.9.1) (2026-11-11)


### Bug Fixes

* **mobile:** ignore a finger lifted after the hold-to-confirm bar has gone ([#72](https://github.com/sapieonic/magick-agency/issues/72)) ([2e934c5](https://github.com/sapieonic/magick-agency/commit/2e934c52f0efd8d4296835fde2fe8fcd349376cc))

## [0.9.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.8.0...mobile-v0.9.0) (2026-11-11)


### Features

* **server,mobile,contracts,console:** take inbound calls on the agent app's station ([#71](https://github.com/sapieonic/magick-agency/issues/71)) ([bff4694](https://github.com/sapieonic/magick-agency/commit/bff4694127b18ad53d41c873f3081c175196bf52))

## [0.8.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.7.0...mobile-v0.8.0) (2026-11-10)


### Features

* **server,console,super-admin,contracts,db,domain,observability,mobile:** inbound calls on Plivo numbers, with sticky agents, a team queue and Missed calls ([#66](https://github.com/sapieonic/magick-agency/issues/66)) ([851a9a8](https://github.com/sapieonic/magick-agency/commit/851a9a88dade52ce09cc020ff0f048dd1ac1ab4c))

## [0.7.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.6.0...mobile-v0.7.0) (2026-11-07)


### Features

* **server,console,super-admin,contracts,db,mobile:** Plivo on tenants' own carrier accounts ([#56](https://github.com/sapieonic/magick-agency/issues/56)) ([1b3384a](https://github.com/sapieonic/magick-agency/commit/1b3384a05e9906efec2e9be5631f192115d4cd4e))

## [0.6.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.5.0...mobile-v0.6.0) (2026-11-07)


### Features

* **server,console,mobile:** customer history, one number across the tenant's campaigns ([#50](https://github.com/sapieonic/magick-agency/issues/50)) ([d1c9f78](https://github.com/sapieonic/magick-agency/commit/d1c9f786476a8f287248126ff98c93a9458aab9e))

## [0.5.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.4.0...mobile-v0.5.0) (2026-11-05)


### Features

* **server,console,mobile,db,contracts:** campaign insights page ([#39](https://github.com/sapieonic/magick-agency/issues/39)) ([2183301](https://github.com/sapieonic/magick-agency/commit/2183301fdb6d384839a3af359de0740bfcd742de))

## [0.4.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.3.0...mobile-v0.4.0) (2026-11-04)


### Features

* **server,console,mobile,contracts,db,domain:** contact assignment, My contacts and agent retry ([#33](https://github.com/sapieonic/magick-agency/issues/33)) ([38aea1b](https://github.com/sapieonic/magick-agency/commit/38aea1b1d660a56c2f9d25885511f391dbd4905c))

## [0.3.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.2.1...mobile-v0.3.0) (2026-11-03)


### Features

* **server,console,mobile,contracts,db,domain:** redial the same customer from the wrap-up screen ([#31](https://github.com/sapieonic/magick-agency/issues/31)) ([a3cf3ae](https://github.com/sapieonic/magick-agency/commit/a3cf3aef0c5c34833be7f1c000dbec88570d758e))

## [0.2.1](https://github.com/sapieonic/magick-agency/compare/mobile-v0.2.0...mobile-v0.2.1) (2026-11-01)


### Bug Fixes

* **mobile:** hold Firebase on the iOS SDK 12 line so the iOS Swift packages resolve ([#25](https://github.com/sapieonic/magick-agency/issues/25)) ([ea69e37](https://github.com/sapieonic/magick-agency/commit/ea69e37590892b1863a1beb0d3192124893ee88a))

## [0.2.0](https://github.com/sapieonic/magick-agency/compare/mobile-v0.1.0...mobile-v0.2.0) (2026-11-01)


### Features

* **mobile,server:** agent mobile app V1 with the soft phone, and its server support ([#22](https://github.com/sapieonic/magick-agency/issues/22)) ([61fa54b](https://github.com/sapieonic/magick-agency/commit/61fa54ba8f172daca8a1cdce50a99f70c0b5ba7e))
* **mobile:** PostHog telemetry for failures and calls, and tab labels that do not wrap ([#23](https://github.com/sapieonic/magick-agency/issues/23)) ([aedc13a](https://github.com/sapieonic/magick-agency/commit/aedc13a6aa73391c9439d2b5aefcfdec9dd862e6))
