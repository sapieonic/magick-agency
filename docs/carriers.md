# Carriers: service accounts, tenant accounts, and adding a carrier

How a carrier (VoiceLink, Plivo, a future one) plugs into the voice engine, which carrier
**accounts** a call may be placed on, and the rulings CR1–CR14 that let VoiceLink run on a
tenant's own account (bring-your-own-carrier, BYOC) as Plivo does. Amends B18 (VoiceLink was the
service's account only). Rulings are **default, pending Manas** until he ratifies them.

## 1. Where things stood (2026-11-25)

The bridge was already carrier-neutral: media protocol, hangup style, lifecycle reading and
ringing behaviour come from a `CarrierModule` (`telephony/carrier-module.ts`). Dial, hangup and
callback paths choose an adapter by whether the call row has a `telephony_credential_id` set,
not by the carrier's name. That part needed nothing.

What was not neutral was the line above it. One test, "does this carrier have a credential spec?"
(`findCredentialSpec(p) !== undefined`), decided that a carrier is **either** the service's own
account (configured from env, credential always null) **or** tenant accounts only (credential
always set). Campaign writes, the carriers list, adding numbers by hand, the super-admin "Add
number" modal and recording access all read it. A credential spec for VoiceLink would have
switched off its service account in all of them at once. The pieces a carrier registers were also
spread across six name-keyed lists and switches: modules, the ringing catalogue, credential
specs, the adapter switch plus BYOC map, the webhook-base switch, recording access, and the
direct-recording set. Only some of them were held together by tests.

## 2. The model

### 2.1 Account modes

Every carrier declares which **account modes** it supports:

| Mode | Credential on the call, campaign and number | Configured by | Today |
|---|---|---|---|
| `service` | `NULL` | env (`config.telephony.<carrier>`) | VoiceLink |
| `tenant` | a `telephony_credentials` row of the call's tenant and carrier | super-admin, sealed in Postgres (B19) | Plivo, VoiceLink |

A carrier may support one mode or both. Every rule that used to ask "does it have a spec?" now
asks the specific question:

- `carrierHasServiceAccount(p)`: may a campaign, number or call on `p` have a null credential?
- `carrierTakesTenantAccounts(p)`: may it have a credential set?
- `carrierAccountModeAllowed(p, credentialId)`: the check for one row.

### 2.2 The carrier catalogue (one list, no codecs)

`telephony/carrier-catalog.ts` lists every carrier once. It is built from each carrier's own
`<carrier>/<carrier>.capabilities.ts`, which loads no codecs, so the agency repository and route
code can read it cheaply (the reason `carrier-ringing.ts` existed). Each entry has:

```ts
interface CarrierDescriptor {
  name: string;                                  // agency_calls.provider, telephony_providers.name
  cancelsRinging: boolean;                       // SP3 (was carrier-ringing.ts)
  accounts: { service: boolean; tenant: boolean };
  inbound: boolean;                              // tenant-account inbound (docs/inbound.md); Plivo only
  serviceRecordingsArePublic: boolean;           // service-account recording URLs go to the client as-is
  webhookBaseUrl(telephony: TelephonyConfig): string; // env only, never tenant data
}
```

These derive from the descriptor plus the credential spec, never from a name:

- **Number source** of a tenant-account carrier: `sync` when its spec has `listNumbers` (Plivo),
  otherwise `manual` (VoiceLink, CR6).
- **Inbound** controls: shown only when `inbound` is true (CR11).

### 2.3 The heavier per-mode pieces

Each lives next to what it serves, keyed by name. One conformance test holds every list equal to
the catalogue (§4).

| Piece | Where | Required when |
|---|---|---|
| `CarrierModule` (media, hangup style, lifecycle) | `<carrier>/<carrier>.media.ts`, listed in `carrier-modules.ts` | always |
| Service adapter from env | `SERVICE_ADAPTERS` in `factory.ts` | `accounts.service` |
| Tenant adapter from a resolved credential | `TENANT_ADAPTERS` in `factory.ts` (was `BYOC_ADAPTERS`) | `accounts.tenant` |
| Credential spec (fields, schemas, `check`, optional `listNumbers`, optional `reservedAccountRefs`) | `<carrier>/<carrier>.credential-spec.ts`, listed in `credentials/credential-specs.ts` | `accounts.tenant` |
| Recording access (`service` and/or `tenant` entry) | `recording-access.ts` | for each supported mode |
| Callback routes | `api/routes/webhooks/<carrier>.ts` | always |

