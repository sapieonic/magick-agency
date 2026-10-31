# Changelog

## [0.2.0](https://github.com/sapieonic/magick-agency/compare/server-v0.1.0...server-v0.2.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* **server,console,super-admin:** an account_admin, tenant_admin or tenant_owner invitation can no longer be accepted from a sign-in on a different email address.

### Features

* **server,console:** soft phone: ad hoc dialing, campaign-tagged outcomes and call fields, switch from a running campaign ([#21](https://github.com/sapieonic/magick-agency/issues/21)) ([335ffce](https://github.com/sapieonic/magick-agency/commit/335ffce169082af4cddebf7640d70c371262cd29))


### Bug Fixes

* **server,console,super-admin:** send invite emails to every invited role ([#20](https://github.com/sapieonic/magick-agency/issues/20)) ([c9fd548](https://github.com/sapieonic/magick-agency/commit/c9fd5481ab6eb09509dea2905953efd7409a5005))
* **server:** load, soak and scenario suites for a full floor, and 11 defects they found ([#18](https://github.com/sapieonic/magick-agency/issues/18)) ([f6e0dfa](https://github.com/sapieonic/magick-agency/commit/f6e0dfa4f261e5468c726df875517f0417a1eb6d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @magick-agency/contracts bumped to 0.2.0
    * @magick-agency/db bumped to 0.2.0
    * @magick-agency/domain bumped to 0.2.0
    * @magick-agency/observability bumped to 0.2.0
