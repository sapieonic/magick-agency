import '../station/server_clock.dart' show formatDuration;
import 'call_labels.dart' show formatDialNumber;

/// The sentences the soft-phone core decides, in the console's words where the
/// console has them (`useSoftphone`, `SoftphonePage`, the soft-phone
/// components), with the app's substitutions: no keyboard hints, the phone
/// instead of the browser or the page. The view's own derivations
/// (`softphoneSaveBlockCopy`, the finish notices) live beside them in
/// `softphone_view.dart`.

// ── Announcements ──

/// Answered with the microphone muted: the one thing the agent must know
/// before they speak (the console's `SOFTPHONE_MUTED_AT_ANSWER_COPY` without
/// its keyboard hint).
const softphoneMutedAtAnswerCopy = 'You are muted. The customer can’t hear you.';

const softphoneOutcomeSavedCopy = 'Outcome saved.';

String softphoneOutcomeNotSavedCopy(String reason) => 'The outcome wasn’t saved. $reason';

// ── Disabled reasons ──

const softphoneNotesDisabledCopy = 'Notes open when a call starts.';
const softphonePadDisabledCopy = 'Outcomes open when the customer answers.';

/// Close soft phone while a call is live or owed (the console's `SOFTPHONE_LEAVE_BLOCKED_COPY`).
const softphoneLeaveBlockedCopy = 'Finish this call and save its outcome first — leaving now would cut the customer off.';

// ── Why Call is unavailable ──

const softphoneWaitForConnectionCopy = 'Wait until your phone is connected.';
const softphoneLoadingCopy = 'Loading the soft phone…';
const softphoneSaveBeforeDialCopy = 'Save this call’s outcome before you dial again.';
const softphoneCallInProgressCopy = 'A call is in progress.';
const softphoneNoCallerIdCopy = 'There’s no caller ID to call from. Ask your supervisor to assign a number.';

/// A campaign session not yet on the soft phone (a switch still queued).
const softphoneNotSwitchedYetCopy = 'You’re not on the soft phone yet. Wait for the switch to finish.';

// ── Dial results ──

/// `contact_in_flight` with the campaign named.
String softphoneContactInFlightCopy(String campaignName) =>
    '$campaignName is calling this customer right now. Wait for that call to finish, then try again.';

/// A dial whose answer never came (a timeout, the connection dropped): the
/// call may have been placed, and it is never sent twice. The phone re-reads
/// where it stands; the call shows up on screen if it was placed.
const softphoneDialUnconfirmedCopy =
    'We didn’t hear back, so the call may have been placed. Wait a moment before you dial again — it shows here if it went through.';

/// The console's hang-up failure, with the reason after it.
String softphoneHangupFailedCopy(String reason) => 'We couldn’t end the call — you may still be connected. $reason';

// ── Mark DNC ──

/// Where a mark reaches, for the confirmation and the result: the tagged
/// campaign, else the account.
String softphoneDncScopeLabel(String? campaignName) => campaignName != null ? 'for $campaignName' : 'for this account';

String softphoneDncDoneCopy(String phoneE164, String scopeLabel) =>
    '${formatDialNumber(phoneE164)} is on the Do Not Call list $scopeLabel.';

String softphoneDncFailedCopy(String reason) => 'We couldn’t add the number to Do Not Call. $reason';

// ── Setup ──

/// A taggable campaign whose window is closed. The window is the campaign's
/// default timezone and the dial is checked in the contact's when the number
/// is on the roster (SP2), so this can only say "may" (the console's
/// `SOFTPHONE_WINDOW_CLOSED_HINT`).
const softphoneWindowClosedCopy = 'Outside this campaign’s calling hours (campaign time). Calling may need a reason.';

// ── Loading ──

const softphoneBootstrapFailedCopy = 'We couldn’t load the soft phone.';
const softphoneRecentFailedCopy = 'We couldn’t load your recent calls.';
const softphoneOpenFailedCopy = 'We couldn’t open the soft phone.';

// ── The outcome countdown ──

/// "Without one, it closes in m:ss": what is left before an owed outcome lapses.
String softphoneOutcomeCountdownCopy(Duration left) => 'Without one, it closes in ${formatDuration(left)}.';

// ── Closing and the other screens (the console's `SoftphonePage` copy) ──

const softphoneCloseConfirmTitle = 'Close the soft phone?';
const softphoneCloseConfirmCopy = 'This ends your soft-phone session. To call again, open the Phone tab.';

/// Close refused for a reason other than a call (`Your soft phone is still open — …`).
const softphoneStillOpenCopy = 'Your soft phone is still open. Try again.';

/// The soft phone open in another account (the flag on here).
String softphoneElsewhereDetailCopy(String? account) => account != null
    ? 'Your soft-phone session is open in $account. You can only have one session at a time.'
    : 'Your soft-phone session is open in another account of this workspace. You can only have one session at a time.';

String softphoneElsewhereCallPendingCopy(String? account) =>
    'Your soft phone ${account != null ? 'in $account' : 'in the other account'} has a call that isn’t finished, so it’s still open. Hang up and save its outcome there first.';

/// The soft phone off here, its session in another account.
const softphoneStrandedOwedCopy =
    'Your last call there still needs its outcome. A supervisor can save it for you from Soft-phone calls.';

/// A campaign session in an account the app cannot switch to.
String softphoneCampaignElsewhereCopy(String campaign, String? account) =>
    'You’re live on $campaign in ${account ?? 'another account'} — switch to that account to use the soft phone there.';

/// The account switch was refused or failed.
const softphoneAccountSwitchFailedCopy = 'We couldn’t switch account. Try again.';
