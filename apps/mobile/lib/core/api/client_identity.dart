import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Who is calling: sent as `X-Client` on every HTTP request so server logs and
/// metrics can split traffic by client. It is never an auth input and never a
/// rate-limit key on the server.
///
/// Format: `magick-agency-mobile/<semver>+<build> (<ios|android> <osver>; <model>)`.
@immutable
class ClientIdentity {
  const ClientIdentity({
    required this.version,
    required this.build,
    required this.platform,
    required this.osVersion,
    required this.model,
  });

  /// Read once at start-up (both reads hit platform channels).
  static Future<ClientIdentity> load() async {
    final pkg = await PackageInfo.fromPlatform();
    final info = DeviceInfoPlugin();
    var platform = 'unknown';
    var os = '';
    var model = '';
    if (!kIsWeb && Platform.isAndroid) {
      final a = await info.androidInfo;
      platform = 'android';
      os = a.version.release;
      model = '${a.manufacturer} ${a.model}';
    } else if (!kIsWeb && Platform.isIOS) {
      final i = await info.iosInfo;
      platform = 'ios';
      os = i.systemVersion;
      model = i.utsname.machine;
    }
    return ClientIdentity(
      version: pkg.version,
      build: pkg.buildNumber,
      platform: platform,
      osVersion: os,
      model: model,
    );
  }

  final String version;
  final String build;

  /// `ios`, `android` or `unknown` (tests).
  final String platform;
  final String osVersion;
  final String model;

  /// The header value. Characters outside printable ASCII are dropped: a
  /// device model with an emoji must not make every request fail.
  String get header {
    final raw = 'magick-agency-mobile/$version+$build ($platform $osVersion; $model)';
    return String.fromCharCodes(raw.codeUnits.where((c) => c >= 0x20 && c < 0x7f));
  }

  /// The version when it could not be read; see [unknown].
  static const unknownVersion = 'unknown';

  /// Whether [version] was read (the update gate judges only a known one).
  bool get versionKnown => version != unknownVersion;

  /// When the platform reads fail at start-up: the app still starts, and the
  /// server still sees which app and platform are calling.
  static ClientIdentity get unknown => ClientIdentity(
        version: unknownVersion,
        build: '0',
        platform: switch (defaultTargetPlatform) {
          TargetPlatform.iOS => 'ios',
          TargetPlatform.android => 'android',
          _ => 'unknown',
        },
        osVersion: '',
        model: '',
      );

  static const test = ClientIdentity(version: '0.1.0', build: '1', platform: 'unknown', osVersion: '', model: 'test');
}
