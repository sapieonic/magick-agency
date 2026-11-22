# Campaign setup: New campaign and campaign Settings (CS)

Supervisors said creating a campaign was hard: the builder's "How agents work" step put every
setting on one long screen. This redesign gives New campaign (`/agency/campaigns/new`) and a
campaign's Settings (`/agency/campaigns/:id/settings`) the same four steps, built from the same
components. Asked for by Manas on 2026-11-22, with mock-ups. The mock-ups show the experience to
aim for; the content, limits and wording follow what this repo supports.

## 1. Rulings

| ID | Ruling | Status |
|---|---|---|
| CS1 | **Four steps, one set of parts.** 1 *Name & number* ("Who customers see"), 2 *Customers* ("Upload the list"), 3 *Purpose & buttons* ("What agents can pick"), 4 *Agents & timing* ("Who calls, and when"). New campaign goes through them in order; any step already reached can be opened again. Settings shows the same four as tabs, with the same components in edit mode and the one save bar it already has. The Review step is gone: the footer's "Ready" line and the step cards' needs-fixing marks do its job | **Decided — changed** (Manas, 2026-11-22) |
| CS2 | **Purpose first, then buttons.** Step 3 opens with starting points: *Payment reminder* (the Collections set, AS4), *Sales / leads*, *Survey / feedback*, *Appointment* and *Start blank*. Picking one fills the buttons, and everything stays editable. The presets live in the console and send an ordinary catalogue. Picking a different starting point after editing asks first | **Default, pending Manas** |
| CS3 | **One sentence per button.** Each button reads as a sentence: "When the agent picks *No one spoke* → *try again after 4 hours, up to 2 times*. Then *stop calling*. Counts as success: *No*." Each choice in the sentence is a field the outcome entry already has (`retry`, `requires_datetime`, `requires_promise`, `terminal`, `suppress`, `is_success`, `requires_note`, `icon`). Settings the sentence does not cover (overrides, promise follow-up, the code) are under "More options" on the row. The server and wire are unchanged | **Default, pending Manas** |
| CS4 | **The agent's view beside the buttons.** Step 3 shows the buttons as the agent will see them, drawn by the station's own tile parts, so the preview cannot drift from the real screen. The order is the number key | **Default, pending Manas** |
| CS5 | **No language choices yet.** The mock-ups' screen language, agent languages and translated labels are left out. Languages are a later piece of work | **Decided** (Manas, 2026-11-22) |
| CS6 | **Bad rows are counted, never fixed in the app.** Step 2 shows chips: "1,240 customers ready", "12 rows have a bad phone number. They will be left out" (with the existing download), "8 on the Do Not Call list. They will be left out", and "N already in this campaign" when there are any. There is no in-app "See & fix" (it was already the rule that bad rows are fixed in the spreadsheet and uploaded again) | **Decided** (Manas, 2026-11-22) |
| CS7 | **CSV only for now.** Excel upload is a separate item (ClickUp "Campaign customer upload: accept Excel (.xlsx) as well as CSV") | **Decided** (Manas, 2026-11-22) |
| CS8 | **The phone column is found, not asked.** When the column analysis is sure which column holds the phone number, step 2 checks the file straight away and shows the chips. The column mapper opens only when it is not sure, or when the supervisor asks ("Change columns"). Continue imports the checked file ("Add 1,240 customers") and moves on. A file is never imported unchecked from this step | **Default, pending Manas** |
| CS9 | **The card is picked where the columns are.** Step 2's table of sample rows has a switch on each column: "Tick what agents should see on their screen." The switches follow the customer card's rules (AS19): the name, the line under it, and up to `AGENCY_FACT_FIELDS_MAX` (4) facts. When the limit is reached, the other switches are disabled and say why. Phone numbers in the preview stay partly hidden | **Default, pending Manas** |
| CS10 | **Agents are picked in the builder.** Step 4 lists the account's agents as cards with tick boxes. New campaign staffs them when it saves (the draft must exist first); Settings stages ticks and applies them with the save bar, using the assignment routes the campaign page already uses | **Default, pending Manas** |
| CS11 | **Hours as choices.** "When to call" offers *9 AM – 6 PM*, *9 AM – 8 PM* (today's default) and *9 AM – 9 PM*, plus *Custom* (start, end, time zone). The days are pills. Nothing about the server's defaults changes | **Default, pending Manas** |
| CS12 | **One "doesn't pick up" rule.** "Try again *3 times*, every *2 hours*. If the line is busy or switched off, the same rule applies" writes one rule to every customer-side unanswered result. Agent-side failures keep their own bound. When a campaign's results already differ, the sentence says so ("Different rules for busy and no answer") and links to Advanced, where the full table is | **Default, pending Manas** |
| CS13 | **Advanced, folded.** "Advanced settings (most campaigns don't need these)" holds what the four steps do not show by default: the full retry table, the abandonment limit, automatic outcomes for unanswered calls, redial from wrap-up, contact assignment, inbound callers to the same agent, break limits and the carrier account when there is a choice. Folded, with the same look; open when one of them needs fixing | **Decided** (Manas, 2026-11-22: "add it with similar theme") |
| CS14 | **Only what exists.** The mock-up's "Let AI pre-pick the outcome" is not a feature here and is not shown. Recording and the call summary are, with the same gates as today (`agency.recording`, `agency.analytics`), shown disabled with a reason when the account cannot use them | **Decided** (Manas, 2026-11-22) |
| CS15 | **Start from the builder.** The last step's footer reads "Ready: 1,240 customers · 6 agents · 9 AM – 6 PM · 6 days a week", with *Save as draft* and *Start campaign*. Start saves, staffs, then starts (`POST …/start`). If the start is refused, the draft stays saved and the refusal is shown in plain words, with a link to the campaign | **Default, pending Manas** |
| CS16 | **Settings anchors keep working.** The section ids in `utils/campaignSettingsSections.ts` are link targets and search targets. Each id still exists on the page, now inside the tab it belongs to; a link to `…/settings#<id>` opens that tab and scrolls to it | **Settled** (existing rule) |

## 2. Shared parts

Presentation pieces with no campaign knowledge live in `apps/console/src/components/campaign-setup/`
(step cards, choice cards, pill groups, sentence selects, switch rows, status chips, the Advanced
fold, the setup card). The four step components live in
`apps/console/src/pages/campaigns/agency/setup/` and are controlled: state in, changes out. New
campaign and Settings each own their state, saves and leave guard, and render the same steps.
Rules stay in the pure modules (`agencyCampaignConfigForm`, `agencyColumnMapping`,
`builderFlow`, and `outcomeRule` for CS3's sentence).

## 3. Build status

Built in phases on one branch: the shared parts, then the three step bodies in parallel, then New
campaign, then Settings.
