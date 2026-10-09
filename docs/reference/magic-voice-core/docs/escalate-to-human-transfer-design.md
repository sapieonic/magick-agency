> **Reference copy, verbatim below this box.** Origin: magic-voice-core @ `4850d1d9` (v1.123.2), path `docs/escalate-to-human-transfer-design.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** An AI-call transfer design. AI calling is out of scope for Magick Agency; one ported concurrency-guard test cites its §6b rule about the concurrency slot, which still holds for the guard.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# `escalate_to_human` → real phone transfer

*Written when VoBiz was the only carrier that could transfer, and §§1–5 still read that
way. Plivo joined with no new machinery; Twilio needed three different mechanisms and a
fifth webhook — see **§5c**, which is the current statement of how this works.*

Status: **implemented in core** (Phase 1). Billing decision in §6 is settled: the whole
spoken duration is billed. Remaining work — master + cusui surfaces, sequential ring —
is listed in §8.

## 1. What it used to do

Before this change, `escalate_to_human` was **a label, not an action**. The whole
implementation was
`src/tools/platform-tools.ts:51-55`:

```ts
handler: (args, { callId, session }) => {
  session.escalationReason = args['reason'] as string;
  callEventBus.emit('call.escalated', { callId, reason: args['reason'] as string });
  return { success: true, data: { status: 'escalation_initiated' } };
}
```

`CallManager` (`src/core/call-manager.ts:220`) turns that straight into a hangup:

```ts
callEventBus.on('call.escalated', async (data) => {
  await this.handleCallEnd(data.callId, 'escalate_human', 'escalate_human', …, 'escalated');
});
```

So the caller was told "let me connect you to someone" and then hung up on. Note that
`escalate_human` counts as *connected* in `AI_CALLS_CONNECTED_STATUSES`
(`src/db/repositories/usage.repository.ts:23`) and in batch analytics — so it inflated
success metrics for calls that reached no human. §6 explains how that is now separable.

Both emit sites (`platform-tools.ts` and `aiSession.onEscalation`) route through the one
`call.escalated` handler, so the two entry points cannot diverge.

## 2. What VoBiz actually gives us

VoBiz is a Plivo-family API and does support live transfer. Verified from their docs:

**Transfer API** — [`POST https://api.vobiz.ai/api/v1/Account/{auth_id}/Call/{call_uuid}/`](https://vobiz.ai/docs/call/transfer-call)

| Param | Values | Default |
|---|---|---|
| `legs` | `aleg` \| `bleg` \| `both` | `aleg` |
| `aleg_url` | HTTPS URL returning XML | — |
| `aleg_method` | `GET` \| `POST` | `POST` |
| `bleg_url` / `bleg_method` | same | — |

Returns `202 {api_id, message:"call transferred", call_uuid}`. `404` = call inactive.
Auth is the same `X-Auth-ID` / `X-Auth-Token` pair the adapter already sends. Their
stated caveats: the call must be **in-progress**, the transfer URL must be HTTPS and
return XML *fast* "or the leg may drop", and — the load-bearing one —

> "In PSTN transfer XML, set `<Dial callerId>` to a Vobiz number owned or authorized by your account"