`factory.ts` keeps no `switch` on a name. `buildProviderConfig` and `instantiate` become a lookup
in `SERVICE_ADAPTERS`. `webhook-url-builder.ts` reads `descriptor.webhookBaseUrl`.
`recording-url-resolver.ts` reads `serviceRecordingsArePublic`.

## 3. Rulings

| ID | Ruling | Status |
|---|---|---|
| CR1 | A carrier supports the service account, tenant accounts, or both, as its catalogue entry declares. VoiceLink supports both. Plivo supports tenant accounts only. A row's credential is null exactly when it is on the service account. Every write and dial rule reads the account mode, never the carrier's name | default, pending Manas |
| CR2 | VoiceLink on a tenant account: the credential is the tenant's VoiceLink login. `username` is public; it is the account reference shown to super-admins and is unique per carrier, as Plivo's Auth ID is. `password` is sealed and write-only (B19, B20). The API host and the webhook base are this deployment's (`VOICELINK_BASE_URL`, `VOICELINK_WEBHOOK_BASE_URL`), never the tenant's (the SSRF rule in `factory.ts`). While `VOICELINK_BASE_URL` is unset, a check answers "carrier unreachable" and nothing dials | default, pending Manas |
| CR3 | A VoiceLink credential is checked by logging in (`POST /v1/auth/login`), with redirects refused and a 10 s bound. 2xx with a token is `ok`. 401, 403 and 422 are `rejected`. Anything else is `unreachable`. The username of the service's own VoiceLink account is reserved: a tenant credential naming it is refused at create and rotate (`reservedAccountRefs`, compared case-insensitively), so a tenant can never dial on the service's account under a credential of its own | default, pending Manas |
| CR4 | A VoiceLink tenant adapter logs in with the credential. It shares one token per credential and secret version between its dial and call-control adapters, so the two never log each other out. A login refused with 401, 403 or 422, or an `add_lead` still refused 401 after one re-login, is `CarrierAuthRejectedError`. PL2 then applies unchanged: the campaign pauses `carrier_auth` and the credential is marked `invalid` against that secret version. Any other 4xx on `add_lead` is `CarrierDialRefusedError`, so the PL11 breaker counts it. The service account's error classes are unchanged | default, pending Manas |
| CR5 | Everything else about a VoiceLink call is the same on either account: A-law media, the stream URL in `add_lead`, no hangup API (`close_media`), ringing that cannot be cancelled (SP3), the queued-dial pickup timeout, and the token-only status callback (VoiceLink signs nothing) | default, pending Manas |
| CR6 | VoiceLink has no API to list an account's numbers, so a tenant VoiceLink number is added by hand by a super-admin and **pinned** to one of the tenant's VoiceLink credentials. `POST /super-admin/phone-numbers` takes an optional `telephony_credential_id`. A null credential is accepted only on a carrier with a service account. A credential is accepted only on a carrier whose tenant-account numbers are `manual`. The credential must be `active` and of that carrier. The number is assigned untagged to the credential's tenant in the same transaction, as a sync does (PL5). A carrier whose numbers are synced (Plivo) still refuses numbers added by hand. A number's pin never changes after it is created | default, pending Manas |
| CR7 | A pinned number follows PL4 and PL13 whichever way it was pinned (synced or by hand): it is offered as a caller ID only while its credential is `active`, a campaign on that credential dials only from it, and it cannot be assigned to another tenant | default, pending Manas |
| CR8 | A campaign's carrier account is valid when the carrier supports its mode (CR1): a null credential needs a service account; a set credential needs tenant accounts and an `active` credential of this tenant and carrier (unchanged). Moving between the two modes on one carrier is a carrier-account change, judged as one (all caller IDs re-checked) | default, pending Manas |
| CR9 | A service-account campaign may not take a caller ID that is a number pinned to any credential. It would dial the tenant's DID on the service's account. This is checked at the write for the IDs the write adds (as PL13 does for pinned campaigns). Before this ruling the server only checked the shape of such IDs, and only the console filtered them | default, pending Manas |
| CR10 | `GET /proxy/agency/carriers` offers the service account of every carrier that has one and can dial (PL12), plus every `active` credential of the tenant on a carrier that takes tenant accounts and can dial. The console names each by alias plus account label (PL10). The service account's label is the alias alone | default, pending Manas |
| CR11 | Inbound stays Plivo-only (`inbound: true` only on Plivo). Every inbound action on a credential, Link included, is refused for a carrier without it (`inbound_not_supported`). The super-admin console shows inbound controls and the "Sync numbers" button only where the carrier's capabilities allow them. The API now says so (`supports_inbound`, `number_source`) | default, pending Manas |
| CR12 | Recordings of a call pinned to a credential always go through the recording proxy, never to the client as a raw URL, even on a carrier whose service-account recordings are public (VoiceLink). Revoking the credential therefore ends playback and analysis on every carrier, as B21 says. A VoiceLink tenant recording is fetched from the same configured hosts (`VOICELINK_RECORDING_ALLOWED_HOSTS`) with no credential attached, because VoiceLink serves recordings unauthenticated. The pinned credential is still resolved for `recording` first | default, pending Manas |
| CR13 | Concurrency (B22): a VoiceLink call on a tenant account takes the same global, account and per-account provider slots as one on the service account. An account's VoiceLink allocation in `provider_breakdown` covers both its accounts. Allocation per credential is not built | default, pending Manas |
| CR14 | Adding a carrier means: a folder `telephony/<carrier>/` with its capabilities (catalogue entry), carrier module, adapter(s), credential spec when it takes tenant accounts, callback routes, recording access per mode, and one line in each registry list. Any piece missing for a declared mode fails `test/unit/telephony/carrier-conformance.test.ts`. No code outside `telephony/` and the carrier's own routes branches on its name | default, pending Manas |

