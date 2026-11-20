# Agent station redesign: hand-off spec

For the owner, then the backend engineer, then the people who build it.
Written 19 Nov 2026 against the code in this repo as it stands today.

**How to read the labels in this document**

- **Today** means I found it in the code and name where.
- **NEW** means nothing supplies it today. Someone has to build it.
- **Changed** means it exists but the redesign asks it to behave differently.

**Files**

| File | What it is |
|---|---|
| [`mockups/tokens.css`](mockups/tokens.css) | Shared CSS for every mock-up. Every selector is under `.ma-mock`. |
| [`mockups/preview.html`](mockups/preview.html) | Every screen, console (1280 px) and phone (390 × 844) side by side, with captions. Open it in a browser. |

The mock-ups are static. Nothing is clickable.

---

## 1. Design principles

1. **One state, one screen, one colour.** The band across the top tells the agent where they are: its colour, its icon and two or three big words. The same colour means the same thing on the computer and on the phone.
2. **One main action.** Each screen has one big button, always bottom-right on the computer and bottom, full width, on the phone. If there is nothing to press, there is no button, and a line says so ("The call connects by itself").
3. **Hide, do not grey out.** A button that cannot be used now is not on the screen. Today's station keeps every control in place and disables it; that is the main thing the daily users asked us to change. The one exception is Save on the What happened screen (see 6.1).
4. **Numbers and pictures first, words second.** Amounts, dates and timers are the biggest things on the screen. Every label has an icon. Sentences are short, in simple Indian English.
5. **Colour is never the only signal.** Every state also has its own icon and its own title. A break that runs over changes colour, icon and words together.
6. **The system does the routine work.** Calls connect by themselves, call-later calls come back by themselves, the internet is retried by itself, and (when built) AI picks the likely outcome. The agent confirms.
7. **Ask "are you sure?" only when it cannot be undone.** That is two places: Don't call again, and Finish work for today.
8. **Help is always one press away.** Need help sits top-right on every working screen.

### Theme

- The station uses **our theme tokens** (`packages/web-ui/src/global.css`), not the mock-ups' palette. Purple stays the brand accent. Plus Jakarta Sans is the display font, Inter the body font.
- **Light is the primary look for the station.** A call-centre floor is brightly lit and the bands need to be read from a distance. Today the console defaults to dark, so the station needs to set the light theme itself (**Changed**, client only).
- **Dark should also be supported.** It costs little: `tokens.css` has a `.ma-dark` block that only swaps surfaces and text, the bands keep their fills. `preview.html` ends with one dark sample (04 On call). The mobile app already has both themes (`apps/mobile/lib/app/theme/tokens.dart`).
- Two of our light semantic colours are too light to carry white text on a full-width band (success `#0f9b80` is about 3.4:1, info `#0b8fd4` about 3.6:1). The bands use the deeper values the mobile app already uses (`#077461`, `#BE3440`) or a deeper step of the same hue.
- Our ember orange is kept for what it means in the theme: things in motion (the waiting pulse, the recording dot, countdowns in the built product). It is **not** used for buttons here, because an orange button next to an amber break band would be read as "break".

### State colour tokens (new, in `tokens.css`)

Each state has four tokens: `--ma-st-<name>` (band), `-ink` (text on the band), `-soft` (pale tint for tiles), `-deep` (that colour as text on white).

| Token | Band | Used for | Icon |
|---|---|---|---|
| `--ma-st-start` | `#2d3047` ink | Start of day, Finish work | headphones, log-out |
| `--ma-st-ready` | `#077461` green | Ready | headphones |
| `--ma-st-coming` | `#0a6fae` blue | Call coming | phone with arrow |
| `--ma-st-oncall` | `#1d4fb8` deep blue | On call | phone |
| `--ma-st-happened` | `#6a4de4` brand purple | What happened? | tick in circle |
| `--ma-st-break` | `#f0b548` amber, dark text | On break, Take break button | cup |
| `--ma-st-over` | `#c2410c` red-orange | Break over time, timer ran out | warning triangle, clock |
| `--ma-st-problem` | `#be3440` red | Internet problem, call problem, mic blocked | wifi-off, mic-off |
| `--ma-st-quiet` | `#4a5165` slate | No calls right now, open on another device | pause, device |
| `--ma-go` / `--ma-stop` | green / red | "Go forward" buttons / "Stop" buttons | |

Blue is one family on purpose: light blue = a customer is coming, deep blue = a customer is on the line. Red-orange (over time) and red (problem) are close; they are separate tokens so they can be moved apart, and each has its own icon and title.

---

## 2. The state machine

The server already has six agent states: `offline`, `available`, `reserved`, `on_call`, `wrapup`, `break` (`AgencyAgentState`, `packages/contracts/src/agency/enums.ts`), plus the socket's connection state in the client (`useAgencyStation`: connecting, open, reconnecting, disconnected, superseded). The redesign adds **no new server state**. Every screen below is one of those, shown differently.

```
                      ┌──────────────── 11 Finish work ◄── ⋮ More, or break screen
                      │                      │ yes
   sign in ──► 01 START OF DAY ◄─────────────┘ (next day)
                 │  Start work                (01b if a check fails)
                 ▼
        ┌──► 02 READY ──── Take break ──► 06 Which break? ──► 07 ON BREAK ──► 08 BREAK OVER
        │      │  ▲                                              │  Start calls again  │
        │      │  └──────────────────────────────────────────────┴─────────────────────┘
        │      │ a call is found (system)          02c NO CALLS RIGHT NOW (calls stopped / nothing due)
        │      ▼
        │   03 CALL COMING ── not answered ──► back to 02 with a one-line banner
        │      │ customer answers (system)
        │      ▼
        │   04 ON CALL ── End call, or customer cuts ──► 05 WHAT HAPPENED?
        │                                                   │ Save & next call
        └───────────────────────────────────────────────────┘ (Save & take break ──► 07)

   From any screen:  internet lost ──► 09 INTERNET PROBLEM (10 CALL PROBLEM if on a call) ──► back where you were
                     opened elsewhere ──► 12 OPEN ON ANOTHER DEVICE
```

