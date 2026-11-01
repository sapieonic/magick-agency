/// Every sentence on the pre-flight screen, in one place for localisation.
/// The join-conflict wording follows the console's `agencyJoinConflict` and
/// `SoftphoneJoinScreen`.
abstract final class PreflightCopy {
  static const title = 'Ready to take calls?';
  static const checking = 'Checking…';
  static const keepOpen = 'Keep this app open while you wait for calls. If you leave it, we pause you.';
  static const goOnDuty = 'Go on duty';
  static const joining = 'Joining…';
  static const checkAgain = 'Check again';
  static const back = 'Back';

  static const pillOk = 'OK';
  static const pillGood = 'Good';
  static const pillWeak = 'Weak';
  static const pillCheck = 'Check';
  static const pillFail = 'Fix';

  // Microphone.
  static const mic = 'Microphone';
  static const micAllowed = 'Allowed';
  static const micDenied = 'Not allowed — the customer won’t hear you.';
  static const micBlocked = 'Blocked in Settings — the customer won’t hear you.';
  static const micUnknown = 'We couldn’t check the microphone.';
  static const allow = 'Allow';
  static const openSettings = 'Open Settings';

  // Sound check.
  static const sound = 'Sound check';
  static const soundOk = 'We heard you back clearly';
  static const soundQuiet = 'We could barely hear you. Check the mic isn’t covered.';
  static const soundNotHeard = 'We didn’t hear you back. Check your headset’s mic.';
  static const soundCouldNotRun = 'Couldn’t run the sound check.';
  static const soundNeedsMic = 'Allow the microphone first.';

  // Headset.
  static const headset = 'Headset';
  static const bluetooth = 'Bluetooth';
  static const wired = 'Wired';
  static String routeDetail(String name, String kind) => '$name · $kind';
  static const noHeadset = 'No headset — calls will use the phone. A headset sounds better to the customer.';

  // Network.
  static const network = 'Network';
  static const offline = 'No connection — you can’t take calls offline.';
  static const unreachable = 'We couldn’t reach Magick Agency.';
  static String upload(double kbps) => kbps >= 1000 ? '${(kbps / 1000).toStringAsFixed(1)} Mbps up' : '${kbps.round()} kbps up';
  static String tooSlow(String measured) => 'Too slow for calls${measured.isEmpty ? '' : ' ($measured)'}. Move to better signal or Wi-Fi.';
  static String mayStutter(String measured) => '${measured.isEmpty ? 'Slow connection' : measured}. Calls may break up.';

  // Battery.
  static const battery = 'Battery';
  static String batteryTitle(int level) => 'Battery $level%';
  static const charging = 'Charging';
  static const batteryLow = 'Plug in now — this won’t last a shift.';
  static const plugIn = 'Plug in for a long shift';
  static const batteryFine = 'Enough for now';

  // Battery saver (Android).
  static const batterySaver = 'Battery saver';
  static const saverOk = 'Magick Agency is allowed to run';
  static const saverOn = 'Your phone may pause the app during calls.';
  static const allowBackground = 'Allow';

  static const couldNotCheck = 'Couldn’t check';

  // Why "Go on duty" is unavailable.
  static const blockedChecking = 'Checking your phone…';
  static const blockedMic = 'Allow the microphone to take calls.';
  static const blockedNetwork = 'You need a working connection to take calls.';

  // Join outcomes.
  static const elsewhereTitle = 'You’re still at another station';
  static String elsewhereDetail(String campaign, String state, String? account) =>
      'You’re joined to $campaign${account == null || account.trim().isEmpty ? '' : ' in $account'} — ${state.toLowerCase()}. You can only be at one station at a time.';
  static String elsewhereRemedyMidCall(String campaign) =>
      'Finish what you’re doing on $campaign, leave that station, then come back here.';
  static String elsewhereRemedy(String campaign) => 'Leave $campaign first, then come back here.';
  static String switchAction(String campaign) => 'Leave $campaign and join here';
  static const switchConfirmTitle = 'Leave that station?';
  static String switchConfirmMessage(String campaign) => 'This closes your session on $campaign and joins this campaign right after.';
  static const switchConfirmAction = 'Leave & join here';

  static const softphoneTitle = 'You’re on the soft phone';
  static const softphoneDetail = 'You can only have one session at a time, and yours is the soft phone.';
  static const softphoneRemedy = 'Close it to join this campaign.';
  static const softphoneCloseAndJoin = 'Close the soft phone and join';
  static const tryAgain = 'Try again';

  static const refusedTitle = 'Can’t open the station';
  static const startFailed = 'Couldn’t open the station. Check your connection and try again.';
  static const backToCampaigns = 'Back to campaigns';
  static const cancel = 'Cancel';
  static const thisCampaign = 'this campaign';
}