**[`<Dial>` XML](https://vobiz.ai/docs/xml/dial)** gives us everything a transfer needs:
`callerId`, `callerName`, `timeout` (ring), `timeLimit` (default 14400), `action`+`method`
(final result, delivers `DialStatus` = completed/busy/failed/… and `DialHangupCause`),
`callbackUrl` (real-time B-leg events, `Event=DialHangup`), `confirmSound`+`confirmKey`+
`confirmTimeout` (**this is the screened/whisper transfer**), `dialMusic` (ringback while
the agent's phone rings), `hangupOnStar`, `sipHeaders`, `redirect`.

**[`<Number>`](https://vobiz.ai/docs/xml/dial/number)** nests inside: multiple `<Number>`
elements ring **simultaneously** and "Vobiz bridges the first destination that answers and
cancels the remaining attempts" — a hunt group for free. `sendDigits` handles extensions.
`<User>` covers SIP/WebRTC destinations.

A [Conference API](https://vobiz.ai/docs/conference/conference-object) exists for true warm
transfer (3-way staging room), which is the Phase 3 shape — out of scope here.

## 3. The flow

```
model calls escalate_to_human(reason, escalate_to?)
  → resolve escalation config from prompt_tools.tool_config
  → resolveEscalationTargets(destination, escalate_to, escalation_number)  ← §4b/§4c boundary
  → not configured / not eligible?  → today's behaviour (end as escalate_human)   [back-compat]
  → eligible:
      CallManager.escalateToHuman()
        1. session.callEndTriggered = true            ← BEFORE anything else
        2. play the handoff line, wait out its duration
        3. VobizAdapter.transferCall(providerCallId, {legs:'aleg', aleg_url})
        4. settle the row as escalate_human + transfer fields
  → VoBiz fetches  POST /webhooks/vobiz/escalate-answer/:callId
      → <Dial callerId=… action=… confirmSound=…><Number>…</Number></Dial>
  → agent answers (optionally after whisper+confirmKey) → caller and human talk
  → POST /webhooks/vobiz/escalate-result/:callId  (DialStatus, DialHangupCause)
      → persist transfer outcome
```

**Step 1 is the subtle one.** The transfer yanks the A-leg out of `<Stream>`, so our media
WebSocket closes. `handleMediaStreamClosed` (`call-manager.ts:1436`) fires `call.completed`
on any session without `callEndTriggered` — which would settle the call as `completed` /
`ended_by='remote'` and *erase the escalation label*. Setting the flag first is what
prevents that; the same guard already protects the AMD auto-hangup race.

**Step 2 matters more than it looks.** Transferring mid-sentence truncates the AI's
goodbye — the caller hears it cut off, which is exactly the complaint class already
documented for barge-in. We have the machinery: pre-synthesize the handoff clip at
pipeline-init the way `prepareSilenceNudgeFallback` does (including its Gemini
voice-continuity rule — a handoff line in a different voice is the same defect that fix
already solved) and play it via `sendAudioToTelephony`.

The wait is on the **clip's own duration** (capped at 8s), not VoBiz's `playedStream`
checkpoint. The checkpoint would be the more precise signal, but it arrives on the very
media socket the transfer is about to close — waiting for it risks waiting forever, and
the customer is mid-handoff. Duration is the reliable bound.

## 4. Who the call goes to

The destination is a **first-class, reusable resource**, not a phone number buried in a
prompt: `escalation_destinations` (migration `062`), tenant/account scoped, with full CRUD
at `/api/v1/escalation-destinations`. A prompt's `escalate_to_human` tool points at one by
id from `prompt_tools.tool_config` — `{ escalation_destination_id }` — exactly the way
`search_catalog` points at a knowledge base, so **no new tool CRUD was needed**.

That shape is the point: the on-call number changes often, and it should change in one
place rather than across every prompt that escalates.

| Field | Meaning |
|---|---|
| `members` (JSONB) | Who to ring: `[{name, type: 'phone'\|'sip', destination, is_active}]`, 1–10. Every active member becomes a sibling `<Number>`/`<User>` in one `<Dial>`, so VoBiz rings them **simultaneously** and bridges the first to answer. |
| `caller_id` | Presented to the agent. Validated against master (`/internal/phone-numbers/validate`) **at write time** — see §5. |
| `mode` | `blind`, or `screened` (whisper + `confirm_key`, so an agent's voicemail can't silently swallow an escalation). |
| `handoff_message` | Spoken by the AI immediately before the transfer; pre-synthesized at pipeline-init. |
| `fallback` / `fallback_message` | What the caller hears when nobody answers. |
| `ring_timeout_seconds` | Per-attempt ring (10–120). |
| `max_transfer_seconds` | Hard ceiling on the bridged conversation (60–14400). Load-bearing: see §6. |
| `allow_dynamic_target` / `dynamic_target_allowed_prefixes` | Whether the AI may name a number that is **not** on this roster, and which prefixes it may use. Off by default — see §4b. |

Members are JSONB rather than a child table because the list is small, always read and
written whole, and has no independent lifecycle — the same call `ivr_workflows.steps` makes.

`strategy` exists but its CHECK admits only `simultaneous`. Sequential (tiered) ring needs a
per-member chained-`<Dial>` state machine; accepting the value and silently ringing everyone
at once would be a lie, so it is rejected until it is built.

Deleting a destination a live prompt points at is a **409** — otherwise that prompt silently
reverts to hanging up on customers who asked for a human.

## 4b. Letting the AI say *who* to escalate to

`escalate_to_human` takes an optional second argument alongside `reason`:

```jsonc
{ "reason": "customer has a billing dispute", "escalate_to": "Billing Team" }
```

`escalate_to` is a **note, not a destination** — and by default not even a request. It is
model output, and model output is downstream of whatever the caller said on the line.
`resolveEscalationTargets` (`src/escalation/helpers.ts`) is the boundary, and the rule it
enforces is that **the configured destination decides who is rung** — the sole exception
being a destination that has explicitly opted into dynamic targets, the third row below:

| Request | Result |
|---|---|
| absent | ring every **active** member of the destination — or, when it has none, the per-call number (§4c) |
| **anything at all** — a member's name, a member's number, an off-roster name, a raw 10-digit number | ring that same list, unchanged. Recorded as `rejected` with the verbatim ask and a reason; changes nobody |
| an **off-roster** E.164 number, on a destination that sets `allow_dynamic_target` | ring that number **instead of** that list — a fully populated roster included — if it matches `dynamic_target_allowed_prefixes` |

> **Changed 2026-09-12 (BKP Homes call `5c0949c6`).** A request matching an active roster
> member used to ring *that member alone* (`source='member'`). It read like pure routing —
> the reachable set is what the operator configured either way — but it is still the model
> choosing which phone rings, off a name it heard from the caller, and an operator had no
> way to see that a destination configured for four people only ever rang one. That tier is
> gone. `source='member'` is retained in the union for reading historical rows and is no
> longer produced.
>
> The refusal reason is also now evaluated **`allow_dynamic_target` first**. When a
> destination has not opted into dynamic targets, "this destination does not take dynamic
> targets" is the whole and true reason, whatever the model emitted; the old order reported
> `not_a_phone_number`, which sent the reader off to fix a number format that would never
> have been dialled.

The dynamic tier is the dangerous one and is **off by default**. With it on, a caller who can talk
the agent into repeating a number back can cause an outbound call to it — a toll-fraud
primitive aimed at premium-rate and international ranges, which is what
`dynamic_target_allowed_prefixes` (e.g. `["+91"]`) exists to bound.

Two properties matter as much as the gate itself:

- **A refusal degrades to the configured dial list, it does not fail the escalation.**
  That list is whatever an absent request would have rung: the full active roster, or the
  per-call number on a destination with no active member. The customer
  asked for a human; refusing to connect them to anybody because the model produced a bad
  argument would punish the caller for the model's mistake.
- **The refused value is persisted verbatim** as `escalation_requested_target`, alongside
  `escalation_target_source` (`roster` / `preset` / `dynamic` / `rejected`; `member` on
  historical rows only). Discarding it
  would erase the only evidence of an attempted redirect. `escalation_target_resolutions_total{source}`
  charts the split — but note `rejected` is now a **level, not an anomaly**: since the model's
  request changes nobody on an ordinary destination, every request lands there, including a
  well-behaved one naming a roster member. Watch a rise relative to that account's own
  baseline, and watch any `dynamic` on an account that should not have the flag on.

Validation is strict E.164 (`/^\+[1-9]\d{6,14}$/`), and it is the gate on the **dynamic
path** — the one path where a model-supplied string can become a dial string, so that
"whatever the model emitted" never does. A lenient parse *there* is the bug.

It is not, however, the first check. `allow_dynamic_target` is evaluated **before** the
format test, so that the refusal *reason* is honest when the destination never opted in:
such a destination reports `dynamic_not_allowed`, because no format would have been
dialled, rather than `not_a_phone_number`, which names a fixable-looking problem that isn't
the one. `not_a_phone_number` is consequently only reachable on a destination that *has*
opted in. Both the ordering and the gate are mutation-tested.

The resolved dial list is persisted as `escalation_targets` (JSONB) and is what the
`escalate-answer` webhook rings. It must be, not the roster: that webhook runs after the
session is gone and possibly on another replica, and the dial list is not always derivable
from the destination row (a per-call number, or a dynamic target). Persisting the decision
is also what makes `resolveEscalationTargets` the *single* place who-gets-rung is decided —
worth keeping that way, since it is the only thing that has to be audited.

## 4c. The per-call escalation number (migration 064)

The two sources above are both configured *ahead of time*: a roster attached to a prompt,
and a number the *model* may request. Neither covers the ordinary case — a campaign where
each customer has their own account manager, so the number is known at dispatch and
differs per call.

That is what `escalation_number` is. It is supplied by the **authenticated API caller**,
which is why it needs none of `escalate_to`'s anti-fraud machinery: the caller is already
tenant-scoped and could have dialled the number directly. Where it comes from:

| Flow | Source |
|---|---|
| `POST /calls` | `config.escalation_number` |
| `POST /calls/bulk` | per-recipient `escalation_number`, else the batch-level default |
| Inbound (direct-to-AI) | the matched intent's number, else the DID's standing default |
| Inbound (IVR → `ai_handoff`) | the step's `escalation_number` (interpolated, so `{{assigned_rep}}` works), else the DID's |
| Intent immediate-callback | the intent's number, else the DID's — same lead, same person |

Inbound has no dispatch request to carry one, so `PhoneNumberResolver` resolves it on the
same intent-beats-DID precedence it already uses for prompt, pipeline, language and first
message. A lead who pre-registered reaches the rep who has their context; everyone else
reaches the desk covering the line.

### A configured destination wins; the preset fills the gap

**Changed 2026-09-12 (BKP Homes call `5c0949c6`).** The preset used to **replace** the
destination's members for the call — "the preset becomes the roster" — and §4b's tiers then
ran against a one-entry roster. That is inverted:

| Destination | Per-call number | Who is rung |
|---|---|---|
| has ≥1 **active** member | — | the destination's active members (`source='roster'`) |
| has ≥1 **active** member | set | **the destination's active members** (`source='roster'`, `presetIgnored: true`) |
| no active member (policy-only row, every member deactivated, or synthesized) | set | the number (`source='preset'`) |
| no active member | — | nobody; the call degrades to the legacy end-call path |

Read that table as the answer for an ordinary destination. The one exception is §4b's
dynamic tier: on a destination that has opted into `allow_dynamic_target`, an accepted
model-supplied number **replaces** whichever list the table produced — a fully populated
roster included — and `source` is `dynamic`. That is the opt-in behaving as configured, not
a hole in the precedence; it stays off by default, which is why the BKP Homes call is fixed
by the table above.

The BKP Homes call carried both: a destination configured for the store executive, and a
per-call number left at a placeholder. The preset won, and the customer who asked for the
Kondapur manager rang a number nobody answered. Both halves were deliberate operator
configuration, only one can win, and the destination is the more specific statement of
intent — an operator who attached a roster to a prompt said *these people handle escalations*.

The losing half is no longer silent: `presetIgnored` comes back on the resolution and
`CallManager.escalateToHuman` logs it at warn with both numbers, so a misconfiguration is
visible from the logs instead of from a customer who reached nobody. It is derived from the
**final** dial list — a dialable preset that is not among the targets — not from which
branch built the roster, so it cannot disagree with what actually rang. Two consequences on
the dynamic path: it is also true when an accepted dynamic target displaces the preset, and
it is *absent* when the model's dynamic number happens to be the preset itself, since then
the preset is exactly what rang.

**The empty-roster case is load-bearing, not an edge case.** A destination that exists
purely to carry policy — whisper text, caller ID, timeouts — for calls that bring their own
number is a supported setup, and `preflightEscalationTransfer` already permits an empty
roster for exactly it. That is why the rule keys on *active members*, not on the presence of
a destination row.

One deliberate non-consequence, unchanged: a per-call number does **not** revoke
`allow_dynamic_target`. That flag is off by default and turned on only by an operator who
decided the AI may reach numbers outside the roster; treating "this call has a default
target" as a silent revocation would break those setups the moment someone also filled in
the escalation-number field. The prefix bounds still apply. Pinned by test, because it reads
as surprising.

### No roster required

Requiring a destination row purely to hold policy would mean an operator who just wants
"dial this number when the AI escalates" has to configure a roster first — setup that exists
only to be overridden on every call. So a number alone is a complete setup:
`synthesizePresetDestination(callerId)` fills in the rest (blind, hang up on failure, 30s
ring, 3600s cap, no dynamic targets, and the **call's own caller ID** — already validated as
owned to place the A-leg, so the B-leg needs no second check).

Nothing about that policy is persisted. It is a pure function of `caller_id`, so the
`escalate-answer` webhook — running after the session is gone, possibly on another replica —
recomputes exactly what the escalating replica decided. `escalation_destination_id` is left
NULL rather than pointing at a row that does not exist; the webhook branches on
`escalation_targets` being non-empty to know a transfer really was set up. Both directions
are mutation-tested, because the failure mode is the customer who just asked for a human
getting an apology and a hangup.

`handoff_message` is null on the synthesized policy on purpose: there is no operator-written
line to speak, and inventing one would put words in the agent's mouth in a language we only
inferred. The prompt's own "let me connect you" is what the customer hears. Configure a
destination to add a spoken handoff.

### Preflight is stricter, not looser

A supplied number makes `preflightEscalationTransfer` **more** demanding, because the caller
went to the trouble of supplying it:

- Not E.164 → 400 (belt-and-braces behind Zod and a DB CHECK).
- Prompt has no `escalate_to_human` tool → 400. Almost always the wrong prompt was selected,
  and accepting it silently means the operator finds out from a customer who reached nobody.
- Provider can't transfer / flag off → 400 / 403 as before. *(Since review round 2, §5c.7:
  only a carrier core does not IMPLEMENT is a 400; an implemented carrier switched off in
  master, or with enablement never loaded, degrades like the flag — the call proceeds.)*
- Tool lookup fails → **503**, where the no-number case degrades to "allow the call". Silently
  dropping something the caller explicitly asked for is worse than making them retry.

Conversely, an **empty roster stops being an error** when a number is supplied — a destination
that exists purely to carry policy for per-call numbers is a legitimate setup.

## 5. The gates — carrier-capability, enforced in three places

*(Written as "VoBiz only"; the capability gate is now `TRANSFER_CAPABLE_PROVIDERS` and the enablement gate master's `live_transfer_enabled` via `transferEnabledProviders()` — see §5c/§5c.1.)*

Mirrors the `preflightSipConnection` posture exactly, because this has the same failure
mode: a config that looks fine and only breaks mid-call.

1. **Feature flag** `ai_call_transfer` (`FF_AI_CALL_TRANSFER`, default off,
   `global`/`tenant`/`account`, clientExposed) — same shape as `custom_sip`.
2. **Request-time preflight** (`calls.routes.ts`, single *and* bulk): if the prompt has
   transfer-enabled escalation and the effective provider ≠ `vobiz`, refuse at
   request time. Note this runs at **intake only** — the SQS dequeue path does not
   re-preflight (the call was already checked when it was accepted, and call-time
   resolution degrades gracefully on its own), so do not rely on a gate there. Telnyx/Exotel/z99/VoiceLink/generic SIP have no `transferCall`; silently
   PSTN-hanging-up instead is the exact bug SIP preflight was written to avoid.
   *(Plivo joined the capable set later, and Twilio later still — see §5c. The
   gate is `TRANSFER_CAPABLE_PROVIDERS`, never a hardcoded carrier name.)*
3. **Execution time**: hard-check that the provider can transfer — `supportsTransfer(provider)`,
   whose cohort is `TRANSFER_CAPABLE_PROVIDERS`. This read
   `session.telephonyProvider === 'vobiz'` while VoBiz was the only one; see §5c. **and**
   `session.source !== 'browser'` (a browser call has no VoBiz call UUID at all) before
   issuing the transfer. Degrade to the legacy end-call rather than throwing into the tool.

**Caller-ID ownership is a real gate, not a formality** — if `callerId` isn't authorized,
VoBiz "derives a number from the existing A-leg, which may not be authorized for the
outbound B-leg" and the B-leg just fails. We already solved this for WebRTC: S2S
`POST {MASTER_SERVICE_URL}/internal/phone-numbers/validate`. Reuse it, and validate at
**config-save time** as well as call time, so a bad caller ID is a 400 on the prompt-tool
PUT rather than a mystery dead call weeks later.

## 5b. Governance — the flag, and what "off" actually means

`ai_call_transfer` (`FF_AI_CALL_TRANSFER`, default **false**, scopes `global`/`tenant`/`account`,
`clientExposed: true`) gates the whole AI→human handoff. It is managed through the existing
super-admin feature-flag surface (`/internal/feature-flags/*`), which already audit-logs every
upsert/delete with `updated_by` and emits `trackFeatureFlagChanged` — this feature needed no
new governance machinery, and deliberately did not build any.

What matters is that the flag behaves **asymmetrically by layer**, because a single uniform
rule gets one of the two jobs wrong.

| Layer | Flag off | Why |
|---|---|---|
| Destination CRUD — create / update | **403** | Nothing about an incident requires *adding* capability |
| Destination CRUD — list / read / delete | **allowed** | The operator must be able to fix the thing they flipped the switch for |
| Dispatch preflight (any shape, incl. an explicit `escalation_number`) | **allow the call** | The flag is a platform state, not a malformed request |
| Call-time resolution (`escalate_to_human` fires) | **degrade** — end the call as `escalate_human` | Mid-conversation with a customer on the line; the pre-feature behaviour is the floor |
| `escalate-answer` / `escalate-result` / `escalate-whisper` webhooks | **not gated** | See below |

**Flag-off never blocks dispatch.** Turning the flag off is the incident response. A 403 at
dispatch would fail every campaign running those prompts — a far larger outage than the one being
contained — and call-time resolution already degrades safely, so the call is safe to place.

This landed in two passes, and the first was wrong in an instructive way. It 403'd only when the
caller supplied an explicit `escalation_number`, on the theory that an explicit request must fail
loudly rather than be silently ignored. A devil's-advocate review killed that:

- It enforced the guarantee at **one of five doors**. The same number is silently dropped when an
  SQS-queued call is dequeued after the flip, when an in-flight call escalates, on the intent
  immediate-callback path (which never preflights at all), and on every inbound/IVR handoff.
- It **cost the whole batch**. Bulk preflights on *any* recipient's number, so one escalation
  number among 10,000 recipients refused all of them — including the 9,999 carrying none.

The loud-failure guarantee was unachievable at the one boundary paying for it. Suppression is made
visible with observability instead: `escalation_suppressed_total{stage}` plus a warn log at **both**
suppression points — `dispatch` (refused to arm) and `call_time` (the tool fired and we declined).
Only the second reached a real customer, which is why they are counted separately.

**The honest cost of flipping the switch.** "Degrades to pre-feature behaviour" is mechanically
true but understates it: a prompt *written for* transfer says "let me connect you", so under the
kill switch every escalating customer hears that and is then hung up on. Pre-feature prompts never
made that promise. This is an accepted cost of having a switch at all — but it is customer-visible,
not a silent no-op, and `escalation_suppressed_total{stage="call_time"}` is how you measure it.

**The webhooks are deliberately ungated.** They are the settlement path for a transfer that has
*already happened*. Gating `escalate-result` would strand a bridged call unsettled, unbilled,
and holding both concurrency slots until the sweep reclaimed it hours later — the flag would
cause the exact leak it was flipped to prevent. Gating `escalate-answer` would drop a customer
whose transfer was already authorized. A flag flip is therefore **not retroactive**: calls
already mid-transfer complete and settle normally; only new escalations stop.

Turning it back **on** is symmetric and worth knowing before you do it: a call dispatched during
the off window that escalates afterwards *will* transfer, having been admitted without a preflight.
That is safe — call-time resolution independently re-checks provider, destination existence and
roster — but re-enabling mid-campaign resumes transfers on already-dispatched calls.

**Enabling order** (matters for a clean rollout): set the flag → create destinations → attach
them to prompt tools. Attaching a destination while the flag is off is harmless (the tool keeps
its legacy end-the-call behaviour), but create/update 403, so destinations cannot be created
first.

## 5c. Twilio (2026-09-20) — same behaviour, three different mechanisms

This document was written when VoBiz was the only carrier that could transfer, and §§3–5
above still read that way. Plivo joined next and needed no new machinery: it redirects a
live A-leg with the same `POST /Call/{uuid}/` + `legs=aleg` + `aleg_url` shape, and it
declares screening with `confirmSound`/`confirmKey` on the `<Dial>` exactly as VoBiz does.
Twilio reaches the same four behaviours by three different mechanisms, and each divergence
is invisible until a live call goes wrong.

**1. The live redirect is the hangup endpoint with a different field.**
`POST /2010-04-01/Accounts/{sid}/Calls/{sid}.json` with `Url` + `Method` moves the call
onto new TwiML; the same resource with `Status=completed` is what `endCall` uses to hang
it up. There is no `legs` parameter, and none is wanted — that parameter exists on the
other two to leave the B-leg alone, and at escalation time there is no B-leg.

> **Now documented rather than hoped (2026-09-23), with a hazard on the other side.**
> This used to be the UNVERIFIED question the enablement env var waited on: does a
> redirect issued while the call sits in `<Connect><Stream>` *redirect* rather than
> *terminate*? Twilio's `<Stream>` reference answers it — "the only way you can stop a
> bidirectional Stream is to end the call. You can also update the call with TwiML
> instructions using the Update a Call resource" — which is exactly this request. The
> same page documents the real hazard: "Twilio executes the remaining TwiML instructions
> only after your server closes the WebSocket connection." Our answer document had
> nothing after `</Connect>`, and `performTransfer` closed the socket right after the
> redirect, so a close processed before Twilio applied the (asynchronous) redirect ended
> the call. That, and the whole-call `TimeLimit`, are fixed in §5c.3.

**2. The whisper URL and the per-leg status callback are `<Number>` attributes.**
Not `<Dial>` attributes. A four-member roster carries four copies of each. It reads as
repetition and is not — it is the only place TwiML accepts them, and Twilio **silently
ignores** an unknown `<Dial>` attribute, so putting them there yields a transfer that
works and is simply never screened. `statusCallbackEvent` also has to name
`initiated ringing answered completed`; Twilio's default is `completed` alone.

**3. There is no `confirmKey` at all — screened mode is a `<Gather>` we render.**
This is the only reason adding Twilio added a *route* rather than just a set member. The
whisper document becomes `<Gather numDigits="1" finishOnKey="" action="…/escalate-whisper-confirm/:callId">`
wrapping the `<Say>`, followed by `<Hangup/>`. Three things are load-bearing:

- **The trailing `<Hangup/>` is the feature.** It runs when the gather times out with no
  input, dropping that leg without bridging. That is what stops an agent's voicemail from
  swallowing an escalation — the entire reason screened mode exists.

  > ✅ **Superseded 2026-09-23 — a screened roster of more than one on Twilio is no longer
  > refused; it runs as a per-call queue with one leg per member (§5c.4).** The analysis
  > below is still exactly why a multi-noun `<Dial>` cannot carry it, and is kept for that.
  >
  > ⚠️ **SCREENED MODE WAS REFUSED ABOVE ONE MEMBER ON THIS CARRIER, and that was settled
  > rather than pending.** This bullet has now been wrong in both directions. It first
  > ended "The other nouns keep ringing, so one voicemail does not end the transfer",
  > stated as fact; it was then corrected to UNVERIFIED and sent to the spike queue. Both
  > were wrong: the behaviour is **documented**. Twilio's `<Number>` reference says the
  > first call to pick up is connected and the rest are hung up, and the whisper `url` is
  > fetched precisely *because* a leg answered — so by the time the gate runs, the other
  > phones have already stopped ringing. Nothing needs to be observed to know this.
  >
  > Concretely: a three-agent screened roster, agent A's voicemail picks up at 6s, B and C
  > are cancelled, the whisper plays into the greeting, nothing is pressed, and 12s later
  > the `<Hangup/>` ends a dial with nobody left in it. The customer gets the fallback line
  > ~18s after two available agents stopped being rung — i.e. **screened mode on Twilio is
  > strictly worse than blind**, which would at least have bridged them to the voicemail.
  >
  > `sequential="true"` does not rescue it: sequential means "try the next noun on
  > no-answer or busy", not "on answered-then-hung-up-by-our-own-gate". So the combination
  > was **refused rather than rendered** — `screenedRosterRefusal`, applied at preflight
  > AND again at `escalate-answer` (both, because inbound, IVR handoff, the intent
  > callback path and SQS-dequeued calls never preflight). That machinery is deleted.
  > The fix was not the `<Dial action>` re-render this paragraph used to prescribe — that
  > serialises the roster, and every voicemail costs the customer a whole ring timeout —
  > but taking the roster out of the `<Dial>` entirely: §5c.4.
  >
  > The related question — **what `DialCallStatus` Twilio reports for a dial whose only
  > answered leg was hung up by our gate** — is now DEFENDED rather than open. Twilio's
  > `completed` means "the called party answered", which a voicemail satisfies, so
  > `mapDialStatus` alone settled the call as "a human took it" when nobody did AND the
  > fallback branch's `!== 'connected'` guard then skipped the operator's apology, leaving
  > the customer with a silent hangup. `resolveTransferStatus` now weighs two pieces of
  > counter-evidence: Twilio's own `DialBridged` on the same `<Dial action>` callback, and
  > `calls.escalation_screen_verdict` (migration 125), which the confirm hop persists
  > because it is the only place in the system that learns whether a human accepted. **Both
  > are asymmetric — absence is never counter-evidence**, or every successful VoBiz and
  > Plivo transfer would settle as unanswered. Billing was never affected either way, since
  > `talk_time_seconds` anchors on `answered_at`.
- **`finishOnKey=""` is not tidying.** Twilio's default terminator is `#`, and `#` is a
  legal `confirm_key` (the column validates `[0-9*#]`). With the default, an agent on a
  `#` destination presses accept, Twilio reads it as "stop collecting", and posts an
  **empty** `Digits` — refusing a transfer the agent just accepted.
- **The confirm hop's default is REFUSE**, and so is `escalate-whisper`'s. A wrong digit,
  no digits, a call row that cannot be read, or an unhandled throw all drop the leg. An
  earlier revision of this section described the two hops as having *opposite* defaults —
  "an unreadable row bridges" on the whisper hop, because an agent is already holding a
  live line — and that was wrong on the carrier this section is about. On VoBiz and Plivo
  an empty whisper document is neutral (their `<Dial confirmKey>` still gates the leg), but
  on Twilio the whisper document **is** the gate, so an empty response is the ACCEPT: it
  switches screening off at exactly the moment we have established we cannot screen. Both
  hops therefore fail closed, and both degrade to a bare `<Hangup/>` rather than to an
  empty `<Response>` — the customer is not abandoned by it, because the dial then falls
  through to `escalate-result`, which speaks the operator's fallback line. The accept
  document is still **empty**, on the accept path only: TwiML bridges when a whisper
  document finishes without hanging up, so saying nothing *is* the accept.

**Three smaller things this carrier forced, all of which were latent bugs for the others:**

- **`escalationHangupXml` now renders through the adapter.** It emitted
  `<Speak voice="WOMAN" language="en-IN">` unconditionally — VoBiz's dialect on every
  provider. Plivo tolerated it badly (no `WOMAN` voice for `en-IN`); TwiML has no
  `<Speak>` element at all, so Twilio would have rejected the document and dropped the leg
  without a word, on the one path whose job is to hang up *politely*.
- **`mapDialStatus` gained `canceled`.** One L, Twilio's spelling. Without it a cancelled
  Twilio dial fell through to `failed` — a carrier fault reported for a leg that was
  simply called off. `isTestTerminalStatus` already carried all three spellings.
- **`escalate-result` reads `DialCallStatus`.** Twilio's `<Dial action>` callback carries
  that name and has no `DialStatus`, so every Twilio transfer would have resolved to
  `'unknown'` → `failed`: a conversation a human took, held and ended, recorded as a
  failed transfer.

**The route loop is now derived from `TRANSFER_CAPABLE_PROVIDERS`** rather than being a
second hand-maintained literal at the other end of the codebase. The asymmetry the old
comment warned about is real and one-directional: routes without the gate are harmless
(they only ever load a row that could not have been transferred), while the gate without
the routes redirects a live A-leg at a URL that 404s. Deriving one from the other makes
that unreachable instead of merely documented; `escalation-webhooks.test.ts` pins it.

**A voice table came with it.** The platform vocabulary is `(WOMAN|MAN, Polly locale)` and
Twilio publishes neither name, so `src/telephony/twilio/twilio-tts.ts` translates at the
XML boundary exactly as `plivo-tts.ts` does. Two notes worth keeping: a Polly voice
determines its own language, so **no `language` attribute is emitted beside one** — which
is what lets a locale Twilio has never heard of (`arb`, `en-GB-WLS`) still be spoken
correctly; and `man`/`woman` are deliberately read as *our* vocabulary rather than as
Twilio's identically-spelled basic voices, because the two collide only in case and
resolving in our favour is right under both readings.

**Master and cusui derive the capable set from core's `/metadata`** (`escalation_transfer.transfer_capable_providers`)
— master through an intersection filter with the tenant's allowed providers
(`src/utils/allowed-services.ts`) and, since the governance flag, its own
`live_transfer_enabled` set; cusui through a single `includes()` in `MetadataContext`.
That was the payoff of the original design and is worth not regressing.

> **Two governance-independent fields since 2026-09-23 (§5c.5).** `transfer_capable_providers`
> folds in core's CACHED copy of master's flag (up to ~60s old), so right after a
> super-admin switched a carrier on, master busted its 30-minute cache and re-cached core's
> pre-toggle answer. Core now also publishes `transfer_implemented_providers`
> (`[...TRANSFER_CAPABLE_PROVIDERS]`) and `destination_test.implemented_supported` (an
> implemented carrier is configured here), and master intersects those with its own live
> set (magick-master `b488c30`). The old fields are unchanged. Since review round 2
> (§5c.7) `destination_test.implemented_configured_providers` names WHICH implemented
> carriers are configured here (sorted), so master can require one that is also live AND
> tenant-allowed before offering the Test; master strips all three governance-independent
> fields from the tenant-facing body.

One correction to an earlier revision of this line, which said the carrier "appears in the
UI the moment core ships": master caches the filtered metadata for **30 minutes**
(`METADATA_CACHE_TTL`, `proxy-metadata.routes.ts`), per tenant/account, so it appears
within that window rather than immediately. A rollout note, not a code change.

### 5c.1 — capability is not enablement

That downstream derivation is exactly why **merging this adapter must not be what turns the
feature on**, and in the first revision of this work it was. One set served two questions:
which carriers have webhook hops, and which carriers may transfer a live call. Master and
cusui read the second off `/metadata`, so the moment the set grew a member, every existing
Twilio account was being offered live human transfer — within one 30-minute cache window,
with the `<Connect><Stream>` redirect above still unverified, and with no lever between
"the code exists" and "the fleet will try it". `ai_call_transfer` is not that lever: it is
global, and turning it off to contain one carrier stops escalation on all three.

So the two questions now have two answers:

| | what it is | who reads it |
|---|---|---|
| `TRANSFER_CAPABLE_PROVIDERS` | adapters that implement the quartet, and the list webhook-route registration is derived from | `registerEscalationRoutes` |
| `transferEnabledProviders()` | carriers a live call may actually be transferred on — capable ∩ master's `live_transfer_enabled` (below) | `/metadata`, `preflightEscalationTransfer`, **`resolveEscalationDestinationForCall`**, `resolveTransferProvider`, destination carrier candidates |

The split follows the asymmetry §5c already documents and does not weaken it. Routes
*without* the gate are harmless — they can only ever load a row that could not have been
transferred — while the gate *without* the routes redirects a live A-leg at a URL that
404s. Keeping registration derived from the wider set makes the dangerous direction
structurally unreachable: a carrier cannot be enabled without its hops existing.

**Enablement is master's governance flag, not a deployment setting (2026-09-23).** The
first revision gated Twilio behind `ESCALATION_TWILIO_TRANSFER_ENABLED=true`, read from
`process.env`. That meant a redeploy of every core replica to change a product decision,
a per-replica value that could disagree across the fleet, and a switch master's own UI
could neither show nor move. It is gone. The per-carrier switch is
`telephony_providers.live_transfer_enabled` in master (seeded on for `vobiz`,
`plivo` and `twilio` — Plivo because it already transferred unconditionally before the
flag existed — and off for every other carrier; a super-admin toggles it), and
core reads it from `GET {MASTER_SERVICE_URL}/internal/telephony-providers/live-transfer`
(`200 {"providers": [...]}`, Bearer `MASTER_S2S_TOKEN`), and the table above's
`transferEnabledProviders()` is capable ∩ that list — intersected so a super-admin
ticking the box on a carrier this build has no hops for cannot redirect a live A-leg at
a 404.

`escalation/helpers.ts` stays import-free (the first config read in a file arms
`config/index.js`'s `process.exit(1)` under Vitest), so it holds a synchronous SNAPSHOT
that `escalation/live-transfer-enablement.ts` fills: 60s in-process TTL, a 30s
background refresh, a Redis last-known-good for cold boots during a master outage, and
`ensureLiveTransferEnablementFresh(stage)` at every async read point, so a super-admin
toggle lands fleet-wide within about a minute. **It never waits while any snapshot is held**
(2026-09-23): a stale one starts a shared background refresh (unless one failed in the last
10s) and is served at once — the readers are the escalate_to_human tool with a customer in
dead air, every outbound VoBiz/Plivo dial and preflight, and they used to wait up to 2s on
master. Only a cold process with nothing loaded and nothing in Redis awaits, capped at 2s. A snapshot once loaded is honoured however old it is — a master outage must not
switch a working carrier off mid-campaign. **Never loaded ⇒ empty ⇒ fail CLOSED**
(master unconfigured, or down since boot with nothing in Redis): every read served that
way is counted as `escalation_live_transfer_fail_closed_total{stage}` and warned about (at
most once a minute per stage), and escalations degrade to ending the call. The call-start
prediction stage `handoff_prefetch` is neither warned nor counted — it decides nothing a
customer hears (`call_time` re-reads), and with master unconfigured it used to warn and
count twice on every outbound call start. Because core now calls a new master route, the
merge order for this change is master → core.

**Call-time resolution read the CAPABLE set until this landed** — a real bug.
`resolveEscalationDestinationForCall` is the only gate for inbound calls, IVR
`ai_handoff`, the intent immediate-callback and SQS-dequeued calls (none of which run
preflight), and it checked `TRANSFER_CAPABLE_PROVIDERS`, so all of them could transfer
over a carrier that was gated off. It now checks the enabled set and degrades with
`escalation_suppressed_total{stage="call_time"}` + a warn, exactly like the kill switch.
The handoff-line TTS prefetch at call start runs the same resolver in `prefetch` mode,
which no longer counts as a suppressed escalation (it did, once per call start, whenever
`ai_call_transfer` was off).

`resolveTransferProvider` reads the enabled set too, which is easy to miss and matters:
every one of its callers is choosing the carrier a REAL call goes out on — the destination
test dials a human, the caller-ID validator checks a number against the trunk the transfer
will use — so resolving to a gated carrier would place a test call down a path live
transfers cannot take.

### 5c.2 — what is decided once, and what is re-read

A transfer is not one request. It is a REST redirect followed by up to four
carrier-initiated webhook hops, landing on arbitrary replicas, over the tens of seconds a
roster rings — and `escalation_destinations` is editable throughout. Two columns
(migration 125) exist because of that.

**`escalation_policy_snapshot`** freezes `mode`, `whisper_message` and `confirm_key` at
transfer start, beside `escalation_targets`, which already exists for the same reason one
level down: WHO to ring is resolved once and persisted rather than re-derived. This is the
WHAT-to-do-when-they-answer half. Without it, a `PUT` landing mid-ring changes the answer
to a question the `<Dial>` has already asked — flipping `screened` to `blind` makes the
whisper hop take its blind branch and return the empty ACCEPT document, bridging a leg the
carrier is still screening, and a changed `confirm_key` refuses the very digit the agent
was just told to press. Neither is exotic: the operator editing the roster during an
incident is exactly the person whose calls are escalating. Only those three fields are
frozen — the fallback line and the timeouts are better served by the latest value, since
no document already in the carrier's hands depends on them — and the destination row is
still *loaded*, so deletion or deactivation still resolves to "no context".

**`escalation_screen_verdict`** records what the agent pressed, because
`escalate-whisper-confirm` is the only place in the system that learns it and the hop that
settles the call runs on a replica that never saw the `<Gather>`. A scalar column rather
than a key inside `call_activity`: a JSONB write is read-modify-write at the application
layer and would clobber the tool tallies `performTransfer` seals there, while a
single-column UPDATE is atomic. It is written **before** the accept document is returned,
since Twilio bridges the instant it reads that document and the dial-result hop can follow
within seconds. ⚠️ **NULL is not "refused"** — it is every blind transfer and every
VoBiz/Plivo transfer, whose carrier enforces `confirmKey` and tells us nothing.

### 5c.3 — three call-lifecycle fixes (2026-09-23)

Found while making Twilio enable-able, and two of the three were never Twilio-only.

**C1. The carrier's time limit cut transferred calls off.** Every outbound AI call is
dialled with `maxDuration = callTimeoutSeconds` (300s by default), and every carrier
here enforces it over the WHOLE call: Twilio `TimeLimit` ("the maximum duration of the
call in seconds"), VoBiz `time_limit` ("max duration of call in seconds (after
answered)"), Plivo `time_limit` ("max duration of call in seconds"). A transferred call
is still that call, so a customer bridged to a human four minutes in was hung up one
minute later, agent mid-sentence. Two fixes, one per carrier family:

- **Twilio** accepts `TimeLimit` on Update-a-Call ("you can also use the same API
  parameter to update the maximum duration on active calls"; a value below the call's
  current duration is error 13216, so it is measured over the whole call). `transferCall`
  sends `TimeLimit = elapsed + ring_timeout + max_transfer + 120s` on the SAME request as
  the redirect (`TransferCallRequest.timeLimitSeconds`), clamped to the 4h default
  account maximum; on 13216 (a trial account's 10 minutes, a lowered account limit) the
  redirect is retried without it. The adapter declares `transferExtendsTimeLimit`.
  `elapsed` is measured from the CARRIER call's start (`carrierCallElapsedSeconds`): the
  session's creation, or for an IVR `ai_handoff` the IVR leg's own start
  (`CallSession.carrierLegStartedAt`, from `ivr_sessions.initiated_at`), because that phone
  call has been up for as long as the IVR ran and measuring from the handoff cut the bridge
  short by exactly that. **The 4h clamp is a real bound on Twilio**: `max_transfer_seconds`
  validates to 14400, so there the bridged call ends at min(max_transfer, 14400 − elapsed −
  ring − 120). That depends on the call, so it is documented on the bound (validator,
  `/metadata`) rather than narrowed there, and the adapter warns with the seconds lost
  whenever it clamps.
- **VoBiz and Plivo** document no way to change `time_limit` on a live call (their
  transfer APIs take only `legs`/`aleg_url`/`bleg_url`), so a call that CAN escalate —
  call-time resolution in `prefetch` mode says so — is dialled with
  `callTimeoutSeconds + ring + max_transfer + 120s` (`CallManager.carrierMaxDurationSeconds`).
  The AI side is unchanged: the session timeout timer still ends a non-escalated call at
  `callTimeoutSeconds`. *(Since §5c.8 both IVR dial sites apply the same rule to an IVR
  call whose `ai_handoff` can reach a prompt that escalates.)* What it costs is the carrier backstop on an orphaned leg (a Plivo
  call whose socket dropped keeps `keepCallAlive`) — the stale sweep still reaps those.

**C2. Our own socket close could end a Twilio transfer.** See §5c point 1. After a
successful `transferCall`, `detachTransferredSession` no longer closes a Twilio media
socket (`CARRIER_ENDS_STREAM_ON_TRANSFER`): the socket is taken out of the session before
`destroy()` and left for Twilio to end when it executes the new TwiML, with a 15s
backstop close. Nothing on it can settle, hang up or release: the session is gone from
`activeSessions`, and `handleMediaStreamMessage` (including `stop`) and
`handleMediaStreamClosed` return on a missing session first. The safety net is
`<Connect action="{TWILIO_WEBHOOK_BASE_URL}/escalate-connect-end/{callId}">` on every
Twilio answer document *rendered while Twilio transfer is enabled* (since §5c.7 — with it
off the document is the pre-transfer one, and a call answered then escalated after a
switch-on transfers by REST redirect without this net). That route renders the transfer `<Dial>` only when the row is
`transferring` AND no dial has been rendered; every other call — the ordinary end of
every Twilio call — gets a bare `<Hangup/>`, which is what an empty remainder did, and
nothing is settled there. An atomic claim (`calls.escalation_dial_claimed_by`, migration
126, `CallRepository.claimTransferDial`) guarantees escalate-answer and connect-end can
never both ring the roster; escalate-answer stays re-claimable by itself so a carrier
retry still renders, fails OPEN on a claim error (it is the primary path), and
connect-end fails CLOSED. ~~**Residual race, accepted:** if the media socket drops during
the handoff line (up to 8s) while the customer stays on, connect-end dials first and our
later REST redirect interrupts that dial and fetches escalate-answer, whose lost claim
hangs up.~~ **Fixed 2026-09-23 (§5c.5)** — it was not rare enough to accept: a deploy
closes client sockets (`app.close()` runs before `call-drain`), and if Twilio also requests
`<Connect action>` when a redirect ends the stream, the "race" is every transfer.
escalate-answer now TAKES OVER a connect-end claim, and `performTransfer` skips the
redirect when connect-end already holds it.

**C3. The destination's caller ID had no carrier.** A destination's `caller_id` is on
one carrier account, but create/update validated it, the picker listed, and the Test
dialled, against the DEPLOYMENT's default carrier ("KNOWN AMBIGUITY"), and at dial time
it was presented on whatever carrier the call ran on. Migration 127 adds
`escalation_destinations.provider` + `telephony_credential_id` (NULL = legacy row,
resolved exactly as before):

- create/update validate against every ENABLED transfer carrier, default first, and
  persist the first master confirms plus the BYOC credential the number is pinned to
  (`resolveCredentialIdForCallerId`); a legacy row learns its carrier opportunistically
  on its next save, best-effort;
- `GET /escalation-destinations/caller-ids` is the union across those carriers, each
  entry carrying `provider`; responses include `provider` — but **not**
  `telephony_credential_id` (stripped by `toPublicDestination` since 2026-09-23: it is
  server-determined, names a row in a table the API does not expose, and nothing
  downstream needs more than `provider`);
- the Test dials over the recorded carrier (pass/fail semantics unchanged), on the
  credential the caller ID resolves to AT TEST TIME — the stored `telephony_credential_id`
  is only a hint and goes stale when a number moves between BYOC and the platform or a
  credential is re-created (§5c.5);
- at dial time, when the destination's provider/credential differs from the call's
  (`telephony_provider` / pinned `telephony_credential_id`), `<Dial callerId>` is the
  CALL's own caller ID (outbound `from`, inbound DID — both `calls.caller_id`), with a
  warn and `escalation_caller_id_substituted_total{provider,reason}`. Never a reason to
  fail the dial.

**Still needs a live Twilio spike before trusting it at scale:**

1. A redirect while in `<Connect><Stream>` redirects (documented), and Twilio closes the
   stream itself afterwards — i.e. the 15s backstop never fires on a healthy transfer
   (watch for the "did not end the media stream" warn).
2. Whether Twilio requests `<Connect action>` when a REST redirect (rather than a socket
   close) ends the `<Connect>`. The claim take-over makes either answer safe; a connect-end
   fetch AFTER a redirect should log "already rendered by escalate-answer", and one that
   beats escalate-answer should be followed by "escalate-answer took over".
7. What Twilio does with a connect-end `<Dial>`'s `action` when our redirect replaces it
   (not requested, or `DialCallStatus=canceled`/`completed`?). If it is requested and lands
   before escalate-answer's take-over it would settle the row and escalate-answer would
   apologise; `performTransfer`'s pre-redirect re-read keeps that window to milliseconds.
3. `TimeLimit` on the redirect request is applied (a bridged call survives past
   `callTimeoutSeconds`), and a 13216 really leaves the redirect un-applied, as the
   retry assumes.
4. The ordinary end of a Twilio AI call with the new `action`: `<Hangup/>` from
   connect-end, no double settlement, no Twilio application-error message.
5. VoBiz/Plivo: a transferred call now outlives `callTimeoutSeconds` (dial-time
   headroom), and VoBiz's "after answered" semantics hold.
6. `DialCallStatus`/`DialBridged` for a screened leg our gate refused (§5c, defended in
   code, not yet observed). Now only reachable from a SINGLE-member screened `<Dial>`.

The screened-queue path adds its own checklist — §5c.4.

### 5c.4 — Screened parity on Twilio via a per-call queue (2026-09-23)

**The gap.** VoBiz and Plivo screen each leg with a carrier-side `confirmKey`: a member
who does not press is dropped and the others keep ringing; the first to press is
bridged. Twilio's multi-noun `<Dial>` bridges the first leg that *answers* — an agent's
voicemail included — and hangs up the rest before the per-`<Number url>` gate runs
(§5c point 3). So screened mode above one member was refused on Twilio. It is now
built from primitives Twilio documents, and the refusal (`screenedRosterRefusal`,
`SCREENED_SINGLE_NOUN_PROVIDERS`) is deleted from helpers, preflight and escalate-answer.
**Blind mode and a single-member screened roster keep today's `<Dial>` unchanged.**
Selection is `usesScreenedQueue(provider, mode, activeTargets)` over
`SCREENED_QUEUE_PROVIDERS = {twilio}`; the 10-member cap holds (`SCREENED_QUEUE_MAX_LEGS`).

**Mechanism.**

```
escalate-answer (or connect-end — same renderTransferDial, same dial claim)
  → INSERT escalation_member_legs (one 'placing' row per member)   ← before the response
  → <Enqueue waitUrl=…/escalate-queue-wait/:callId action=…/escalate-queue-result/:callId>esc-{callId}
  → start (not await) one REST POST /Calls.json per member:
       To=member, From=<Dial callerId rule incl. C3 substitution>, Timeout=ring_timeout,
       TimeLimit=ring+max_transfer+120, Url=…/escalate-member-answer/:callId/:i,
       StatusCallback=…/escalate-member-status/:callId/:i (initiated ringing answered completed),
       no Record, no AMD  (TwilioAdapter.placeTransferLeg — not initiateCall)

customer:  escalate-queue-wait (re-fetched as each 6s ringback clip ends)
             → <Play>…/escalate-ringback.wav</Play>  |  <Leave/>
           escalate-queue-result (Enqueue action: once after the bridge ends, or at once
             on Leave/hangup) → settleTransferredCall(transferStatus from QueueResult)
             → fallback line when nobody took it and the caller is still there
             → hang up every live leg; DELETE /Queues/{QueueSid}.json   (best-effort)

member i:  escalate-member-answer   → the existing whisper + <Gather numDigits=1 finishOnKey="">
                                      posting to escalate-member-confirm/:callId/:i, then <Hangup/>
           escalate-member-confirm  → right digit: claimTransferWinner (one guarded UPDATE)
                                        won  → <Dial timeout=10 timeLimit=max_transfer><Queue>esc-{callId}</Queue></Dial>
                                               + hang up every other leg
                                        lost → "already answered by a colleague" + <Hangup/>
                                      wrong/no digit, any error → <Hangup/> (this leg only)
           escalate-member-status   → forward-only leg status; hang up a leg still live
                                      after another member won / the transfer ended
```

**State (migration 128).** Everything a hop decides from is in Postgres, because every
hop lands on an arbitrary replica:

- `escalation_member_legs (call_id, member_index)` — SID + status per leg. A table, not a
  JSONB column: up to ten legs' callbacks arrive concurrently, and a JSONB
  read-modify-write clobbers siblings exactly as `call_activity` would (§5c.2). Rows are
  inserted **before** `<Enqueue>` is returned — the wait hop reads "every leg terminal"
  as "nobody is coming", and an empty set would satisfy that vacuously — with
  `ON CONFLICT DO NOTHING RETURNING`, so a carrier retry of escalate-answer (which stays
  re-claimable by itself, and now takes over a connect-end claim — §5c.5) re-renders the
  `<Enqueue>` and rings nobody twice. A terminal status is sticky — never overwritten,
  because Twilio does not promise callback order (non-terminal statuses are not ordered,
  and nothing needs them to be) — except our own `failed`
  marker on a leg with no SID, whose status a carrier callback replaces (§5c.5). The SID
  itself is only ever the REST create's answer (§5c.6). A leg whose create
  was sent but never answered is `unknown`, which is not terminal. Migration 129 adds
  `answered_at` per leg.
- `calls.escalation_winner_member` — the claim: `transferring AND (NULL OR same member)`,
  the same shape as `claimTransferDial`, re-claimable by the winner so a retry of its own
  `<Gather action>` re-renders the dequeue. The same UPDATE writes
  `escalation_screen_verdict='accepted'`. A member refusing does **not** write
  `'refused'` (one of several declining is not the call's verdict).
- `calls.escalation_queue_sid` — captured on the first wait fetch; since §5c.5 the ONLY
  queue SID deleted by (the result hop and the sweep both read it), never a body `QueueSid`.
  *(Since §5c.7 the stored SID is only a hint: stored only if well-formed, and every delete
  first verifies it names `esc-{callId}` on the call's own account, else finds the queue
  by name.)*
- `calls.escalation_queue_left_at` (migration 129) — the wait hop's "released, nobody won";
  the winner claim refuses a stamped row and the stamp refuses a won row (§5c.5).

**The wait decision** (`decideQueueWait`, pure; revised in §5c.5): row not `transferring` →
leave; past the absolute ceiling → leave; a winner exists → keep waiting (the dequeue is
imminent) unless the winner's own leg has ended or the dequeue is overdue (measured from the
winner's own answer when known, else `QueueTime` past the no-winner ceiling + 30s); no
winner → leave once every leg is terminal; otherwise a live leg that ANSWERED within its
screening window (whisper estimate + 12s digit timeout + 15s) keeps the customer waiting,
and only with none does `QueueTime > ring + 45s + 15s` release them *(since §5c.8 "QueueTime"
here is the SERVER's queue clock, which the body's `QueueTime` may only shorten)*. On a
DB error the hop keeps playing ringback until the absolute ceiling (238s since §5c.5; it was
210s), then leaves — a blip must neither strand the customer nor release one whose members are
still ringing.

**Why the TwiML does not wait for the legs.** Awaiting up to ten REST creates (each
bounded at 10s) would put them between Twilio's fetch and its document, in silence, on
a customer just told they are being connected, against Twilio's 15s webhook timeout.
Nothing needs the SIDs sooner than a human can answer, hear the whisper and press a key,
and each is persisted the moment its create returns. The race that remains — a winner's
cancel running before a slow leg's SID is known — is closed three times: the placement
itself re-reads the row when the create returns and hangs up a leg that already lost
(§5c.6), that leg's next status callback does, and its answer hop does.

**Settlement is unchanged** (bar three refinements in §5c.5: `redirected` is our own
redirect and settles nothing; an all-busy `leave` settles `busy`; a caller hangup before the
`<Enqueue>` ever ran is settled from the A-leg's own status callback). `QueueResult` →
`mapQueueResult`: `bridged` (and
`redirected-from-bridged`) → `connected`, requested after the bridge ends — the same
timing as `<Dial action>`; `leave` → `no_answer` + the operator's fallback line;
`hangup` (the customer left while members rang) → `no_answer`, consistent with a caller
hangup during an ordinary ring, and nothing spoken; `error`/`system-error`/`queue-full`/
`redirected`/`bridging-in-process`/anything else → `failed` + fallback, never
optimistically connected. It goes through `settleTransferredCall` with an explicit
`transferStatus` (the raw word is logged/audited as `queue:<result>` and stored as the
hangup cause), so the `transferring` predicate is still the idempotency guard, talk time
still anchors on `answered_at`, and slots are still held until then.
`failStaleTransferredCalls` reclaims a queue transfer whose result never arrives exactly
as before, and the sweep now also hangs up any live leg and deletes the queue (by
`escalation_queue_sid`).

**Ringback.** The customer hears a generated tone (`src/audio/ringback.ts`: 400+450 Hz
Indian/UK double ring, two 3s cycles, 8 kHz 16-bit PCM WAV, memoized) served from
`GET /twilio/escalate-ringback.wav` with a long cache header — or, since §5c.5, for a
customer on a `+1` number, North American ringback (440+480 Hz, 2s on / 4s off, one 6s
cycle) from `escalate-ringback-nanp.wav` — parity with VoBiz/Plivo's
`dialMusic="real"` and Twilio's own `<Dial>` ringback, where Twilio's default queue wait
music would say "you are on hold" and silence would say "the call dropped". The clip
length is the polling interval. `<Pause length="3"/>` only if no webhook base is set.

**Routes** — Twilio only (they are Twilio mechanics; VoBiz/Plivo screen natively), derived
from `SCREENED_QUEUE_PROVIDERS` so a carrier cannot be routed onto the queue without its
hops: `escalate-member-answer|confirm|status/:callId/:memberIndex`,
`escalate-queue-wait|result/:callId`, `GET escalate-ringback.wav`. Same auth posture as
every other escalation hop — unauthenticated, guarded by the unguessable callId, outside
`TWILIO_SIGNED_ROUTES`; the member index is not a secret. ~~A forged member-confirm still
needs the call id, and the worst it can do is what a forged `escalate-result` already
can (§6b).~~ Not so — a forged confirm could CLAIM the transfer for any index. Since §5c.7
the member hops verify each request against the leg we placed (row exists, live, holds
our create's SID, body `CallSid` matches — REQUIRED since §5c.8) before screening or claiming.

**BYOC.** Legs are placed from, cancelled on, and the queue deleted on the CALL's
account (`resolveTransferAccountAdapter` → `getForCredentialId`); a BYOC call never
falls back to the platform account for these. Rendering is different: every
escalation/test hop renders with the PLATFORM adapter (`transferRenderAdapter`), BYOC
calls included, because no document carries an account SID or token. ~~Every hop that
renders falls back to the pinned credential's adapter when the platform one cannot be
built (`resolveTransferRenderAdapter`).~~ **Removed in review round 2 (§5c.7):** that
condition cannot occur — the VoBiz/Plivo/Twilio config blocks default every field to
`''` and the adapters' constructors validate nothing, so `registry.get` never throws for
a transfer carrier, BYOC-only deployment or not. The fallback (and the destination read
the test-answer hop did behind it) was dead code, and its tests asserted a fixture
production cannot produce.

**Failure modes.** A leg the carrier refuses is marked `failed` (the wait stops waiting
for it); one whose create was sent but never answered is `unknown` and still waited for
(§5c.5). Leg rows that cannot be written → the fallback line, no legs (a queue we cannot
record cannot be run). Winner claim error → that leg is hung up (fail closed). A cancel
that fails is retried by the leg's next status callback. A queue delete that fails is an
empty queue on the tenant's account; the sweep retries only when the result was lost.
All carrier side effects are fire-and-forget and never reject
(`ScreenedQueueTransfer`). Metric: `escalation_screened_queue_legs_total{outcome}`
(`placed|place_failed|place_unknown|accepted|lost_race|too_late|refused|cancelled`).

**What the live spike must verify** (none of this is observed yet):

1. `<Enqueue action>` is requested ONCE after the bridged parties hang up with
   `QueueResult=bridged` (not at dequeue time), and at once with `leave` after our
   `<Leave/>` and with `hangup` when the customer hangs up in the queue.
2. `<Leave/>` resumes after `<Enqueue>` (the action URL) without hanging up, so the
   fallback line is actually heard.
3. `waitUrl` is re-fetched when the `<Play>` ends and carries `QueueTime` + `QueueSid`;
   the ringback clip plays cleanly (format, level, cadence) and is cached.
4. `<Dial><Queue>esc-{callId}</Queue></Dial>` from the winner bridges to the waiting
   customer; `timeLimit` bounds the bridge; `timeout=10` ends a dequeue into an empty queue.
5. Member-leg cancellation with `Status=completed` ends a RINGING leg as well as an
   answered one (documented as "even if already in progress"); 404/21220 on an
   already-finished leg.
6. `DELETE /Queues/{sid}.json` succeeds on an empty queue right after the result; no
   queues accumulate on the account.
7. `Timeout` on a REST-created leg matches the configured ring time (Twilio may add a
   5s buffer), and a member's voicemail answering is refused by the gate while the others
   keep ringing — the whole point.
8. The A-leg `TimeLimit` extension (§5c.3 C1) still covers queue wait + bridge.
9. Twilio's per-account calls-per-second limit staggers member legs (1 CPS ⇒ ten legs over
   ~9s): the ring-phase ceiling and the 238s absolute cap assume it; watch a 10-member
   roster on a 1-CPS BYOC account.
10. `QueueResult=redirected` is what the `<Enqueue action>` reports when our transfer
    redirect moves the customer out of a connect-end queue, and the redirect's own fetch —
    not the action's document — is what Twilio executes (§5c.5).
11. A REST create that times out but was placed produces normal status callbacks for the
    leg, so the `unknown` row is named and becomes cancellable.
12. North American ringback (440+480 Hz, 2s/4s) sounds right to a `+1` caller.

### 5c.5 — Fix pass: races, staleness and the queue's timing (2026-09-23)

A read-only review of §5c.3 and §5c.4 found the issues below; every fix covers the queue
path too. Migration 129 carries the two new columns.

**The dial claim could hang up a customer mid-transfer.** Scenario: the row is
`transferring`; during the handoff line or the destination resolve the Twilio media socket
closes (a blip, a Twilio stream error, or a deploy — `app.close()` runs before `call-drain`
and `@fastify/websocket` closes client sockets); Twilio runs `<Connect action>`; connect-end
claims and dials; our replica still sends the REST redirect; Twilio replaces the running
`<Dial>` (cancelling the agents' legs) and fetches escalate-answer; the claim was refused
(held by connect_end) → `<Hangup/>`, and the row never settled until the sweep. Worse, if
Twilio also requests `<Connect action>` when a REST redirect ends the stream and that beats
escalate-answer, EVERY Twilio transfer would hang up. Two fixes:

- **escalate-answer takes over a connect-end claim** (`claimTransferDial`: `answer` may
  claim a row held by `connect_end`; never the reverse). escalate-answer is only fetched
  once our redirect has replaced whatever document was running, so two live dials cannot
  coexist and refusing leaves the customer with none. On the queue path the take-over
  re-renders `<Enqueue>` into the SAME `esc-{callId}` queue and places no leg
  (`ON CONFLICT DO NOTHING` returns no index), so the members connect-end is ringing are
  the ones who can accept. The `<Enqueue action>` for the queue the redirect pulled the
  customer out of reports `QueueResult=redirected`; only our transfer redirect ever
  REST-redirects a customer's call, so that result settles nothing and cancels nothing,
  and its document is a `<Redirect>` to escalate-answer in case Twilio executes it.
- **`performTransfer` re-reads the claim right before the redirect** (Twilio only) and, if
  connect-end holds it, skips the redirect and just detaches — sending the whole-call
  `TimeLimit` extension on its own (`TwilioAdapter.extendCallTimeLimit`), since the skipped
  redirect is what would have carried it. The read fails OPEN.

The 15s backstop close was re-examined against a redirect applied after it: the close runs
connect-end, the late redirect then takes the claim over — a re-ring, not a hangup — and a
close after an applied redirect is a no-op. It needs no read.

**Metadata staleness** — see the note under §5c (`transfer_implemented_providers`,
`destination_test.implemented_supported`).

**Enablement reads no longer wait on master** while any snapshot is held; the call-start
prediction stage is quiet; the fail-closed warn is rate-limited (§5c.1).

**TimeLimit from the carrier call's real start, and the 4h clamp** — see §5c.3 C1.

**The destination's stored credential is a hint.** `telephony_credential_id` goes stale
(number moved between BYOC and the platform, credential re-created): the Test dialled a
stale account, and dial time emitted a spurious `credential_mismatch` substitution. Both
now resolve fresh via `resolveCredentialIdForCallerId(destination.provider, …)`; dial time
only when the destination's provider is the call's, and keeps the hint on a resolution error.

**Queue path (§5c.4):**

- **Ambiguous leg creates.** A create that timed out or lost its connection after sending
  may have been placed; it was recorded `failed` (terminal), so the wait hop released the
  customer while that member rang, a winner whose row read `failed` looked like a dropped
  leg, and no cancel could reach it. It is now `unknown` (non-terminal, bounded by the
  ceilings); a connection that was never made (refused, DNS) is still `failed`; and a
  carrier callback replaces our own `failed` marker's status on a leg with no SID. *(It
  used to record the callback's SID too, making the leg cancellable; since §5c.6 an
  `unknown` leg stays uncancellable — it rings to its own `Timeout` and its answer hop
  turns it away if it lost.)*
- **An answered member is measured from their own answer.** The no-winner ceiling fired
  while a member was still hearing the whisper (a 500-character line is ~40s, the digit
  timeout starts after it, 1-CPS accounts stagger ten legs ~9s, Twilio may add ~5s to a REST
  `Timeout`). `escalation_member_legs.answered_at` is stamped by the member-answer hop (and
  by an `in-progress` callback); a live answered leg within whisper-estimate (11 chars/s,
  errs long) + 12s + 15s keeps the customer waiting. The absolute cap is rebuilt from the
  worst case it must not cut — 120s ring + 15s placement skew + the longest whisper's window
  + 30s bridge grace = **238s** (was 210s, which that case outran) — and now also applies in
  the normal path.
- **Leave and win are mutually exclusive.** A member pressing the key between our `<Leave/>`
  and the result hop's settle used to win: `<Dial><Queue>` into an empty queue (10s of
  silence, the queue recreated by name) and `accepted` left on a `no_answer` row. The wait
  hop now stamps `escalation_queue_left_at` with a guarded UPDATE (`winner IS NULL`) and the
  winner claim requires it NULL; if a winner landed in between, the hop keeps the customer
  for the dequeue. A late member hears "The caller is no longer waiting." — at the answer
  hop (not screened at all) or the confirm hop — and no verdict is written.
- **The escalate-answer document that never ran.** If Twilio never executed it (the
  customer hung up during the fetch, or it outlived Twilio's webhook timeout), the leg rows
  were written and the members rung for nobody, and no `<Enqueue action>` would ever come.
  The A-leg's own terminal status callback (which reaches `handleTelephonyEvent` with no
  session) now settles such a row `no_answer` — what `hangup` would have — and cleans up,
  when it is a queue transfer (leg rows exist) with no winner. The `<Dial>` path is
  untouched.
- **Unsigned bodies no longer choose what is hung up or deleted.** member-status cancels by
  the leg's stored SID (a body naming a different `CallSid` is logged and acts on nothing),
  and the result hop deletes by the recorded `escalation_queue_sid` only. Since §5c.6 the
  stored SID can no longer be seeded by a callback either.
- **The winner's leg is spared** when the result settles `connected` (defensive against
  spike item 1).
- **An all-busy roster settles `busy`**, as the `<Dial>` path does; `hangup` stays `no_answer`.
- **Degrades:** the wait hop's no-adapter error path plays the ringback rather than a bare
  `<Pause>` (up to the absolute cap of dead air), and a missing or empty `QueueTime` falls
  back to the leg rows' creation time (then the transfer's start) instead of reading as 0,
  which had switched every ceiling off.
- **Ringback by the customer's network** (§5c.4 Ringback).

**Not this branch, fixed alongside:** `startBulkCall` (non-SQS bulk) never copied the row's
`escalation_number`/`caller_id` onto the session, so a per-call escalation number on those
calls never transferred (and the VoBiz/Plivo dial-time headroom never applied). It predates
this work (present at `77a4c9d`); the SQS path always copied them.

### 5c.6 — Review fixes (PR #394, 2026-09-24)

- **Only the REST create names a leg.** `escalation_member_legs.provider_call_id` — the SID
  every cancel acts on — is written only by `recordPlaced`, from Twilio's answer to our own
  authenticated `POST /Calls.json`. `recordStatus`/`recordAnswered` no longer `COALESCE` in
  the unsigned body's `CallSid`: a forged member-status callback arriving before the create
  returned would have chosen what `endTransferLeg` later hangs up on the tenant's account.
  Signature validation was not the fix: these hops stay outside `TWILIO_SIGNED_ROUTES` for
  the base-URL-mismatch reason in §5c.4 Routes. What the trust rule costs, and how it is
  covered: (a) a callback that beats the create moves the leg's status but names nothing —
  the placement re-reads the row when the create returns and hangs up a leg whose transfer
  was decided meanwhile (`ScreenedQueueTransfer.placeLegs` → `isTransferLegLost`); (b)
  `recordPlaced` is retried once, since no callback can fill a lost write any more; (c) an
  `unknown` create (timeout) never gets a SID and cannot be cancelled — bounded by its own
  `Timeout`, and its answer hop still turns it away with the "already answered"/"no longer
  waiting" line.
- **Dial-claim errors.** `claimTransferDial` is retried once on an error (never on a
  refusal). If the retry fails too, escalate-answer still fails OPEN and connect-end CLOSED.
  Re-examined against "connect-end claimed and rendered, then the answer claim throws":
  answer's claim succeeds for every `transferring` row — including connect-end's (the
  take-over) — and the row was just read `transferring`, so the fail-open renders exactly
  what a successful claim would; the connect-end dial was already replaced by the redirect
  whose fetch this is, and the queue path places no second leg (`ON CONFLICT DO NOTHING`).
  Failing closed would ring nobody fewer times and only leave the customer with no dial.
- **The QueueSid write is awaited** in the wait hop (still best-effort). In the background
  it raced the `<Enqueue action>` a `<Leave/>` triggers: the result hop read a null SID and
  deleted nothing, and the late write was invisible to the sweep (terminal rows) — the queue
  stayed on the account.
- **Caller-hangup reaping is fenced.** `reapScreenedQueueOnCallerHangup` read "no winner"
  and then settled `no_answer`; a member's claim in between was overwritten and their leg
  cancelled. It now stamps `escalation_queue_left_at` with `markTransferQueueLeft({
  requireNoWinner: true })` before settling, the same fence the wait hop uses; a refused
  stamp means a member won, and the queue result settles it.
- **13216 on member legs.** `placeTransferLeg` retries without `TimeLimit` when Twilio
  refuses it, sharing `sendDroppingRefusedTimeLimit` with `transferCall` — every create on a
  trial account (10-minute cap) was a placement failure, so a screened roster rang no one.
- **Trailing-slash webhook bases.** `WebhookUrlBuilder.providerWebhookBase` (every
  escalation, queue, member and ringback URL, and the transfer redirect) and the Twilio
  answer document's `<Connect action>` strip trailing slashes, as `startCallRecording`
  already did; `…/twilio//escalate-…` 404s. The destination Test's base is stripped too.

### 5c.7 — Review round 2 (PR #394, 2026-09-24)

**The carrier switch degrades, it never refuses (user decision).** Master's per-carrier
`live_transfer_enabled` is a kill switch exactly like `ai_call_transfer` (§5b), so it now
behaves like one at dispatch. `preflightEscalationTransfer` refuses (`400 Unsupported
Provider`) ONLY a carrier core does not implement (`TRANSFER_CAPABLE_PROVIDERS`); the
message names the enabled carriers, or the implemented ones when none is enabled — never
an empty list. An implemented carrier that is switched off, or whose enablement was never
loaded (fail closed), lets the call through, counts
`escalation_suppressed_total{stage="dispatch"}` and warns; call-time resolution re-reads
the enabled set and ends the call instead of transferring. Single, bulk and SQS-enqueued
dispatch all go through `runCallPreflight`, so all three degrade; SQS-dequeued, inbound,
IVR and intent-callback calls never preflighted. The destination **Test** still refuses a
disabled carrier — a test cannot "degrade". `escalation_suppressed_total` gains a closed
`reason` label — `flag_off | carrier_disabled | enablement_unavailable` — at both stages,
and is now one OTel instrument, exported over OTLP and rendered on `:9090` (it was
prom-only, so the OTLP-fed alert on it could not fire). `vao-escalation-suppressed` is split
by `reason` and no longer blames only the flag.

**`<Connect action>` only while Twilio is enabled (user decision).** The answer document
carries the connect-end action only when `transferEnabledProviders().has('twilio')` at
answer time; otherwise it is exactly the pre-transfer document (stream end → call ends),
and ordinary call ends pay no webhook round trip. A call answered while Twilio was off and
escalated after a switch-on still transfers: `performTransfer`'s pre-redirect claim read
finds no `connect_end` claim (nothing could have claimed), so the REST redirect is sent,
the socket is left for Twilio and closed by the 15s backstop. It only lacks the safety net
for a socket that closes before the redirect applies — the pre-safety-net behaviour.

**The queue SID is a hint, the FriendlyName the authority.** The wait hop read `QueueSid`
off an unsigned body and every cleanup DELETEd by it, so a forged wait fetch could have had
us delete another queue on the tenant's account. Now: only a well-formed SID
(`^QU[0-9a-f]{32}$`, case-insensitive) is stored; `TwilioAdapter.deleteQueue(queueName,
queueSid?)` deletes a held SID only after `GET /Queues/{sid}.json` on the CALL's own
account returns `esc-{callId}` (a foreign-account SID 404s; a same-account mismatch is
left alone, warned and counted); otherwise the queue is found by name in ONE page of
`GET /Queues.json?PageSize=1000` — no pagination, so the cost is bounded (an account
holding more queues than that, which our own cleanup never allows, may keep one). The name
lookup also fixes the leak when the SID write failed or never ran; `cleanup` does it only
when the call has leg rows, so the stale sweep over `<Dial>` transfers costs nothing.
`escalation_queue_sid_rejected_total{reason=malformed|name_mismatch}`.

**Member callbacks are verified against the leg we placed.** member-confirm (which CLAIMS)
and member-answer require the leg row for `:memberIndex` to exist (bounding the index by
the real roster, not just the cap), be non-terminal, hold the SID our authenticated REST
create returned, and match the body's `CallSid` when it carries one; a `CallStatus` outside
Twilio's vocabulary (`queued initiated ringing in-progress completed busy no-answer failed
canceled`) is refused too. Otherwise that request's leg is hung up with the reject document
— no claim, no verdict, no `answered_at` stamp —
`escalation_screened_queue_legs_total{outcome="rejected"}`. member-status ignores a
status outside the vocabulary, writes nothing for an index with no leg, and on a leg we
hold a SID for accepts only callbacks carrying that SID (a forged `completed` can no
longer finish a live member's leg and release the customer early); a leg with no SID yet
still takes a callback's status (never its SID) *(superseded by §5c.8: it now ignores the
callback entirely, and member-answer/confirm REQUIRE the `CallSid`)*. **Accepted cost:** a member on a leg
whose SID we never learned (`unknown` create, or a SID write that failed twice) is turned
away at the gate. On the single-member `<Dial>` path, `escalate-whisper-confirm` writes the
verdict `resolveTransferStatus` reads; a request whose `ParentCallSid` differs from the
call's own CallSid (when both are known and the row holds a real `CA…` SID) is refused
without recording one. Absent either, that hop is guarded by the call id only (§6b)
*(superseded by §5c.8: `ParentCallSid` is now REQUIRED and must equal the row's SID, and
only a Twilio row on the Twilio namespace is ever graded)*.

**Master S2S is a precondition for ANY live transfer.** With `MASTER_SERVICE_URL` /
`MASTER_S2S_TOKEN` unset, every carrier is off. Core now logs ONE error at boot saying so;
`.env.example` says both are required for live transfer on VoBiz, Plivo and Twilio;
`vao-escalation-live-transfer-fail-closed` (critical, any fail-closed read in 10m) and
`vao-escalation-live-transfer-refresh-failed` (warning, sustained failed refreshes) page on
it; the Human Transfer dashboard row gained per-provider outcomes, fail-closed reads,
refreshes, caller-ID substitution, queue-leg outcomes and rejected queue SIDs. The
fail-closed stage label is a literal union (`LiveTransferReadStage`).

**Metadata.** `/metadata` `escalation_transfer.destination_test.implemented_configured_providers`
= implemented ∩ configured-here, sorted, governance-independent. Master intersects it
with its live set and the tenant's allowed carriers for `destination_test.supported`, then
strips it (and `transfer_implemented_providers`, `implemented_supported`) from the
tenant-facing body. A cross-repo source-text contract suite
(`test/unit/escalation/master-live-transfer-contract.test.ts`, sibling pattern, skips
when master is absent) pins the S2S path, bearer auth, `{providers: string[]}` shape and
these field names.

**Smaller:** the call-start escalation prediction is resolved once per session and shared
by the VoBiz/Plivo dial headroom and the handoff-line prefetch; the caller-hangup queue
reaper is skipped before its DB read for events a non-queue carrier's parser stamped
(`CallEvent.provider`); the BYOC-only render fallback was unreachable (§5c.4 BYOC) and is
gone; the new hops check `:callId` is a UUID before any read; one `escapeXml` and one
import-free `normalizeWebhookBase` (now also applied by `WebhookUrlBuilder.baseUrl`).

**Not done:** moving the screened-queue hop family into its own route module. It shares
~10 plugin-scope closures with the hops that stay (`loadTransferContext`,
`escalationHangupXml`, `readCallQuietly`, `readConfirmDigits`, the shared
`ScreenedQueueTransfer`, the registry, the call manager) and relies on the plugin's form
parser and Twilio signature hook, so it is a refactor, not a pure move.

**Spike additions:** 13. Twilio sends `ParentCallSid` on the single-member whisper
`<Gather action>` ~~(if not, that check is simply inert)~~ — **since §5c.8 a blocker, not a
nicety:** the check is now required, so if Twilio does not send it every single-member
screened transfer on Twilio is refused at the gate and speaks the fallback. 14. `GET /Queues.json` returns
`friendly_name`, and `GET /Queues/{sid}.json` on a foreign-account SID answers 404.

### 5c.8 — Review round 3 (PR #394, 2026-09-24)

Every item here is a hop that trusted something an unsigned body could leave out, repeat,
or inflate. The posture is now uniform: **a field that identifies the request is
required, a duplicated form key is read as absent (the `readConfirmDigits` rule), and
nothing a body says can move a clock forward.**

**`escalate-whisper-confirm` grades only a verified request.** The verdict it writes is
DECISIVE for settlement — `resolveTransferStatus` settles a `refused` as `no_answer` +
fallback even when Twilio reports `DialBridged=true` — so a forged refusal turned a
conversation a human took into an unanswered transfer. Round 2 compared `ParentCallSid`
only when it was a string and the row held a `CA…` SID; absent, or duplicated (an array
off the form parser → `''`), skipped the check. Now a verdict is written only when (a)
the route namespace AND the row are on a carrier whose gate we render
(`RENDERED_SCREENING_GATE_PROVIDERS = {twilio}` — VoBiz/Plivo adapters ignore
`confirmActionUrl`, confirmed by reading `generateTransferConfirmResponse`, so nothing
genuine ever posts to this hop on their namespaces; the route stays registered for them)
and (b) `ParentCallSid` is present, a single string, and equals the row's
`provider_call_id`. Anything else hangs the leg up with NO verdict — including a row that
holds an `inbound-…` placeholder (a Twilio transfer is REST-redirected by the real SID, so
such a row is not one Twilio can be dialling from). The catch writes `refused` only for a
request already verified. Spike item 13 is therefore now a blocker (above).

**Member hops require the leg's SID.** `memberLegRejection` returns `sid_missing` for a
missing or duplicated `CallSid` on member-answer and member-confirm: Twilio puts
`CallSid` on every request for a leg, and a forged confirm that simply omitted it used to
pass and — with the right digit — WIN the claim and cancel every other member.

**A leg with no SID ignores its callbacks — status included.** member-status used to write
the status of any callback for a `placing`/`unknown` leg (nothing to compare the SID
against), and `completed` is terminal and sticky: `recordPlaced` could not undo it, the
answer hop treated the member as finished, and the wait hop could release the customer on
`all_members_finished` while that phone still rang. Now such a callback writes nothing.
Bounded as follows: a `placing` leg's create returns in well under a second, after which
its callbacks carry the SID we hold and count, and `placeLegs` hangs up a leg whose
transfer was decided meanwhile; an `unknown` leg never reads as finished, so the ring-phase
ceiling (`wait_timeout`) or the absolute ceiling releases the customer — never later than
that — while the member rings to their own `Timeout` and is turned away at the gate. The
repository's "a callback replaces our own `failed` marker" exception is now reachable
from no route (kept as a table rule); a `failed` leg is one the carrier refused.

**The queue clock is the server's.** A forged wait fetch with `QueueTime=9999` decided
`absolute_timeout`, stamped `escalation_queue_left_at`, and every later accept was
refused while the real customer heard ringback until the real ceiling.
`screenedQueueClockSeconds` now measures from the leg rows' `created_at` (written in the
request that rendered the `<Enqueue>`, so before the customer entered the queue), else the
transfer's start; the body's `QueueTime` counts only with a well-formed `QueueSid` that is
the stored one (or the one this very fetch stores), and then only as `min(QueueTime,
server)` — it can refine the clock after a connect-end take-over re-enqueues the
customer, never bring a ceiling forward. A forged fetch can still make its OWN response
say "keep waiting", which is harmless: the response goes to the forger, and the only side
effect of the hop is a `<Leave/>`'s stamp. *Poisoning the stored SID* with a forged first
fetch (a foreign but well-formed `QueueSid`) is not verified by a REST read inside
Twilio's webhook budget, because it is neutralised twice: timing no longer depends on the
SID (Twilio's genuine fetches then simply lose their `QueueTime` refinement), and every
delete verifies the stored SID's FriendlyName is `esc-{callId}` before acting and otherwise
finds the queue by name (§5c.7). Cost: DB-vs-app clock skew now biases the ceilings by the
skew (the `answered_at` window already had that dependency).

**The wait hop's degrade path fences its release.** Past the absolute ceiling, a throw in
the try returned `<Leave/>` without stamping `escalation_queue_left_at`, so a late accept
could still win and dequeue into the queue just emptied. The catch now stamps via
`markTransferQueueLeft({ requireNoWinner: false })` (best-effort; the ceiling is final
whoever has won, as on the try path; it matches nothing on a row no longer transferring)
— but only when the clock it expired on is verified (the try's, or the server's from the
row it read). With the row unreadable the body's `QueueTime` still decides THIS response,
so a DB outage cannot hold the customer forever, but it stamps nothing: an unsigned body
must not fence out the real members even during a fault.

**IVR dials carry the VoBiz/Plivo transfer headroom (§5c.3 C1).** Neither IVR dial site
did: `initiateIvrCallsInBackground` dialled at `workflow.max_duration_seconds`, and the
SQS-dequeued IVR dial hardcoded `maxDuration: 300`, ignoring the workflow. A transfer from
an `ai_handoff`'s AI half is bounded by that dial's `time_limit`, so the bridge got
whatever the IVR and AI halves had left. `src/escalation/ivr-dial-headroom.ts`:

- `predictIvrEscalationHeadroomSeconds` mirrors call-time resolution in `prefetch` mode,
  per `ai_handoff` step: the carrier is live-transfer enabled and `ai_call_transfer` is on
  (once); a LITERAL `prompt_template_id` whose prompt carries `escalate_to_human` → its
  destination's `ring + max_transfer + 120s` when it can ring someone, else the preset's
  when a per-call number is possible (the step names one — literal E.164 or a
  `{{variable}}` a menu step may fill — or the DID the call is placed from has one, the
  engine's own fallback); no tool or no prompt → nothing. A `{{variable}}` prompt id is
  chosen by the caller's answers and is **not knowable before the dial**, so it is sized
  against the account's largest active destination (and the preset when possible): over-
  sizing costs only the carrier backstop on an orphaned leg, which the stale sweep still
  reaps; under-sizing hangs up on a customer mid-conversation with a human. The largest
  step wins; never throws.
- `ivrDialMaxDurationSeconds` adds it only for an adapter that transfers without
  `transferExtendsTimeLimit`. **Twilio is unchanged** (it raises `TimeLimit` on the
  transfer request from the IVR leg's start) and predicts nothing.
- The batch dial shares one prediction per batch (same workflow, account, carrier, caller
  ID), computed before the post-claim cancel re-read so nothing awaits between it and the
  dial; the dequeued dial reads the workflow (`findByIdScoped` — an accepted session keeps
  running after the workflow is disabled) and applies the same rule, or dials at the 300s
  column default when it cannot read it.
- What it bounds: an escalation that happens by `max_duration_seconds` — when the call
  would otherwise have been cut — gets its full bridge. The whole call can now run past
  the workflow limit into the headroom (the AI half's own `callTimeoutSeconds` timer still
  ends a non-escalated call), and an escalation made in that extra time gets what is left.

**Master 429 (cross-check, no behaviour gap).** A master reviewer asked whether core reads
any non-200 from `GET /internal/telephony-providers/live-transfer` as "no carrier enabled".
It does not: every non-2xx, a 429 included, throws `MasterUnavailableError`; the loader
keeps its in-memory snapshot (last-known-good), adopts a NEWER Redis LKG if a sibling wrote
one, and never writes Redis on a failure; a cold process with nothing in Redis stays
fail-closed (and does not create a Redis entry). Pinned by tests for exactly a 429. New: a
429/503 `Retry-After` (delay-seconds or HTTP-date) rides on the error, and the loader makes
no master request until it has passed — readers and the 30s background timer alike —
capped at `MAX_RETRY_AFTER_MS` (5 min) so a bogus header cannot freeze the switch.

**Spike additions:** 15. A VoBiz/Plivo IVR call that walks the menu and escalates from its
`ai_handoff` keeps the bridge past `max_duration_seconds` (the dial carried the headroom).
16. Twilio's genuine member-leg requests (answer fetch, `<Gather action>`, status callbacks)
always carry `CallSid`, and wait fetches always carry `QueueSid` — both are now required
for the request to count.

## 6. Billing — decided: the whole spoken duration

A transferred call bills exactly like any other voice call, on **total spoken duration** —
the AI conversation *plus* the human conversation that followed. That means the call row
stays open across the handoff, which drives most of the interesting design:

- **The row does not settle at transfer.** `escalateToHuman` marks it
  `escalation_transfer_status='transferring'`, persists the transcript, and detaches the
  session. It deliberately does **not** hang up the carrier leg, release the concurrency
  slot, or dispatch a settlement.
- **The concurrency slot is held** until the call really ends — the call still occupies
  real carrier capacity, so freeing the slot would oversubscribe the tenant.
- **Settlement runs from the `<Dial action>` webhook**, which can land on any replica. By
  then no `CallSession` exists, so `settleTransferredById` computes everything in SQL from
  the row: `talk_time_seconds` from `answered_at` (spanning both halves), and the slots are
  released by `external_ref_id`, the key they were acquired under.
- **Idempotency is the `WHERE escalation_transfer_status = 'transferring'` predicate** —
  it is both the claim and the guard, so a carrier retry finds no row and bills nothing.
- **A lost webhook can't strand capacity.** `failStaleTransferredCalls` sweeps mid-transfer
  rows on their own clock (`max_transfer_seconds` ceiling + grace), and the generic 30-minute
  stale sweep explicitly **skips** them — reusing it would hang up on live human calls.

`escalate_human` still counts as connected in usage. What's new is that "escalated" and
"escalated **and** a human picked up" are now distinguishable: `escalation_transfer_status`
records `connected` / `no_answer` / `busy` / `failed` separately from the call status. An
unrecognized carrier `DialStatus` maps to `failed`, never optimistically to `connected`.

## 6b. Review findings and what changed

Three independent reviews (lifecycle correctness, API/UI extendability, security)
ran against the first implementation. The lifecycle review found four real defects
worth recording, because each is a trap the next person here could re-introduce.

**The dial list is written before the carrier is told to transfer.** Originally the
row was updated *after* the 202. VoBiz fetches `escalate-answer` the instant it
accepts the transfer, possibly on another replica — so under load the webhook found
no destination, apologised, and hung up on the customer who had just asked for a
human, leaving the row marked `transferring` with no dial in flight. Persist first;
the failure path rewrites the row to `failed`.

**The handoff window is sealed.** `callEndTriggered` stops the *event-bus* end
paths, but several callers reach `handleCallEnd`/`forceEndCall` directly — the
`end_call` tool firing in the same model turn as `escalate_to_human`, the carrier
fallback webhook, the max-duration timer, graceful shutdown, and
`POST /calls/:id/end`. Any of them mid-handoff would hang up on the customer *and*
settle the call, which the dial-result webhook would then settle again. Both
functions now refuse while `transferState !== 'none'`, and the transfer re-checks
`endHandled` after the handoff line (which takes up to ~8s).

**`cancelActiveById` excludes mid-transfer rows.** The exclusion had been added to
the stale sweep but not to user-cancel, so cancelling a bridged call marked a live
conversation `failed`, settled it, released its slots — and let the real dial result
settle it a second time for the full talk time.

**The concurrency slot is actually held now.** §6 claims the slot is held for the
whole call, but the Redis lock TTL is sized at acquire time from the ordinary call
timeout (~5.5 min). For a transferred call it expired mid-conversation and the
self-heal reconcile handed the capacity back while the call was still up. Both
guards gained `extendLock`, and the transfer extends to the destination's
`max_transfer_seconds` + grace — the same problem the WebRTC bridge solves with its
TTL override.

**Swept transfers bill only the provable span.** The sweep recomputed talk time as
`NOW() - answered_at`, so a 40-second unanswered transfer whose result webhook was
dropped settled hours later as ~250 billed minutes. It now bills
`escalation_transferred_at - answered_at` — the AI half, which we can evidence — and
leaves the bridge duration NULL. Under-billing a dropped webhook is the only honest
direction.

Also fixed: voicemail is no longer transferable (passive AMD kept the pipeline alive,
so an escalation would ring the roster and bridge an agent to a recording);
transferred calls emit `call_completed` (they were vanishing from the funnel entirely);
`voice`/`language` are escaped in the transfer XML attributes; the no-answer line is
spoken in the call's language via the adapter rather than a hardcoded `en-IN`.

**Still open** (accepted, in the existing VoBiz trust model): the five escalation
webhooks are unauthenticated and guarded only by an unguessable callId, as every
other VoBiz webhook is. Two consequences are larger here than for the siblings — a
callId-holder can read the roster's phone numbers out of `escalate-answer`, and can
force early settlement of a live bridged call via a forged `DialStatus`. VoBiz
publishes no webhook signature; closing this needs either a signed-nonce URL per
transfer or a `transferring`-status precondition on the answer route.

## 6c. Second review round (three independent reviewers)

A principal-engineer, principal-PM and principal-QA pass over the finished branch.
Three reviewers independently converged on the same root cause, which is the part worth
recording.

**The escalation claim was a TOCTOU.** The entry guard checked `transferState`/
`endHandled`/`callEndTriggered` synchronously, but nothing was claimed until after
`resolveEscalationDestinationForCall` — a Redis flag read plus a DB read. Two ways
through that window, both real:

- *A duplicate tool call.* Models fire the same tool twice in one turn. Both invocations
  passed the guard, both transferred the leg — and the second one's failure handler,
  which resets `transferState` and calls `forceEndCall`, would **hang up the call the
  first had just bridged to a human**.
- *A hangup during resolution.* The customer hanging up right after "let me connect you"
  is the single most likely moment for a hangup on the whole call. With `transferState`
  still `'none'`, the seals did not apply, so `handleCallEnd` ran to completion —
  settling the row and dispatching its settlement — and the escalation then wrote
  `transferring` onto that **already-settled** row.

Fixed by claiming synchronously (`CallSession.escalationClaimed`, which cannot be
`transferState` — that doubles as the seal, so claiming it at entry would leave every
degrade-to-legacy path unable to end the call) and re-checking immediately before the
row write. The re-check is the correctness fix; the claim stops the duplicate paying for
a second resolution.

**The abandon path poisoned rows.** Aborting after the handoff line returned without
rewriting the row, unlike the transfer-failure path. A terminal row still marked
`transferring` is exactly what `failStaleTransferredCalls` claims — so ~4h later the
sweep rewrote its status, reset `ended_at`, and dispatched a **second settlement**. Now
the abandon path clears the marker, and the sweep additionally refuses any row with
`ended_at IS NOT NULL` — belt and braces, because the cost of being wrong is
double-billing a customer.

**An unguarded DB write sat inside an event-bus listener.** `callEventBus.on('call.escalated', …)`
has no catch, and there is no process-level `unhandledRejection` handler behind it, so a
transient DB error at the moment of escalation would take down the replica and every live
call on it. This was a *new* exposure: the path it replaced (`handleCallEnd`) is fully
try/caught. The committed half of the transfer is now split into `performTransfer` under
one catch that degrades to the normal failure path.

**A silently no-op API filter.** `escalation_transfer_status` was validated and
implemented in both repository methods, but no route forwarded it — so
`GET /api/v1/calls?escalation_transfer_status=no_answer` returned **200 with an
unfiltered list**. This is the query the feature exists to answer, and the contract cusui
would have built its reporting screen on; a silently-wrong filter is worse than a missing
one because the UI renders it as confident truth. Wired through all four routes (list,
search, and both exports).

**A configuration the docs described but the API refused.** §4c and
`preflightEscalationTransfer` both treat a policy-only destination — empty roster, there
to carry caller ID / whisper / timeouts for calls that bring their own number — as a
legitimate setup. The validator required ≥1 member, so creating one was a 400. The DB
always allowed it (`members JSONB NOT NULL DEFAULT '[]'`); the validator was the layer
that was wrong. A **non-empty** roster must still contain an active member, because
`[all inactive]` is a half-finished edit whereas `[]` is a statement of intent.

**Two carrier-facing hardenings that compose.** `transferCall` had no timeout — a hung
VoBiz API would leave the customer in silence indefinitely — and `escalate-answer` would
render a `<Dial>` for a row in any state. Both are now bounded: a 10s transfer timeout,
and a `transferring` precondition on the answer route. They matter together, because a
*timeout is ambiguous* (VoBiz may have accepted the 202 we never saw): the caller marks
the row `failed`, and the precondition is what stops the carrier's follow-up fetch from
ringing the whole roster for a call we already ended. The precondition lives in the answer
handler and **not** in the shared `loadTransferContext`, because `escalate-result`
deliberately loads the context *after* settling, when the status is no longer
`transferring` — putting it in the loader silently kills the no-answer fallback message.
Both directions are mutation-tested.

**Coverage the reviewers were right to call out.** The money path — `settleTransferredById`
and `failStaleTransferredCalls` — had been exercised only through a mocked repository, so
the SQL deciding what a customer is charged, and whether a carrier retry charges them
twice, was executed by nothing. Likewise `escalate-result`, the one hop that settles and
bills. Both now have tests, and the settle-then-load state transition is modelled rather
than fixtured, which is what caught the precondition bug above.

## 7. What was built

**DB** — migration `062`: `escalation_destinations` + six nullable transfer columns on
`calls` (the CHECK is added `NOT VALID` then validated, since migrations run at container
start while the previous replicas are still dispatching) + a partial index on mid-transfer
rows for the sweep. Migration `063`: `calls.escalation_number`, plus `escalation_number` on
`inbound_phone_numbers` and `inbound_intents` for the inbound half, and `'preset'` added to
the `escalation_target_source` CHECK. Persisted rather than held in memory because an
account-queued call is dequeued into a fresh session minutes later and possibly on another
replica — the same reason `machine_detection` / `barge_in_grace_period_ms` are (migration 052).

**Telephony** — `TransferCapableProvider` is a *separate optional interface*, not a method on
`TelephonyProvider`, so adapters that can't transfer need no throwing stub and the gate is a
real capability check (`supportsTransfer`). VoBiz implements `transferCall` (a 404 **throws**
here, unlike `endCall`, because "already gone" means the customer hung up mid-handoff and
nothing was transferred) plus the dial/whisper/outcome XML.

**Core** — `CallManager.escalateToHuman` / `settleTransferredCall` /
`finalizeTransferredCall` / `detachTransferredSession`, plus `sweepStaleTransferredCalls`
wired into the existing self-heal sweep. The silence-nudge clip machinery was factored into
`convertCachedClip` + `streamClipToTelephony` and reused for the handoff line.

**API** — `POST|GET /api/v1/escalation-destinations`, `GET|PUT|DELETE /:id`; five webhooks
per transfer-capable carrier (`escalate-answer` / `escalate-whisper` /
`escalate-whisper-confirm` / `escalate-result` / `escalate-status` — the third arrived with
Twilio, §5c; VoBiz-only and four when this was written), plus Twilio's `escalate-connect-end`
(§5c.3) and the six screened-queue hops (§5c.4, migration 128; the ringback is served in two
cadences since §5c.5, which also added migration 129);
`preflightEscalationTransfer` on both the single and bulk call routes.
`escalation_number` on `POST /calls` (`config.`), on `POST /calls/bulk` (batch-level and
per-recipient), on inbound DID create/update, and on `POST /internal/inbound-intents`; the
IVR `ai_handoff` step gains an interpolated `escalation_number`.

**Gating** — `ai_call_transfer` flag (`FF_AI_CALL_TRANSFER`, default off, clientExposed).

**Observability** — `escalation_transfers_total{provider,result}`; audit
`call.escalation.transferred` and `escalation_destination.*`.

**API surface for master/cusui** — the nine transfer columns now reach
`formatCallResponse` (nested under `escalation`), the CSV export (opt-in via
`?fields=`), an `escalation_transfer_status` list filter (plus `none` for
"escalated by hanging up"), and a batch-analytics
`escalation_transfer_distribution`. `GET /api/v1/escalation-destinations/caller-ids`
backs the create form (the WebRTC equivalent is unreachable behind its own flag).
`/api/v1/metadata` publishes the bounds, enums and `transfer_capable_providers` so
cusui doesn't keep a second copy. Prompt-tool writes now verify destination
ownership, matching the knowledge-base precedent.

**Tests** — 175 new (VoBiz transfer + XML, escalation helpers incl. the `escalate_to`
resolution matrix, the tool payload, the CallManager path, the §4c preset matrix, preflight
and call-time resolution, the inbound resolution chain, and the `escalate-answer` webhook).
Mutation-checked invariants, each of which fails a test when broken: the end-claim
*preceding* the transfer; slots *not* released at transfer; both §4b security gates
(removing the `allow_dynamic_target` check, loosening E.164 validation); both §6b lifecycle
fixes (reordering the write after the transfer, removing the `forceEndCall` seal); and four
from §4c — a configured destination winning over the per-call number (inverted 2026-09-12;
it previously pinned the opposite), the "prompt has no escalate_to_human tool" 400, the
empty-roster rejection when no number is supplied, and the webhook's policy synthesis for a
destination-less transfer.

All four escalation webhook routes are now covered (§6c), including `escalate-result` —
the one hop that settles and bills — and the settlement SQL underneath it. Both were
previously exercised only through mocks.

## 7b. Destination `/test` (migration 065)

`POST /api/v1/escalation-destinations/:id/test` closes the "a dead agent number first
surfaces during a real customer escalation" gap, following the `sip-connections`
`POST /:id/test` precedent.

**It places a real outbound leg**, because that is the only version of the test worth
having. E.164 validation already runs at write time, and typos are not what breaks a
roster — a disconnected number, a ported one, a phone forwarded to a voicemail box nobody
empties, or an agent who left all pass every format check. None of them is visible from the
string.

It is deliberately **not** the transfer state machine. No A-leg, no bridge, no `<Dial>`, no
`calls` row, nothing settles through `CallManager`: one outbound leg that speaks a fixed
line and hangs up. Reusing the escalation path would mean synthesizing a fake customer call
to transfer *from* — more moving parts, and a worse test (it would exercise the bridge, not
the number). It also takes **no concurrency slot**: the leg is capped at 60s and the
cooldown already bounds it to one in flight per roster, so charging it against the tenant's
limit would let a diagnostic starve production traffic.

Six decisions worth recording:

1. **`member` is required, not defaulted.** An implicit choice is how a diagnostic rings the
   wrong human; defaulting to the whole roster would turn one click into ten simultaneous
   calls. Validated against the destination's own *active* `phone` members — an inactive
   member would report on a path no escalation dials, and a `sip` member needs a matching
   trunk a destination does not carry.
2. **The spoken line is fixed**, not operator-authored. Letting an operator write the script
   would turn a diagnostic into an outbound-message primitive aimed at an arbitrary number.
   It names the tenant only when `x-mgkvc-tenant-name` is supplied — never the tenant *id*,
   which is usually a slug or UUID and would be read out character by character.
3. **Rate limited by an atomic claim.** `claimTest` is one guarded `UPDATE` that both checks
   the cooldown and flips the row to `testing`, so a double-click cannot place two billable
   calls. The window is anchored on the **claim**, not the result, which makes it
   self-healing: a `testing` row whose status webhook never arrived becomes claimable again
   after the cooldown instead of wedging the destination.
4. **202, not 200.** The outcome arrives on a carrier status webhook tens of seconds later,
   quite possibly on another replica, so it is persisted (`last_test_status` /
   `last_test_dial_status` / `last_test_error` / `last_test_member`) and read back via
   `GET /:id`. `testing` has no analogue in `sip_connections`, whose test is a synchronous
   API probe.
5. **Only `completed` is success.** `no-answer` and `busy` are not platform errors but they
   *are* test failures — the operator asked whether this number reaches somebody, and it
   did not. The raw carrier status is kept separately from the error string, because
   "no-answer" is a result to interpret rather than a fault.
6. **The status webhook cannot overwrite a real result.** It is unauthenticated by
   necessity, so the write is gated on `last_test_status = 'testing'`: a replayed or forged
   callback for a destination not mid-test writes nothing. The answer hop is entirely
   DB-free — the line and its TTS cache hash are pure functions of the URL — and degrades to
   the carrier's `<Speak>` whenever the pre-generated clip is absent.

**Which carrier the leg runs on (2026-09-23).** A destination that records its carrier
(`provider` + `telephony_credential_id`, migration 127, §5c.3) is tested over exactly
that carrier and credential — the trunk its caller ID was validated on — and refused
(400, before the cooldown claim) when master has switched that carrier off. A legacy row
still resolves through `resolveTransferProvider`. What counts as a pass is unchanged.

Flag-gated **with create/update**, not with the deliberately-ungated read/delete pair (§5b):
a test adds capability and spends money, and nothing about an incident requires placing one.

`/api/v1/metadata` publishes `escalation_transfer.destination_test`
(`supported` / `places_real_call` / `cooldown_seconds` / `max_duration_seconds` /
`testable_member_types`) so a UI can frame the cost and pre-disable the button rather than
discovering the cooldown by 429.

## 8. Not built (deliberate)

- **master / cusui surfaces** — the UI itself. Core's contract is now complete for it
  (see §7); what's missing is the destination CRUD screens, the transfer outcome on the
  call-detail page, the destination picker in the prompt tool editor, and — for §4c — the
  "escalate to" field on the call-initiation form plus an `escalation_number` column in the
  bulk contact-list upload. A UI can tell whether to *show* that field by reading the
  prompt's tools (`GET /api/v1/prompts/:id/tools` → an `escalate_to_human` entry) and
  `/api/v1/metadata` → `escalation_transfer.supports_per_call_number`. Neither repo was
  available in the session this was built in, so the cross-repo wiring is unverified.
- **Per-call SIP escalation targets** — `escalation_number` is E.164 only. A roster member
  can be `type: 'sip'`; a per-call one cannot. No demand yet, and it would need a second
  validated shape at every intake point.
- **Webhook authentication** — see §6b. Now materially narrowed: `escalate-answer` only
  answers while a transfer is genuinely in flight (§6c), so the phone-number disclosure is
  bounded to the transfer window rather than the lifetime of the row. A forged
  `escalate-result` can still settle a live bridged call early. VoBiz publishes no
  signature scheme, so closing it properly needs a signed nonce in the per-transfer URL —
  which `escalateToHuman` already generates and would be the natural place to sign.
- **Sequential (tiered) ring** — column present, CHECK rejects it until the chained-`<Dial>`
  state machine exists.
- **Business hours** — an escalation outside working hours currently rings and falls through
  to the fallback message rather than skipping the dial.
- **Escalation load control** — 50 concurrent AI calls escalating to one roster will ring it
  50 times. The 10-member cap bounds a single escalation, not the aggregate.
- **Post-transfer voice continuity is untested against a live carrier.** The handoff line is
  gated on clip duration rather than VoBiz's `playedStream` checkpoint — that ack arrives on
  the very socket the transfer closes, so waiting for it risks waiting forever. Worth
  confirming on a real call that the goodbye isn't clipped.

## Sources

- [Vobiz — Transfer a Call](https://vobiz.ai/docs/call/transfer-call)
- [Vobiz — `<Dial>` element](https://vobiz.ai/docs/xml/dial)
- [Vobiz — `<Number>` element](https://vobiz.ai/docs/xml/dial/number)
- [Vobiz — `<Stream>` element](https://vobiz.ai/docs/xml/stream)
- [Vobiz — Call Transfer solutions overview](https://vobiz.ai/docs/solutions/call-transfer)
- [Vobiz — Conference object](https://vobiz.ai/docs/conference/conference-object)
- [Plivo — Transfer a call](https://www.plivo.com/docs/voice/api/call/transfer-a-call) (family API, same semantics)