| # | Screen | Server state today | Enters when | Leaves when | Band (colour · icon · title · subtitle) | One main action | Keys |
|---|---|---|---|---|---|---|---|
| 01 | Start of day | `offline`, session joined | Agent opens the station | Start work (`POST /sessions/:id/available`) | ink · headphones · "Namaste, Sunita" · "Check these 3 things. Then start work." | **Start work** | Enter (**NEW**; today `A`) |
| 01b | Check failed | `offline` | A device check fails | The check passes | red · mic-off · "Microphone is blocked" · "The customer cannot hear you. Fix this first." | **Check again** (phone: **Open Settings**) | Enter |
| 02 | Ready | `available`, campaign dialling | Start work, Save & next call, Start calls again | A call is reserved; Take break | green · headphones · "Ready" · "Next call is coming. Stay on this screen." · waiting timer | **Take break** | B (today) |
| 02c | No calls right now | `available`, campaign not dialling or `queue.due = false` | `campaign_state` / `queue` frame | Calls start again | slate · pause · "No calls right now" · reason line (see 3) | **Take break** | B |
| 03 | Call coming | `reserved` | `reserved` frame | `bridged` (answered) or `released` (not answered) | blue · phone-in · "Call coming" · "Get ready. Say Namaste first." · Connecting ••• | none | none |
| 04 | On call | `on_call` | `bridged` frame | End call; customer cuts; line drops | deep blue · phone · "On call" · "Ramesh Goud · Siddipet" · call timer, "Call is recorded" | **End call** (Mute is secondary) | E, M (**Changed / NEW**) |
| 05 | What happened? | `wrapup`, outcome owed | `released` with `requires_disposition`, then `wrapup` frame | Save | purple · tick · "What happened?" · "Choose one. Then press Save." · Time left ring | **Save & next call** | 1–9 (today), Enter (**Changed**; today Ctrl+Enter, kept) |
| 06 | Which break? | (sheet over 02 or 05) | Take break / Save & take break | A tile, or Cancel | (the screen below, dimmed) | pick a tile | 1–5 (**NEW**), Esc |
| 07 | On break | `break` | Break starts | Start calls again | amber · cup · "On break · Tea" · "No calls will come now." · time used | **Start calls again** | A (today) |
| 08 | Break over | `break`, past `limit_minutes` | Time used passes the limit | Start calls again | red-orange · warning · "Break time is over" · "You are 2:05 late. Start calls now." · +late time | **Start calls again** | A |
| 09 | Internet problem | any idle state, socket not open | Socket closes, retry ladder running | Socket opens again | red · wifi-off · "Internet problem" · "Calls are stopped. We are trying again." · Trying again in 0:08 | **Try again now** | R (**NEW**) |
| 10 | Call problem | `on_call`, socket not open | Socket closes during a call | Socket opens; or the kept time ends → 05 | red · wifi-off · "Call problem" · "Stay here. We are joining the call again." · Call is kept for 0:12 | **Try again now** | R |
| 11 | Finish work | any state with no call | ⋮ More → Finish work; button on 07/08 | Yes → signed out of the station. No → back | ink · log-out · "Finish work for today?" · "No more calls will come to you." | **No, keep working** (safe choice is the big one) | Esc |
| 12 | Other device | socket closed `4409 superseded` | Station opened elsewhere | Use this computer / phone | slate · device · "Your work is open on another device" · "Only one device can take calls at a time." | **Use this computer** | Enter |

