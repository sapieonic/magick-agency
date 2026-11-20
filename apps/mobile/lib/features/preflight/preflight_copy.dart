/// Every sentence on the pre-flight screen, in one place for localisation.
/// The join-conflict wording follows the console's `agencyJoinConflict` and
/// `SoftphoneJoinScreen`.
abstract final class PreflightCopy {
  static const title = 'Start of day';
  static const checkThese = 'Check these. Then start work.';
  static const micBlockedTitle = 'Microphone is blocked';
  static const micBlockedSubtitle = 'The customer cannot hear you. Fix this first.';
  static const noInternetTitle = 'No internet';
  static const noInternetSubtitle = 'You cannot take calls without it.';
  static const allowMicrophone = 'Allow microphone';
  static const stepOpenSettings = 'Press Open Settings below.';
  static const stepTurnOnMic = 'Turn on Microphone.';
  static const stepComeBack = 'Come back to this app.';
  static const stepPressAllow = 'Press Allow microphone below.';
  static const stepAllowMic = 'Choose Allow when your phone asks.';
  static const stepCheckAgain = 'Press Check again.';
  static const checking = 'Checking…';
  static const keepOpen = 'Keep this app open while you wait for calls. If you leave it, we pause you.';
  static const goOnDuty = 'Start work';
  static const joining = 'Starting…';
  static const finishingSoundCheck = 'Finishing the sound check…';
  static const checkAgain = 'Check again';

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
  static const soundListening = 'Say hello — we’re listening to your mic…';
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
  static const network = 'Internet';
  static const offline = 'No internet — you can’t take calls without it.';
  static const unreachable = 'We couldn’t reach Magick Agency.';
  static String noAnswer(String? transport) =>
      'Too slow for calls — you’re connected${transport == null ? '' : ' ($transport)'}, but Magick Agency took too long to answer. Move to better signal or Wi-Fi.';
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

  // Join outcomes: the station's own words (AS15), as the console's join screens say them
  // (`StationJoinScreens.tsx`, `stationCopy.ts`'s `otherWork…`, `softphoneJoin…`, `joinFailed…`).
  // [doing] is what the agent is doing there, in words (`joinDoingWords`).
  static const elsewhereTitle = 'You are working somewhere else';
  static const elsewhereSubtitle = 'You can work on only one list at a time.';
  static String elsewhereDetail(String work, String doing, String? account) =>
      'You are on $work${account == null || account.trim().isEmpty ? '' : ' in ${account.trim()}'}, $doing.';
  static String elsewhereRemedyMidCall(String work) => 'Finish the call on $work first, then come back here.';
  static String elsewhereRemedy(String work) => 'Leave $work first, then come back here.';
  static String switchAction(String work) => 'Leave $work and work here';
  static String switchConfirmTitle(String work) => 'Leave $work?';
  static String switchConfirmMessage(String work) => 'We will close your work on $work and start it here.';
  static const switchConfirmAction = 'Leave and work here';

  static const softphoneTitle = 'You are on the soft phone';
  static const softphoneDetail = 'Your soft phone is still open.';
  static const softphoneRemedy = 'You can use one at a time. Close the soft phone to start work here.';
  static const softphoneCloseAndJoin = 'Close the soft phone and start here';
  static const tryAgain = 'Try again';

  static const refusedTitle = 'Your work did not open';
  static const startFailed = 'We could not open your work just now. Check your internet and try again.';
  static const backToCampaigns = 'Back to my work list';
  static const cancel = 'No, stay';
}
