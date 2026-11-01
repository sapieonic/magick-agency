import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/session/local_preferences.dart';
import '../core/telemetry/gate_telemetry.dart';
import 'router.dart';
import 'theme/app_theme.dart';
import 'theme/tokens.dart';

/// The root widget. Theme follows the system light/dark setting until the
/// agent picks one in the Me tab; dark is the product's default look.
class AgentApp extends ConsumerWidget {
  const AgentApp({super.key});

  static final _dark = buildTheme(AppTokens.dark, Brightness.dark);
  static final _light = buildTheme(AppTokens.light, Brightness.light);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(gateTelemetryProvider);
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

/// The agent's choice from the Me tab; none yet follows the phone.
ThemeMode themeModeFor(bool? darkTheme) => switch (darkTheme) {
      true => ThemeMode.dark,
      false => ThemeMode.light,
      null => ThemeMode.system,
    };
