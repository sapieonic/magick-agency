import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/ring/ring_overrides.dart';
import '../core/session/local_preferences.dart';
import '../core/telemetry/gate_telemetry.dart';
import 'router.dart';
import 'theme/app_theme.dart';
import 'theme/tokens.dart';

/// The root widget. Light until the agent picks dark in the Me tab (AS14: a call-centre floor is
/// brightly lit, and the station's bands are read from a distance).
class AgentApp extends ConsumerWidget {
  const AgentApp({super.key});

  static final _dark = buildTheme(AppTokens.dark, Brightness.dark);
  static final _light = buildTheme(AppTokens.light, Brightness.light);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(gateTelemetryProvider);
    ref.watch(ringServicesProvider);
    final darkTheme = ref.watch(localPreferencesProvider.select((p) => p.darkTheme));
    return MaterialApp.router(
      title: 'Magick Agency',
      debugShowCheckedModeBanner: false,
      theme: _light,
      darkTheme: _dark,
      themeMode: themeModeFor(darkTheme),
      routerConfig: ref.watch(routerProvider),
      locale: const Locale('en', 'IN'),
      supportedLocales: const [Locale('en', 'IN'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, child) {
        // Large accessibility text is honoured, but capped where the call
        // controls would stop fitting a phone screen.
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(textScaler: mq.textScaler.clamp(minScaleFactor: 1, maxScaleFactor: 2)),
          child: child!,
        );
      },
    );
  }
}

/// The agent's choice from the Me tab; none yet is light (AS14), whatever the phone's setting.
ThemeMode themeModeFor(bool? darkTheme) => darkTheme == true ? ThemeMode.dark : ThemeMode.light;