Keys that exist today and stay, but are no longer shown on screen: `N` (go to the note), `C` (pick Call later), `D` (Don't call again), `/` (filter fields; dropped with the field list, see 8).

---

## 3. Screen by screen

Copy is exact. Sample data in the mock-ups: agent Sunita Yadav, work "Sahyadri Finance · EMI collections", customer Ramesh Goud of Siddipet, ₹12,500 due on 20 Nov.

### Every screen: the top bar

- **Shown:** brand mark, agent name, work name (campaign). Right: **Need help**, **⋮ More**.
- **No language switcher.** Left out entirely, as asked.
- **Need help** (red outline, top-right). One press. It turns solid red and reads **"Help asked · 0:42"**; pressing it again cancels. When a supervisor answers, a green line says **"Help is here. Anitha N is listening to this call."** or the supervisor's message appears as a banner. If nobody answers in 15 minutes: **"No supervisor answered. Ask again if you still need help."** Not shown on 11 and 12.
- **⋮ More** (shown open in `02c`). Everything the mock-ups dropped but agents still need:
  - **My customers** (today's My contacts panel; only when the campaign assigns contacts)
  - **Dial a number myself** (soft phone; only when that feature is on)
  - **My calls today** (today's My calls page, opens in a new tab)
  - **Sound** (today's Sound & flash settings)
  - **Finish work for today** (red, last)
  - Items that cannot be used now are **hidden**. During a call and on What happened? the menu holds only Sound.
- **Banners** sit directly under the band, one line each, each with an icon. At most **one state banner plus one supervisor message** at a time.

### 01 Start of day (`01-start-of-day`)

- **Purpose:** know the equipment works and what today's work is, then start.
- **Shown:** three checks with green ticks (Headset, Microphone, Internet; phone adds Battery). Today's work. Target ("120 calls"). Call later ("3 today"). **How will you work?** with two picture tiles: **Calls come to me** / **I dial the number** (this is where "Switch to soft phone" moved; the second tile is hidden when the soft phone is off).
- **Footer line:** "Your supervisor may listen to calls for training." (today's listening notice, kept short).
- **Action:** **Start work**.
- **More than one campaign:** today's "Pick a campaign" list (`AgentHomePage`, `/dialer`) stays as the step before this screen, as big tiles. Not drawn; **as built** (console): the station's frame with an ink band **"Namaste, Sunita"** / "Choose your work for today." and one tile per list: its name, what it is doing ("Calling is on", "Paused by your supervisor", "Not started yet", "No calls right now"), **"Call later · 3 today · 1 late"** from the agent's own day when there are any, and **Open** (the whole tile is the link). A stopped or completed list keeps its tile with no way in and says why ("Ended by your supervisor. No more calls." / "Finished. Every customer was called."). One list that can be opened still goes straight to 01. Arriving after Finish work the band is **"Work finished for now"**; after a refused join, red **"Your work did not open"**; with no list, slate **"No work for you yet"** / "Ask your supervisor to add you to a list."; a failed read, red **"We could not load your work"** with **Try again** bottom right. The agent's screens (My performance, My calls, …) sit under the tiles.

### 01b A check failed (`01b-start-mic-blocked`)

- The failed check turns red with a cross and a word ("Blocked"). The band turns red.
- **What to do**, three steps. Computer: "Click the lock next to the web address." / "Turn on Microphone." / "Press Check again." Phone: "Press Open Settings below." / "Turn on Microphone." / "Come back to this app."
- **Start work is not on the screen** until the check passes. Action: **Check again** (phone: **Open Settings**).
- Other failures use the same screen: "No microphone found" → "Plug in your headset."; "Microphone is used by another app" → "Close the other app."; "No internet" → "Check the internet cable or Wi-Fi."; headset missing is amber, not red (a warning: "No headset. Calls will use the computer speaker.") and does not block Start work.
- **Mic lost during a call:** a red banner on 04, same words: **"Microphone is blocked. The customer cannot hear you."** with one button when the fix is one click (today's "Turn audio back on" → **"Turn sound on"**).

### 02 Ready (`02-ready`, `02b-ready-banners`)

- **Shown:** big pulse, **"Next call is coming…"**, "Waiting: 0:25". **My day:** Calls today 42 / 120 with a bar, Talk time 1h 52m, Will pay 12. **My call-later list:** time chip + name, and "These calls will come to you on time." (see the copy rule in 6.6).
- **Action:** **Take break**. Nothing else. No call buttons.
- **Banners (`02b`):**
  - Supervisor message: "Anitha N (supervisor) · 10:05 AM" / the message / **OK**. More than one: "2 more messages" after the text; OK shows the next.
  - **"The last call did not connect. You do not need to do anything."** Shows for 6 seconds or until the next call. This is how "did not connect / customer cut before you spoke" is handled: a banner, not a screen, because the agent has nothing to do.
  - A call-later due within 5 minutes is marked in the list: filled time chip and **"in 2 min"**.
  - After several unanswered dials (today's `dial_activity`): under the pulse, "No answer from the last 2 numbers." Plain text, no banner.

### 02c No calls right now (`02c-no-calls-now`)

- Slate band so it does not look like Ready. Body: **"Calls will start again"** / "You do not need to do anything."
- Subtitle by reason (all four reasons exist today):
  - calls stopped by supervisor: "Your supervisor has stopped calls. Stay on this screen."
  - nothing due: "No customers are waiting. Stay on this screen."
  - only call-later calls left: "Your next call is at 3:00 PM."
  - outside calling hours: "Calls start at 9:00 AM."
- **Action:** Take break.

### 03 Call coming (`03-call-coming`, `03b-call-later-arriving`)

- **Purpose:** two or three seconds to read who is coming.
- **Shown:** customer card: initials, name, city, phone; three big tiles **Amount due / Due date / Last call**; **"What they said last time"** with the last note in quotes. Right: **"First, say this"** with the opening line.
- **Footer:** "The call connects by itself." **No button.**
- **`03b` a call-later arriving:** same screen with a tag above the name: **"Call later · You said you will call at 3:00 PM"**. No separate alert; the list on Ready already said it was coming.
- **Inbound** (a customer rings in; behind today's inbound flag): same screen, title **"Customer is calling"**, subtitle "Get ready. Say Namaste first." Not drawn.

### 04 On call (`04-on-call`, `04b-on-call-alerts`, `04c-on-call-no-script`)

- **Shown, left:** the same customer card (it does not move between 03 and 04).
- **Shown, right:** **"What to say"**, numbered steps. Done steps are struck through with a tick; the current step is highlighted; click a step to move on. Under it: **"AI is listening"** / "Customer said: will pay on Friday."
- **Band:** call timer, and **"Call is recorded"** with a red dot when the campaign records.
- **Actions:** **Mute** (left, secondary; turns amber and reads **Unmute** when on) and **End call** (right, red, **one press**). Phone adds **Speaker** (pick phone / headset / Bluetooth; exists today as "Audio").
- **`04b` things that can happen during a call:**
  - On mute: amber banner **"You are on mute. The customer cannot hear you."**
  - Help asked / answered (see top bar).
  - A break booked for after the call: chip **"Tea break after this call ✕"** (✕ cancels). Booking it: ⋮ is not needed; the agent presses `B` or uses **Save & take break** on the next screen. See open question 7.
- **`04c` no script, no AI (what we can ship first):** the right side shows **Last calls** (date chip, outcome, note) and a **Note** box. This uses only today's data.
- **Customer cuts the call:** the screen moves to 05 by itself.

### 05 What happened? (`05-what-happened`, `05b-call-later`, `05c-dont-call-again`, `05d-time-over`)

- **Purpose:** record the result in one or two presses.
- **Band:** "What happened?" / "Choose one. Then press Save." (with AI: "AI has chosen one. Check it, then press Save.") / **Time left 0:22** ring.
- **Tiles:** one picture tile per outcome of **this campaign's own list** (see 5.3). Each has its number key, an icon, a short label and a speaker icon that reads the label aloud. The picked tile gets a green border and tick. With AI: the tile it picked carries **"AI chose"**.
- **Follow-up, only when the picked outcome needs it:**
  - **Will pay** → **Pay date:** Today · Tomorrow · Fri 20 Nov (AI) · Other date. **Amount:** ₹12,500 · Full · Half · ₹6,250. Date is needed, amount is not.
  - **Call later** (`05b`) → **Call when?** In 1 hour · Today 6:00 PM · Tomorrow 10:00 AM · Tomorrow 6:00 PM · Other time. Under it: "This call will come to you on Fri 20 Nov at 10:00 AM."
  - An outcome that needs a note → the Note box gets a red border and "Write a note for this one."
- **Note:** typed, or **Speak a note**. With AI: pre-written, tagged "AI wrote this", and editable.
- **Don't call again** (`05c`): the only outcome that asks. **"Stop calling this customer?"** / "Ramesh Goud · 98••• ••321" / "We will not call this number again for this work. You cannot change this later." / **No, go back** · **Yes, stop calls**.
- **Actions:** **Save & next call** (main). **Save & take break** (opens Which break?). **Call again · 2 left** (only when the campaign allows a redial; hidden otherwise).
- **`05d` the timer runs out with nothing picked:** nothing is picked for the agent. The ring turns red and reads "Time is over 0:00", a banner says **"Time is over. Choose one now. Your supervisor can see that you are still on this screen."** The agent stays here until they save. If they had already picked and the timer ends, it saves and goes to Ready (today's behaviour).
- **After a line drop:** a banner **"The call was cut. Choose what happened, or call again."**

### 06 Which break? (`06-which-break`)

- Picture tiles: **Tea 15 min · Lunch 30 min · Washroom 5 min · Meeting 20 min · Training 30 min** (the campaign's own list). One tap starts the break. **Cancel** is a plain word.
- A reason with no limit shows no time under it.

### 07 On break (`07-on-break`) and 08 Break over (`08-break-over`)

- **07:** amber band **"On break · Tea"** / "No calls will come now." Big **4:18 / 15:00**, a bar, "10:42 left of your 15 minutes."
- **08:** the same screen turns red-orange. Band: **"Break time is over"** / "You are 2:05 late. Start calls now." Big **17:05 / 15:00** in red-orange, the bar full, and "Your break was 15 minutes. Your supervisor can see this."
- **Action on both:** **Start calls again**. Quiet link: **Finish work for today**.
- A break with no limit shows only the time used, never turns red; after 30 minutes (today's long-break rule) it shows "You have been on break for 30 minutes."
- Phone only: when the agent leaves the app the server pauses them (today's `device_away`). Same amber screen, title **"Paused"**, subtitle "You left the app. No calls came.", action **Start calls again**. Not drawn.

### 09 Internet problem (`09-internet-problem`) and 10 Call problem (`10-call-problem`)

- **09:** red band, "Trying again in 0:08". **What to do:** 1 "Check the internet cable or Wi-Fi." 2 "Wait. Calls start again by themselves." 3 "Still not working? Call your supervisor to your desk." Action: **Try again now**.
  - Step 3 does not say "Press Need help" as the owner's mock-up does: with no internet the press cannot reach the server. See 5.9 and open question 5.
- **10 (during a call):** the customer card stays. Band: "Call problem" / "Stay here. We are joining the call again." / **"Call is kept for 0:12"**. Steps: 1 "Do not close this page." 2 "If the call comes back, say sorry and go on." 3 "If it does not, you can call again." Action: **Try again now**. When the kept time ends the screen moves to 05 with the "call was cut" banner.

### 11 Finish work for today (`11-end-of-day`)

- **Shown:** the day in three numbers (Calls today 118 / 120, Talk time 4h 32m, Will pay 31) and one line about what is left: "1 call later is left for today (6:00 PM). Another agent will make it."
- **Actions:** **No, keep working** (big, green) · **Yes, finish work** (red outline). Yes ends the station (`POST /sessions/:id/leave`) and returns to sign-in / the campaign list.
- Not offered during a call or on What happened? (hidden from ⋮ More).

### 12 Open on another device (`12-other-device`)

- "Your work is open on another device" / "Only one device can take calls at a time." / **"You opened it on your phone"** / "No calls will come to this computer now." Action: **Use this computer** (phone: **Use this phone**).
- The other "station did not open" cases today (still on another campaign, soft phone open elsewhere, generic error) use this same layout with their own title and one button. Not drawn.

---

## 4. Console and mobile: the differences

**How the phone takes calls (today, unchanged).** The app is the phone: call audio runs inside the app over the station socket (`apps/mobile/packages/agent_audio`), not as a normal phone call. Waiting for a call needs the app on screen; if the agent leaves the app while Ready the server pauses them at once (`device_away`), and returns them without a tap if they are back within 30 seconds. A normal SIM call while Ready pauses them too (`phone_call`). The screen is kept awake while on duty. Agents who opted in can have the phone ring for an inbound caller while away (Mode B). The redesign changes none of this; it only renames what the agent sees ("Paused. You left the app.").

| Topic | Console (1280 px) | Phone (390 × 844) |
|---|---|---|
| Layout | Two columns: who / what on the left, guidance on the right | One column. Order: customer, then what to say |
| Main action | Bottom-right, 68 px tall, with its key shown | Bottom, full width, 64 px tall, in thumb reach. No key hints |
| Secondary actions | Bottom-left | A row of two 52 px buttons next to the main one |
| Need help / ⋮ | Top-right | Top-right, 48 px. Reaching up is acceptable for rare actions; nothing used on every call is at the top |
| Start of day checks | Headset, Microphone, Internet | Microphone, Headset, Internet, Battery (all exist today, plus sound check and battery saver, which appear only when they fail) |
| On call buttons | Mute, End call | Mute, **Speaker**, End call |
| Script | All steps, done ones struck through | Current step + next two; "1 of 4 done" chip |
| "What they said last time" | On 03 and 04 | On 03 only (04 keeps the three number tiles) |
| My day | Rows with a progress bar | Three number tiles |
| Outcome tiles | 3 across, key numbers shown | 2 across, no key numbers |
| Follow-up (pay date, call when) | Inline under the tiles | A bottom sheet with large chips and **OK**; afterwards one summary row "Will pay on Fri 20 Nov · ₹12,500 · Change" |
| Note | Card with **Speak a note** button | One row: note + mic button |
| Dialogs | Centred | Bottom sheet |
| Banners | One line | Up to two lines |
| Leaving the app | Not relevant | Server pauses the agent; shown as amber "Paused" |
| Inbound call, soft phone, join refusals | The station's frame and band ("Customer is calling", On call, What happened?, "Dial a number", "Calling …") and the bodies of 03–05: the same customer card, Last calls, the note, the outcome tiles and one main button bottom right (none while a caller is offered, End call held, Save; Back to my calls while the soft phone is idle, Finish work in ⋮ More). An inbound call adds About this call (the number they called, the line, the wait, their work, their own agent, asked not to be called). The soft phone's Dial a number is a big number box and keypad with Call under it, faded with its reason until it can dial (like Save, spec §6.1), then where the call is saved, the number it goes from, the call details and My recent calls; while ringing, Mute is "Mute ring" and a warning says a stopped call may keep ringing. The soft phone shows the number whole (the agent typed it); an inbound caller's follows `phone_display` | As built in the app |
| Words for refusals and notices | The station's own, keyed on the server's code (AS15); never the server's sentence | The same |

Console scale-down: under about 1060 px the two columns stack; under about 720 px tiles go 2 across and the main button goes full width. No horizontal scroll at 900 or 640 px.

---

## 5. Data each screen needs

Paths are relative to the repo root. "Bootstrap" is `AgencySessionBootstrap` (`packages/contracts/src/agency/session.ts`), the answer to joining a session. "Frame" is a station socket frame (`packages/contracts/src/agency/station.ts`).

### 5.1 Start of day

| Field | Where it comes from today | Status |
|---|---|---|
| Agent name | Auth user (`useAuth`) | Today |
| Today's work (campaign name) | Bootstrap `campaign_name`; list from `getMyAssignments` (`AgentHomePage.tsx`) | Today |
| Microphone check (console) | `useAgencyAudio.preflight()` runs on "Go available" and reports typed failures (`utils/agencyAudioCopy.ts`: blocked, not found, in use, disconnected, insecure page, autoplay blocked) | Today, but **Changed**: run it when the screen opens, not on the button |
| Headset check (console) | Nothing. The browser can list audio devices (`enumerateDevices`) after mic permission; a "headset" is a guess from the device label | **NEW** (client only) |
| Internet check (console) | Nothing as a check. The station socket's ping/pong (`useAgencyStation`, `missedPings`, `ConnectionHealthPill`) gives a live signal once connected | **NEW** as a pre-check (client only; could reuse the socket's first pong) |
| Microphone, sound check, headset, network speed, battery, battery saver (phone) | `apps/mobile/lib/features/preflight/` (`preflight_checks.dart`, `device_preflight_checks.dart`, copy in `preflight_copy.dart`) | Today |
| Daily target ("120 calls") | Nothing. No target field on a campaign, agent or assignment (searched for `daily_target`, `target_calls` and similar: no hits) | **NEW** (server: where it is set, per campaign or per agent; plus the read) |
| "Call later: 3 today" | See 5.2 | **NEW** |
| "I dial the number" offered | Feature flag `agency_softphone_enabled`; `useStationSoftphone().available` | Today |
| "Your supervisor may listen" line | `LIVE_LISTEN_FLAG` + `LISTEN_AGENT_NOTICE` | Today |

### 5.2 Ready

| Field | Where it comes from today | Status |
|---|---|---|
| Waiting timer | `agent_state` frame `since` | Today |
| "No answer from the last 2 numbers" | `dial_activity` frame `unanswered_in_a_row` (late binding only) | Today |
| No calls right now + reason + next time | `campaign_state` frame (`dialing`, `reason`), `queue` frame (`due`, `reason`: `queue_empty`, `waiting_for_retry`, `callbacks_later`, `outside_calling_hours`; `next_due_at`) | Today |
| Calls today | `GET` my stats (`getMyStats`, `apps/console/src/api/agencyStats.ts`; `AgencyAgentStats` totals `attempts` / `connected`) | Today as a page read (My performance). **Changed**: the station must read it and keep it fresh; decide whether "calls" means dialled or connected |
| Talk time | Same read, `talk_seconds` | Today (same note) |
| "Will pay" count | Nearest today: `successes` (connected calls whose outcome is marked `is_success`). There is a promises summary (`GET` promises summary, `usePromisesToday`) but it is gated to supervisors (`agency.supervise`) and is per campaign, not per agent | **NEW**: an agent's own count of today's promise outcomes (or decide that "Will pay" = `successes`) |
| Target for the bar | See 5.1 | **NEW** |
| My call-later list (time, customer name) | Not available to an agent. `GET /proxy/agency/callbacks` lists callbacks with `customer_name`, `due_at`, `owner`, but is gated to `agency.supervise` and covers the whole account. `GET /proxy/agency/my-contacts` (contact-assignment flag only) lists the agent's own contacts with `next_attempt_at` and hero fields, not a callback list | **NEW**: "my callbacks today" for the agent (name, due time), for every assignment mode |
| "These calls will come to you" being true | Only on campaigns that assign contacts (`assignment_mode` not `pool`; callback ownership, CA rules). On a `pool` campaign today's copy is "The callback goes back into the campaign queue. It may not be you who makes it." | Today as a rule. The line must follow it (6.6). Making it always true is **NEW** product behaviour |
| "The last call did not connect" banner | `released` frame with `requires_disposition: false` and a `reason` (`no_answer`, `busy`, `failed`, `invalid`, …); also `missed_release` on reconnect | Today |
| Supervisor message | `supervisor_message` frame (`id`, `text`, `from_name`, `sent_at`); `SupervisorMessages.tsx`, mobile `supervisor_message_banner.dart`. Flag `agency_floor_assist_enabled` | Today |

### 5.3 Call coming and On call

| Field | Where it comes from today | Status |
|---|---|---|
| Customer name, city | `reserved` frame `attempt.context` (a free map of the uploaded roster's columns). Which columns are shown big is the campaign's `context_display.hero` (bootstrap) | Today, but **untyped**: the client is not told which column is "the name" or "the city". **NEW**: a per-campaign mapping of roles (name, place) to columns |
| Phone number | `attempt.phone_e164` (sent in full) | Today. Masking ("98••• ••321") is a **NEW** display rule; see open question 6 |
| Amount due, Due date | Roster columns in `attempt.context`, if the campaign uploaded them and listed them in `context_display.hero`. They are **not** typed fields: values arrive as uploaded text | Today as text. **NEW**: column type hints (money, date) so we can show ₹12,500 and 20 Nov reliably; and a rule for campaigns with other hero fields (the three tiles are simply the first three hero fields) |
| Last call date | `attempt.prior_attempts[]` (`ended_at`, `dialed_at`, `outcome`, `disposition_code`, `campaign_name`) | Today |
| "What they said last time" | `prior_attempts[].notes` of the latest attempt that has a note; plus `promise_date` / `promise_amount`, and `attempt.promise` (`AgencyContactPromise`: date, amount, state) | Today |
| "Call later · You said you will call at 3:00 PM" tag | Nothing on the frame says "this reservation is a booked callback" or when it was booked for | **NEW**: a field on `AgencyReservedAttempt` (for example `callback: { due_at, booked_by_me }`) |
| Call timer | `bridged` frame `bridged_at` + server clock (`useServerClock`) | Today |
| "Call is recorded" | Bootstrap `record_calls` | Today |
| "First, say this" and the script steps | Nothing. There is no script, talking-points or opening-line field on a campaign (searched contracts, server and console) | **NEW**: per-campaign script (ordered short lines, with placeholders for name / amount / date), stored and sent on the bootstrap. The current-step position is client state |
| "AI is listening" live line | Nothing live. AI today is post-call only (`apps/server/src/analysis`, flag `agency_call_analysis`): it transcribes the recording after the call and writes sentiment, topics and a summary | **NEW** and the largest item: live transcription of the call audio and a short running line pushed to the station |
| Mute | `audio.toggleMute` (`useAgencyAudio`); phone `StationCopy.mute` | Today. Key `M` is **NEW** (client only) |
| End call | `hangup` client frame / `useHangup`. Today: press-and-hold, or `E` twice (`HoldToConfirmButton`); phone: hold, with a confirm | **Changed** to one press (client only) |
| Speaker (phone) | Audio routes sheet (`StationCopy.audio`) | Today |
| Break booked for after the call | `agent_state` frame `pending_state` / `pending_break_reason`; cancel `POST …/break/cancel` | Today |
| Need help raise / cancel / answered | `POST` / `DELETE /proxy/agency/sessions/:id/help`; frames `help_answered`, `help_cleared`; `useStationHelp.ts`, mobile `need_help.dart` | Today **only on a call or in What happened?** (`409 help_not_on_call` elsewhere), behind `agency_floor_assist_enabled`. See 5.9 |
| Help reaches the supervisor's live floor | `GET /proxy/agency/floor` (`AgencyFloorAgent.help`), polled by the console every 5 s | Today (polled, no push) |

### 5.4 What happened?

| Field | Where it comes from today | Status |
|---|---|---|
| The outcome tiles | Bootstrap `disposition_catalog`: `AgencyDisposition[]`, **set per campaign by the supervisor**, not fixed. Each has `code`, `label`, and flags `requires_note`, `requires_datetime`, `requires_promise`, `promise_follow_up_days`, `suppress`, `terminal`, `is_success`, `retry`. The built-in default list is only three: Voicemail, Callback, Do not call (`campaign-defaults.ts`) | Today. **The six tiles in the mock-up are a sample**, not what every campaign has. Rules in 6.2 |
| Tile icon | Nothing. Can be worked out from flags: `requires_promise` → ₹, `requires_datetime` → clock, `suppress` → stop sign, `is_success` → thumbs-up, otherwise a neutral dot | **NEW** (optional): an `icon` on each outcome so supervisors can choose; until then the flag rule above |
| Short labels ("Will pay", "No one spoke") | `label` is whatever the supervisor typed | Today. Needs a guideline in campaign settings (two or three everyday words) |
| Number keys 1–9 | `dispositionForNumberKey` (`useStationShortcuts.ts`) | Today |
| Pay date + amount | Request fields `promise_date` (needed when `requires_promise`; today's chips: Today, Tomorrow, In a week, Pick; at most 30 days ahead) and `promise_amount` (optional, decimal string) on `AgencyDispositionRequest` | Today. "Full / Half" chips are **NEW** and need the typed amount-due from 5.3 |
| Call when? | Request field `callback_at` (needed when `requires_datetime`; today's chips: In 1 hour, Tomorrow 10 am, Tomorrow 3 pm (phone: 6 pm), Pick…) | Today; chip set **Changed** (client only) |
| "This call will come to you…" | Assignment mode, as in 5.2 | Today as a rule |
| Note | `PUT` notes with autosave (`useCallNotesAutosave`, `AgencyNotesRequest`); `notes` on the save request | Today |
| Don't call again confirm | An outcome with `suppress: true` (phone already confirms: `suppressConfirmTitle`). Also the separate DNC action `POST …/dnc` with `scope: campaign \| tenant` (`useDncAction.ts`, permission `agency.dnc.write`; tenant-wide needs `agency.dnc.manage`) | Today. Agents only ever get campaign scope here; the tenant-wide option stays with admins, off this screen |
| Time left ring | `wrapup` frame: `ends_at`, `seconds_total` (from bootstrap `wrapup_seconds`), `auto_return`, `requires_disposition`, `disposition_submitted`, `held_reason` | Today |
| Timer ran out | `wrapup.held_reason = 'disposition_required'` (today's copy "Waiting on a disposition"); `'supervisor_hold'` also exists ("Held by your supervisor") | Today |
| Save & next call | `POST` disposition (`useDispositionSubmit`), answer carries the next `agent_state` | Today |
| Save & take break | Today two steps: queue a break (`POST …/break`, applied after wrap-up), then save | Today as two calls; one button is client only |
| Call again · 2 left | Bootstrap `allow_wrapup_redial`; `wrapup.redial_remaining`; `POST /sessions/:id/redial` (limit 2) | Today |
| AI pre-picked outcome, pay date and amount | Nothing. Post-call analysis does not return an outcome code and runs after the save | **NEW**: at call end, a suggestion `{ disposition_code, promise_date?, promise_amount?, callback_at?, note }` restricted to this campaign's codes, delivered within about 2 seconds of hang-up (for example on the `wrapup` frame) |
| AI-written note | Nothing live (the post-call `summary` arrives too late and is a 2–3 sentence analysis, not a note) | **NEW** (same suggestion) |
| Read a tile aloud (speaker icon) | Nothing for agents. `apps/server/src/tts/` only caches clips for what callers hear | **NEW**: either the browser's / phone's own speech (no server work, voice quality varies by device and language) or server-made clips per label |
| Speak a note | Nothing. Server transcribers exist for recordings (`apps/server/src/transcription`: Gemini, Sarvam), not for a live mic clip | **NEW**: record a short clip → text → into the note (or the device's own speech-to-text) |

### 5.5 Breaks

| Field | Where it comes from today | Status |
|---|---|---|
| Break reasons and their minutes | Bootstrap `break_reasons`: `AgencyBreakReason { code, label, is_paid, limit_minutes }`, per campaign; limits 1–240 min; a reason with no limit falls under the floor's 30-minute long-break rule | Today |
| Break tile icon | Nothing | **NEW** (optional `icon`), or guess from the code / label (tea, lunch, …) with a cup as the fallback |
| Start a break / start calls again | `POST /sessions/:id/break { reason }`, `POST /sessions/:id/available`; key `A` | Today |
| Break timer | `agent_state` frame `since` + server clock | Today |
| Allowed minutes, over time | `limit_minutes` for the reason. Console: `cons.breakLimitMinutes` → `StateRail`. Phone: "4:30 left of your 15 min" / "Over your 15 min break by 2:05" (`station_copy.dart`). Supervisor's floor already gets `break_limit_minutes` | Today (the red treatment is new styling only) |
| "Paused. You left the app." (phone) | Reserved break `device_away` / `phone_call` / `away_ring` (`breaks.ts`) | Today |

### 5.6 Problems

| Field | Where it comes from today | Status |
|---|---|---|
| Internet lost, auto-retry | `useAgencyStation`: connection `reconnecting` / `disconnected`, a backoff ladder (`backoffFor`), token re-mint, `reconnect()` for the button | Today |
| "Trying again in 0:08" countdown | The delay is known inside the hook when the retry is scheduled; it is not exposed | **NEW** (client only: expose the next-retry time) |
| "Call is kept for 0:12" | Bootstrap `intervals.deferred_hangup_ms` (today's copy: "Your call is held for up to N seconds") | Today |
| Call dropped → What happened? | `released` with reason `agent_disconnected` / `remote_hangup` etc., then `wrapup` | Today |
| Open on another device | Socket close `4409 SUPERSEDED`; `join.useThisWindow` / mobile "Use this phone instead" | Today |
| Need help while offline | Cannot be sent. The floor read does carry `connected` for each agent, so a supervisor can see a dropped agent | Today for `connected`; an **alert** for it on the floor is **NEW** |

### 5.7 Finish work

| Field | Where it comes from today | Status |
|---|---|---|
| Leave | `POST /sessions/:id/leave` (`useStationExit.ts`), refused during a call | Today |
| Day totals | As 5.2 | Today / **NEW** as there |
| "1 call later is left for today" | As 5.2 (my callbacks) | **NEW** |

### 5.8 What needs no backend work

Light theme on the station, the bands, hiding instead of disabling, one-press End call, Enter to save, `M` and `R` keys, the retry countdown, the new chip sets, Save & take break as one button, running the mic check on screen open, moving the soft-phone switch to the start screen, the ⋮ More menu. All client only.

### 5.9 Need help everywhere (the owner's "always top-right")

Today a raise is accepted only on a call or while finishing one, expires after 15 minutes, and clears when a supervisor listens or sends a message. To make it work on every screen:

- **NEW (server):** accept a raise in `available`, `break` and `offline`-but-joined; decide what "answered" means when there is no call to listen to (a message only).
- **NEW (floor):** today the supervisor's console finds help requests by polling every 5 s and shows them on the agent's row. "Raises an alert" (a sound, a banner on the live floor) is new on the supervisor side (`useHelpChime.ts` exists; check what it covers before sizing).
- **Cannot work:** with no internet. Screen 09 says to call the supervisor to the desk; the proposal is that the floor alerts on an agent who dropped while Ready (5.6).

---

## 6. Behaviour rules

### 6.1 Hidden or greyed out

- **Hidden:** any action that does not belong to the current state. No call buttons on Ready, no break button on a call, no Finish work during a call.
- **Greyed out, one case only:** **Save & next call** on What happened? before a tile is picked (and before a needed pay date / call time / note is given). It stays in place, faded, so the agent can see where they are going; pressing it shakes the tiles and says "Choose one first." Today's reasons (`DISPOSITION_BLOCK_COPY`) map to: "Choose one first." / "Write a note for this one." / "Choose when to call." / "That time is over. Choose a new time." / "Choose the pay date."
- **Today's "geometry is frozen" rule** (`AgentConsolePage.tsx`: every region renders in every state so nothing moves under the cursor) is replaced by a narrower one: **the main button is always in the same corner, End call is never where another button was a moment ago, and nothing moves while a state is on screen.** Screens change only on a state change. See open question 3.

### 6.2 Outcome tiles and the real campaign list

- Tiles are the campaign's `disposition_catalog` in its order. Keys 1–9 as today.
- 1–6 outcomes: big tiles, 3 across (phone 2). 7–9: smaller tiles, 3 across. 10 or more: the first 8 and a **More** tile that opens the rest. We recommend supervisors keep it to six.
- If the list has no `suppress` outcome, a separate red row **"Don't call again"** appears under the tiles (today's Mark DNC action), with the same confirm.
- **Don't call again asked during the call:** key `D` still works on 04 and opens the same confirm; the tile is then already picked on 05.
- Outcomes filed automatically for unanswered calls (campaign's automatic outcomes) never reach this screen.

### 6.3 Confirmations

Only two: **Don't call again** and **Finish work for today**. End call is one press (open question 2). Starting a break, saving, cancelling help: no confirm.

### 6.4 Timers

| Timer | When it runs out |
|---|---|
| Waiting (Ready) | Counts up. Nothing happens. |
| Call coming | No visible timer. If not answered → Ready with the "did not connect" banner. |
| What happened? time left | Outcome picked → saves and moves on. Nothing picked → stays, turns red, banner (`05d`). Never auto-picks. |
| Break | Counts up against the limit. At the limit: screen 08. No auto-return. |
| Internet retry | Retries, then counts down to the next try. |
| Call kept (line drop) | At 0:00 the call ends → What happened? with "The call was cut." |
| Help asked | After 15 minutes: "No supervisor answered. Ask again if you still need help." |
| "Last call did not connect" banner | Goes after 6 seconds or on the next call. |

### 6.5 Sound and focus

- Today's three sound cues (ring, connect, hang-up) and the flash for agents who cannot hear them (`useAgencyCues`, Sound settings) stay. The full-band colour change is now the visual cue for everyone.
- Focus moves once per call, to the screen root when a call is coming, never at connect (today's rule, kept: do not interrupt a screen reader mid-sentence).
- A supervisor's message is read once by screen readers, politely, never over the call's own announcements (today's rule, kept).

### 6.6 Copy rules

- Simple Indian English. Short sentences. Everyday words.
- **Never on an agent screen:** disposition, wrap-up, pacing, session, station, SIP, WebRTC, DNC, callback, campaign, reserved, available, offline, reconnecting. Use: what happened, call later, don't call again, today's work, ready, internet problem.
- Money: ₹ with Indian grouping (₹12,500; ₹1,25,000). No decimals unless not zero.
- Dates: "20 Nov", with the day when it helps ("Fri 20 Nov"). Times: "3:00 PM". Durations: "0:25", "1h 52m".
- British / Indian spelling: cancelled, colour, dialled.
- The call-later promise must be true. Campaign assigns contacts: "These calls will come to you on time." / "This call will come to you on Fri 20 Nov at 10:00 AM." Pool campaign: "We will call them on time. Another agent may get the call."
- The server sends English sentences in some frames (`released.message`, `campaign_state.message`, refusal messages). The station should show its own copy keyed on the code, not the server's sentence.

### 6.7 Accessibility

- **Contrast:** measured (WCAG formula, from the hex values in `tokens.css`): white on ink 12.9, green 5.7, blue 5.4, deep blue 7.3, purple 5.5, red-orange 5.2, red 5.6, slate 7.9; dark ink on amber 8.8. Coloured text on its pale tint is 6.2 or more. Muted grey text is 4.9 on white and 4.6 on the page background. All pass AA (4.5:1). Measure again on the built screens.
- **Targets:** every button is at least 48 px high and wide; main buttons are 64–68 px. Tiles are 78 px or more on the phone, 150 px on the computer.
- **Never colour alone:** each state has an icon and a title; a picked tile has a tick as well as a border; a failed check has a cross and a word; over-time has a warning icon and a sentence.
- **Keyboard:** everything on the computer works without a mouse. Keys are shown on the buttons they belong to, nowhere else.
- **Motion:** the pulse and the connecting dots are the only movement. With reduced motion they stop and stay visible (the ring stays drawn).
- **Text size:** sentences and labels are 14 px or more on the computer (most are 17–36 px) and 12 px or more on the phone. Only key hints and the small "AI" tags are 12–13 px on the computer.

---

## 7. Open questions for the owner

1. **AI before or after?** The script, the live "AI is listening" line and the AI-picked outcome are all new back-end work, and the live line is the biggest piece. `04c` and a What happened? with nothing pre-picked work with today's data. Do we ship that first and add AI after?
2. **End call in one press.** Today it is press-and-hold (or `E` twice) on purpose, because a mis-click cuts off a customer. One press is what agents asked for. Is one press right on the phone as well, where a thumb slip is likelier? An option: one press on the computer, a short hold (half a second) on the phone.
3. **Hiding instead of disabling** replaces a rule the current station was built around (nothing ever moves). We kept the main button in one corner. Are you comfortable with this change?
4. **The six tiles.** Outcomes are set per campaign and can be any number. Do you want to (a) keep them free and recommend six, as designed, or (b) give collections campaigns a fixed set of six that supervisors cannot change?
5. **Need help with no internet.** It cannot be sent. Is "call your supervisor to your desk" plus an automatic alert on the supervisor's floor when a Ready agent drops the right answer?
6. **Hide part of the phone number?** The mock-up shows "98••• ••321". Today agents see the full number. Do agents ever need the full number (to read it back, or to dial by hand)?
7. **Booking a break during a call.** Today the agent can book a break mid-call. In the design it is only on the next screen (Save & take break), with `B` still working during the call. Is that enough, or do agents need a visible button during the call?
8. **Stopping a call while it is still ringing.** Today the agent can. The design has no button on Call coming. Keep it off?
9. **Daily target.** Who sets it: one number per campaign, or per agent? Is it calls dialled, calls connected, or "will pay"?
10. **What counts as "Will pay" in My day?** Outcomes that ask for a pay date, or every outcome marked as a success?
11. **Call-later on pool campaigns.** Should a call-later always come back to the agent who booked it? Today it does only when the campaign assigns contacts.
12. **Over-time breaks.** The screen says "Your supervisor can see this." Should anything else happen (a message to the supervisor, a count in reports)?
13. **Read aloud and Speak a note, in which languages?** English only is cheap. Hindi or Telugu speech needs a decision on the voice service. (This is separate from the language switcher, which is left out.)
14. **Light theme by default on the station**, with dark still available under ⋮ More → Sound… or a new "Screen" item?

---

## 8. What we deliberately dropped from today's screen

| Dropped | Why | Where it went |
|---|---|---|
| The three always-present columns, with disabled controls and a reason under each | The main cause of "what do I press now?" | One screen per state |
| The keyboard-shortcut guide in the middle of the idle screen (`IdleGuide`) | A lesson, not something to act on | Keys are printed on their buttons. Old keys still work |
| The thin state rail with small text | Too small to read at a glance or from across the floor | The full-width band |
| "Go available" / "End break" / "Offline" wording | Jargon | "Start work", "Start calls again" |
| Press-and-hold to hang up | Agents asked for one press | One press (open question 2) |
| The full contact field list with its filter (`ContactDetail`, key `/`) | Agents use three or four facts | The campaign's hero fields as big tiles. The rest is not shown on the station |
| The list of every past attempt on every call | Only the last one is used | "Last call" + "What they said last time". The list remains in `04c` and in My calls today |
| "Attempt 3", caller ID, "Calling from" | Not needed to do the call | Not shown |
| Retry banner ("Retry 1 of 'Q3 Winback' — these contacts were previously…") | Supervisor language | Not shown. "Last call" tells the agent they have been called before |
| "auto-selected", "Success", "Stops calling" badges on outcomes | Jargon | The icon carries it (₹, stop sign) |
| Separate Mark DNC button in the action bar, and the tenant-wide option | One way to do it; tenant-wide is an admin job | The "Don't call again" tile and its confirm; `D` still works |
| "Switch to soft phone" in the action bar | A different way of working, chosen once | Start of day ("I dial the number") and ⋮ More |
| Break menu with a second "End break" in the rail | Two controls for one thing | One Take break, one Start calls again |
| Leave station **and** Exit station | Two near-identical words; one of them left the agent taking calls with no screen | One "Finish work for today" |
| Sound & flash button in the header | Rarely used | ⋮ More → Sound |
| My performance link | A separate page | My day on Ready; the full page is still reachable from the campaign list |
| The timezone caveat under the call-later picker | A paragraph nobody reads | Dropped. Times are the agent's own clock; the agent says the time aloud to agree it |
| "Saving a promise doesn't book a call" and similar system explanations | True, but not something the agent acts on | Dropped from the screen. If the campaign books a follow-up, the line is "We will call again on 22 Nov." |
| The language switcher from the owner's mock-ups | Owner's rule | Left out entirely |

**Not redesigned here (out of scope, still needed):** Missed calls, My customers (My contacts) panel, sign-in and invites, the soft phone's own page (`/dialer/phone`, outside the station), and the supervisor's side of Need help and messages. They should take the same band, tiles and buttons when they are next touched. The soft phone and an inbound call inside the station have taken them (§4).
