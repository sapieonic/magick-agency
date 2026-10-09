> **Reference copy, verbatim below this box.** Origin: magick-comms-cusui @ `ee5beb44` (v2.96.0), path `docs/core-ui-redesign/02-design-spec.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The copy dictionary behind `apps/console/src/utils/vocabulary.ts`. Applies to the console as ported; MagickVoice product names are replaced per decision B17.
>
> Index of all copies: [`docs/reference/README.md`](../../../README.md).

# 02 — Design Specification (UX/UI)

Source of truth: `docs/core-ui-redesign/00-brief.md`. Implementation-ready: strings verbatim,
components are contracts. Audience: non-technical users, zero jargon. No backend changes;
personalize chips still emit `{{token}}` under the hood. (Full spec — see sections below.)

## 1. VOCABULARY & COPY DICTIONARY

### 1.1 Channel / campaign-type names
| Internal | Today | New |
|---|---|---|
| static_call | Static Call | Voice message |
| ai_voice_call | AI Voice | AI call |
| ivr_call | IVR | Phone menu |
| whatsapp_message | WhatsApp | WhatsApp |
| telegram_message | Telegram | Telegram |

Composer tab descriptions:
- Voice message: "Play a recorded or typed-aloud message to everyone you call."
- AI call: "Have an AI agent hold a real conversation with each person."
- Phone menu: "Let people press keys to choose what happens next."

### 1.2 Status humanizer (key on lowercased, underscore-stripped value)
Job-level: queued→Waiting · processing→In progress · dispatched→Sending… · in_progress→In progress ·
completed→Done · partially_failed→"Done — some didn't connect" · failed→"Couldn't send" ·
cancelled→Stopped · scheduled→Scheduled.
Per-call: queued→Waiting · initiating/initiated→Starting… · ringing→Ringing · in_progress/executing→"On the call" ·
completed→Connected · failed→"Didn't connect" · no_answer→"No answer" · busy→"Line busy" ·
switched_off→"Phone was off" · timeout→"Took too long" · cancelled→Stopped · pending→Waiting.
Messaging: sending→Sending… · sent→Sent · delivered→Delivered · read→Read · undelivered→"Didn't arrive".
Analysis column "Analysis"→"AI summary": completed→Ready · pending→Working… · failed→Unavailable · skipped→"Not run".
Sentiment: positive/negative/mixed/neutral → Happy/Unhappy/Mixed/Neutral.

### 1.3 Source values
direct_ui→"Created here" · contact_list→"From a contact list" · scheduler→Scheduled · retry→Auto-retry.
"Source" column header → "How it started" (demoted out of primary bar).

### 1.4 Titles & headings (selected)
Bulk list "Bulk Dispatch Jobs"→"Campaigns" (subtitle "Every group of calls you've sent, newest first.").
Detail "Job Information"→"Campaign details"; "Outcome Breakdown"→"How the calls went"; "Calls"→"Each call".
Composer steps: "What happens on the call" → "Who you're calling" → "Settings & timing".
Prompts: "New call script"; Identity→Name; Agent brain→"What your agent should do";
System prompt→"Instructions for your agent"; Conversation rules→"Do's and don'ts";
Behavior→"If the caller goes quiet"; Languages→"Languages it can speak"; Tools→"Connect to your systems" (Advanced);
Post-call analysis→"What to capture from each call".
Announcements→"Voice messages"; "Text to Speak"→"Message to read aloud"; TTS→"Type a message"; Audio File→"Upload a recording".
Dashboard channels: AI Voice→"AI calls"; IVR→"Phone menus"; Announcements→"Voice messages"; Messaging→"Messages".

### 1.5 Buttons
Create prompt→"Save script"; Enhance with AI→"Improve writing"; Launch N calls→"Send N calls";
Retry Failed Batches→"Try the calls that didn't go through"; Cancel Job→"Stop this campaign";
Export CSV→"Download as spreadsheet"; Top Up→"Add credits".

### 1.6 Banned from the four surfaces
dispatch, job, batch(es), slug, system prompt, agent brain, TTS, IVR, pipeline, provider, telephony,
caller ID, concurrency, slots, "source: direct UI", status_summary. "Caller ID"→"Number people will see".
Provider→"Phone carrier" (Advanced/analytics only).

## 2. SHARED COMPONENTS

### 2.1 PersonalizeField — chip insert; replaces raw {{variable}} typing
- Canonical value is always the `{{token}}` string; component parses with extractVariables and renders chips.
- "+ Personalize" button opens a menu of friendly field names; selecting inserts `{{token}}` at caret. User never types braces.
- Unknown tokens render as a chip with humanized label, never raw braces. ✕ removes a chip atomically.
- Below field: "This message needs these columns in your list: First name, Amount due." Empty: "Want to use each person's name or details? Click + Personalize."
- Props: value, onChange (emits canonical {{token}}), fields[{token,label,hint}], placeholder, minHeight, required, disabled, allowCustom, aria-label.
- Guardrail: onChange output is byte-for-byte a {{token}} string; round-trip tested.

### 2.2 AdvancedSection — collapsible disclosure
- Props: label="Advanced options", summary="Safe defaults are already set.", defaultOpen=false, badgeCount, children, onToggle.
- Native details/summary semantics; chevron; "N changed" chip when non-default controls hidden inside.

## 3. PER-SURFACE (summary — see brief for full)
- Dashboard: one primary CTA "Start a campaign"; REMOVE ConcurrencyPanel; credit anchor "N credits · ≈ M min of calls left"; channel renames; status via humanizer; "today at a glance" line.
- Bulk: composer steps renamed; PersonalizeField; retry/interval/emails → AdvancedSection; tracking title "Campaigns"; KPI relabels; remove Source from primary; hide batches/provider/raw ids; friendly progress "850 of 1,000 calls done · 12 didn't connect".
- Prompts: "call script"; hide slug; section renames; PersonalizeField for instructions; Tools→Advanced; reword save-before-test gate; "Improve writing".
- Static: "Voice messages"; type toggle "Type a message"/"Upload a recording"; PersonalizeField; voice options→Advanced; WOMAN/MAN→"Female voice"/"Male voice"; keep "preview coming soon".

## 4. MICRO-COPY
- Credit anchor: "{credits} credits · ≈ {minutes} min of calls left"; rate unknown → credits only.
- Progress: "{done} of {total} calls done" (+ " · {failed} didn't connect"); clean → "All {total} calls done".
- Empty: Campaigns "No campaigns yet / When you send a group of calls, they'll show up here."; Voice messages "No voice messages yet / Create a voice message to play when people answer your call."; Call scripts "No call scripts yet / A call script tells your AI agent what to do on the phone."
- Toasts: "Your campaign is on its way." / "Script saved." / "Campaign stopped."

### Implementation notes
- `src/utils/vocabulary.ts`: humanizeStatus(raw, scope?), TYPE_LABELS, SOURCE_LABELS, STATUS_TOOLTIPS, humanizeToken. StatusBadge points at it. bulk-jobs.ts re-exports to avoid scattering.
- PersonalizeField + AdvancedSection in src/components/common/ with CSS Modules + tests.
- Additive/reversible: hide via render, keep state/payload/hooks. Retire legacy via routing only.
