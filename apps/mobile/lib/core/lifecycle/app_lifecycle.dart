import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:intl/intl.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../station/station_copy.dart';
import '../telemetry/log.dart';

/// Whether the app is on screen, and when that changes. "Leaving" is
/// `hidden` (no longer visible), not `inactive` (a pulled-down shade or the
/// app switcher mid-gesture), so a glance at a notification does not pause
/// the agent.
abstract interface class AppLifecycleSource {
  bool get isForeground;
  void attach({required void Function() onHide, required void Function() onShow});
  void detach();
}

final class FlutterAppLifecycleSource implements AppLifecycleSource {
  AppLifecycleListener? _listener;

  @override
  bool get isForeground {
    final state = WidgetsBinding.instance.lifecycleState;
    return state == null || state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;
  }

  @override
  void attach({required void Function() onHide, required void Function() onShow}) {
    _listener?.dispose();
    _listener = AppLifecycleListener(onHide: onHide, onShow: onShow);
  }

  @override
  void detach() {
    _listener?.dispose();
    _listener = null;
  }
}

abstract interface class WakeLock {
  Future<void> set(bool enabled);
}

final class WakelockPlusLock implements WakeLock {
  const WakelockPlusLock();

  @override
  Future<void> set(bool enabled) => WakelockPlus.toggle(enable: enabled);
}

/// The station's local notifications while the app is away.
abstract interface class StationNotifier {
  /// "You're paused. Open the app to take calls again." ([body]: the station's words for why).
  Future<void> showPaused({String body = pausedNotificationBody});

  /// "Save the outcome by 11:28" ([deadline] on this device's clock), titled
  /// for the campaign call's wrap-up.
  Future<void> showWrapupDeadline(DateTime deadline);

  /// The same for a soft-phone call that owes its outcome, titled for the soft
  /// phone (it is no campaign wrap-up).
  Future<void> showSoftphoneOutcomeDeadline(DateTime deadline);
  Future<void> cancel();
}

/// `flutter_local_notifications`, initialised on first use. Asking for the
/// notification permission is the pre-flight's job; without it these are
/// simply not shown.
final class LocalStationNotifier implements StationNotifier {
  LocalStationNotifier([FlutterLocalNotificationsPlugin? plugin]) : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  static final _log = Log('station.notify');
  static const _id = 4101;
  static const _details = NotificationDetails(
    android: AndroidNotificationDetails(
      'station',
      'Station',
      channelDescription: 'When you are paused or have an outcome to save',
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.status,
    ),
    // `active`, not `timeSensitive`: the latter needs an entitlement the app does not claim.
    iOS: DarwinNotificationDetails(interruptionLevel: InterruptionLevel.active),
  );

  final FlutterLocalNotificationsPlugin _plugin;
  Future<void>? _ready;

  Future<void> _init() => _ready ??= _plugin
      .initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(
            requestAlertPermission: false,
            requestBadgePermission: false,
            requestSoundPermission: false,
          ),
        ),
      )
      .then((_) {});

  Future<void> _show(String title, String body) async {
    try {
      await _init();
      await _plugin.show(id: _id, title: title, body: body, notificationDetails: _details);
    } catch (e) {
      _log.warn('notification failed', {'error': e.runtimeType.toString()});
    }
  }

  @override
  Future<void> showPaused({String body = pausedNotificationBody}) => _show(pausedNotificationTitle, body);

  @override
  Future<void> showWrapupDeadline(DateTime deadline) =>
      _show(wrapupNotificationTitle, wrapupNotificationBody(DateFormat.Hm().format(deadline.toLocal())));

  @override
  Future<void> showSoftphoneOutcomeDeadline(DateTime deadline) =>
      _show(softphoneOutcomeNotificationTitle, wrapupNotificationBody(DateFormat.Hm().format(deadline.toLocal())));

  @override
  Future<void> cancel() async {
    try {
      await _init();
      await _plugin.cancel(id: _id);
    } catch (e) {
      _log.warn('notification cancel failed', {'error': e.runtimeType.toString()});
    }
  }
}
