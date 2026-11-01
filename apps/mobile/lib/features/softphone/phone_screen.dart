import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../../core/softphone/softphone_view.dart';
import '../preflight/preflight_checks.dart';
import '../station/station_providers.dart';
import 'parts/session_cards.dart';
import 'softphone_copy.dart';
import 'softphone_panel.dart';

/// What the "Open the soft phone" tap asks the phone for before the core
/// opens a session: the microphone (without it the customer hears nothing) and
/// notifications (the on-duty notification carries Mute and Hang up).
abstract interface class SoftphonePermissions {
  /// The system prompt for the microphone, or its state when already decided.
  Future<MicPermission> requestMicrophone();

  /// The notification prompt. Advisory: the soft phone opens either way.
  Future<void> requestNotifications();
}

/// The phone's own permissions: the microphone through the pre-flight's checks
/// (one place asks for it), notifications through `permission_handler`.
class DeviceSoftphonePermissions implements SoftphonePermissions {
  DeviceSoftphonePermissions(this._checks);

  final PreflightChecks _checks;

  @override
  Future<MicPermission> requestMicrophone() => _checks.requestMicrophone();

  @override
  Future<void> requestNotifications() async {
    try {
      await ph.Permission.notification.request();
    } catch (_) {
      // A platform without the prompt: nothing to ask.
    }
  }
}

/// Overridden in tests; the app's default asks the phone.
final softphonePermissionsProvider = Provider<SoftphonePermissions>(
  (ref) => DeviceSoftphonePermissions(ref.watch(preflightChecksProvider)),
);

/// The Phone tab: the soft phone when a soft-phone session is hosted here,
/// otherwise the screen that says why not and offers the way to one.
///
/// Opening is an explicit tap (never on arriving at the tab): it asks for the
/// microphone and notifications first, in the foreground, so the permission
/// prompt never lands mid-call and Android lets the on-duty service start. An
/// existing session is resumed by the core without a tap.
///
/// It reads only [softphoneViewProvider] and calls [softphoneActionsProvider].
class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({super.key});

  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  bool _asking = false;
  String? _permissionNote;

  Future<void> _open() async {
    if (_asking) return;
    setState(() {
      _asking = true;
      _permissionNote = null;
    });
    final permissions = ref.read(softphonePermissionsProvider);
    final actions = ref.read(softphoneActionsProvider);
    MicPermission mic;
    try {
      mic = await permissions.requestMicrophone();
      await permissions.requestNotifications();
    } catch (_) {
      mic = MicPermission.denied;
    }
    if (!mounted) return;
    if (mic != MicPermission.granted) {
      setState(() {
        _asking = false;
        _permissionNote = SoftphoneCopy.micDenied;
      });
      return;
    }
    setState(() => _asking = false);
    await actions.open();
  }

  @override
  Widget build(BuildContext context) {
    final screen = ref.watch(softphoneViewProvider.select((v) => v.screen));
    final callOnScreen = ref.watch(softphoneViewProvider.select((v) => v.callOnScreen));
    final openSettings = ref.read(stationOpenSettingsProvider);

    final Widget body = switch (screen) {
      SoftphoneScreenLoading() => const LoadingCard(message: SoftphoneCopy.loading),
      SoftphoneScreenOpening() => const LoadingCard(message: SoftphoneCopy.opening),
      final SoftphoneScreenClosed s => ClosedCard(
        state: s,
        onOpen: _open,
        onOpenSettings: openSettings,
        permissionNote: _permissionNote,
        askingPermission: _asking,
      ),
      SoftphoneScreenActive() => const SoftphonePanel(surface: SoftphoneSurface.phone),
      final SoftphoneScreenOnCampaign s => OnCampaignCard(state: s),
      final SoftphoneScreenElsewhere s => ElsewhereCard(state: s),
      SoftphoneScreenOff() => const OffCard(),
      final SoftphoneScreenOffStranded s => StrandedCard(state: s),
      final SoftphoneScreenError s => ErrorCard(state: s),
    };

    final active = screen is SoftphoneScreenActive;
    // Mid-call the system back gesture must not take the call away; the way
    // off it is finishing the call.
    return PopScope(
      canPop: !(active && callOnScreen),
      child: Scaffold(
        body: SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            // Landscape and tablets: a readable column, not a 1000 px line.
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: KeyedSubtree(key: ValueKey(screen.runtimeType), child: body),
            ),
          ),
        ),
      ),
    );
  }
}
