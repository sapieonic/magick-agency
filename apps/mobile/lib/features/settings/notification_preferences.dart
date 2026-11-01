import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';

/// The agent's email preferences for the current workspace
/// (`GET/PUT /notifications/preferences`). The server serves the catalog with
/// the values, so whatever events arrive are rendered; nothing is hard-coded.
///
/// A toggle saves at once (a phone has no "Save changes" bar), optimistically:
/// the switch moves immediately and moves back, with the reason, if the
/// server refuses.
class NotificationPreferencesController extends AsyncNotifier<List<NotificationEventPreference>> {
  static const _path = '/notifications/preferences';

  @override
  Future<List<NotificationEventPreference>> build() async {
    final account = ref.watch(readyAccountProvider);
    if (account == null) return const [];
    final body = await _guard(() => ref.read(apiClientProvider).get(_path));
    if (body is! Map<String, Object?>) throw const ApiDecodeError(_path, FormatException('expected an object'));
    try {
      return NotificationPreferencesResponse.fromJson(body).events;
    } on FormatException catch (e) {
      throw ApiDecodeError(_path, e);
    }
  }

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiUnauthorized catch (e) {
      final gate = ref.read(appGateProvider.notifier);
      unawaited(Future.microtask(() => gate.reportError(e)));
      rethrow;
    }
  }

  /// Turns an event on or off. Returns null when saved, else what to tell
  /// the agent (the switch is back where it was).
  Future<String?> setEnabled(String key, bool enabled) => _save(key, (e) => _with(e, enabled: enabled));

  /// Picks a digest's frequency (which also turns it on).
  Future<String?> setFrequency(String key, NotificationFrequency frequency) =>
      _save(key, (e) => _with(e, enabled: true, frequency: frequency));

  Future<String?> _save(String key, NotificationEventPreference Function(NotificationEventPreference) change) async {
    final before = state.value;
    if (before == null) return null;
    final index = before.indexWhere((e) => e.key == key);
    if (index < 0) return null;
    final next = change(before[index]);
    state = AsyncData([...before]..[index] = next);
    try {
      await _guard(() => ref.read(apiClientProvider).put(_path, body: {
            'preferences': [
              NotificationPreferenceUpdate(
                eventKey: next.key,
                channel: next.channel,
                enabled: next.enabled,
                frequency: next.cadence == NotificationCadence.digest ? next.frequency : null,
              ).toJson(),
            ],
          }));
      return null;
    } on ApiError catch (e) {
      if (ref.mounted) {
        final now = state.value;
        if (now != null) {
          final i = now.indexWhere((x) => x.key == key);
          if (i >= 0) state = AsyncData([...now]..[i] = before[index]);
        }
      }
      return e is ApiNetworkError ? e.userMessage : 'Could not save your settings. ${e.userMessage}';
    }
  }

  static NotificationEventPreference _with(
    NotificationEventPreference e, {
    required bool enabled,
    NotificationFrequency? frequency,
  }) =>
      NotificationEventPreference(
        key: e.key,
        label: e.label,
        description: e.description,
        category: e.category,
        cadence: e.cadence,
        cadenceRaw: e.cadenceRaw,
        channel: e.channel,
        enabled: enabled,
        frequency: frequency ?? e.frequency,
        frequencyRaw: frequency?.wire ?? e.frequencyRaw,
        defaultEnabled: e.defaultEnabled,
        defaultFrequency: e.defaultFrequency,
        defaultFrequencyRaw: e.defaultFrequencyRaw,
        isDefault: false,
      );
}

final notificationPreferencesProvider =
    AsyncNotifierProvider<NotificationPreferencesController, List<NotificationEventPreference>>(
  NotificationPreferencesController.new,
  retry: (_, _) => null,
);

/// The console's group names; an unknown category is title-cased.
String categoryLabel(String category) => switch (category) {
      'digests' => 'Summaries',
      'campaigns' => 'Campaigns',
      'agency' => 'Agency dialer',
      '' => 'Other',
      _ => '${category[0].toUpperCase()}${category.substring(1).replaceAll(RegExp('[_-]'), ' ')}',
    };

const frequencyLabels = {NotificationFrequency.daily: 'Every day', NotificationFrequency.weekly: 'Every week'};