## 4. Conformance (the guard that makes a new carrier fall into place)

`apps/server/test/unit/telephony/carrier-conformance.test.ts` walks the catalogue and fails when:

- a catalogue name has no carrier module, or a module has no catalogue entry;
- `accounts.service` has no service adapter, or a service adapter's carrier does not declare it;
- `accounts.tenant` has no credential spec, no tenant adapter or no tenant recording entry, or a
  spec or tenant adapter exists for a carrier that does not declare it;
- `accounts.service` has no service recording entry;
- an adapter's `capabilities.cancelRinging` differs from the catalogue's `cancelsRinging`;
- `inbound` is declared by a carrier whose tenant adapter cannot serve inbound.

`provider-capabilities.test.ts` and `carrier-modules.test.ts` keep their own checks and read the
catalogue rather than separate name lists.

## 5. Build plan

| Step | What | Behaviour change |
|---|---|---|
| 1 Foundation | Catalogue and mode helpers; specs moved into carrier folders; `SERVICE_ADAPTERS` and `TENANT_ADAPTERS`; webhook base and direct recordings from the catalogue; recording access per mode; conformance test; every "has a spec" reader moved onto the mode helpers | none (VoiceLink still `tenant: false`) |
| 2 VoiceLink tenant account | Credential spec (CR2, CR3), tenant adapter and shared token (CR4), typed errors, tenant recording entry (CR12), `tenant: true`; unit, mock-carrier and an end-to-end integration test like `plivo-call-e2e` | VoiceLink credentials can be created and dialled on |
| 3 Write rules | Campaign mode rule (CR8), service caller IDs (CR9), carriers list (CR10), numbers by hand pinned to a credential (CR6, CR7), provider capability fields, inbound gate (CR11); contracts | the server enforces CR6–CR11 |
| 4 Consoles | Super-admin: "Add number" takes a credential where CR6 allows it; Sync and inbound controls follow capabilities; carrier copy. Console: carrier labels (CR10) | operators can run it end to end |
| 5 Docs and review | `decisions.md` (B18 amended, CR1–CR14), `modules.md`, `seams.md`, `status.md`; independent review | none |

Steps 2 and 3 run side by side, since they touch disjoint files. Step 3 tests the hybrid rules
against a catalogue double, so it does not wait for step 2's flag.

## 6. Open with Manas

- **CR2:** is a tenant's VoiceLink account always on the same API host as ours? If some tenants are
  on another VoiceLink host, the host becomes a per-carrier allow-list in code (never tenant data)
  that a credential picks from.
- **CR13:** is one VoiceLink allocation per account enough, or should a tenant's own VoiceLink account
  have its own channel cap?
- **Production config:** `VOICELINK_USERNAME` and `VOICELINK_PASSWORD` are still required in
  production. A deployment that runs VoiceLink only on tenant accounts would need them made optional.
  Not changed here.
