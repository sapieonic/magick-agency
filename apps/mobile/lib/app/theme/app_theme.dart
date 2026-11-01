import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tokens.dart';

/// Builds the app's [ThemeData] for one token set.
///
/// Material components pick their colours from the [ColorScheme] derived
/// here, so a stock `FilledButton` or `TextField` already looks like the
/// product; screens only reach for [AppTokens] for the semantic colours
/// Material has no slot for (ember, success, warning).
ThemeData buildTheme(AppTokens t, Brightness brightness) {
  final scheme = ColorScheme(
    brightness: brightness,
    primary: t.accent,
    onPrimary: t.onAccent,
    primaryContainer: t.accentSubtle,
    onPrimaryContainer: t.textPrimary,
    secondary: t.ember,
    onSecondary: t.onAccent,
    error: t.danger,
    onError: t.onAccent,
    errorContainer: t.dangerSubtle,
    onErrorContainer: t.danger,
    surface: t.bgPrimary,
    onSurface: t.textPrimary,
    onSurfaceVariant: t.textSecondary,
    surfaceContainerLowest: t.bgPrimary,
    surfaceContainerLow: t.bgSecondary,
    surfaceContainer: t.bgSecondary,
    surfaceContainerHigh: t.bgTertiary,
    surfaceContainerHighest: t.bgElevated,
    outline: t.borderStrong,
    outlineVariant: t.border,
    shadow: const Color(0xFF000000),
    scrim: const Color(0xCC050508),
    inverseSurface: t.textPrimary,
    onInverseSurface: t.bgPrimary,
    inversePrimary: t.accentHover,
  );

  final text = _textTheme(t);
  final rounded = RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.md));
  const minButton = Size(Space.touch, Space.touch);

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: t.bgPrimary,
    canvasColor: t.bgPrimary,
    fontFamily: Fonts.body,
    textTheme: text,
    extensions: [t],
    splashFactory: InkSparkle.splashFactory,
    materialTapTargetSize: MaterialTapTargetSize.padded,
    visualDensity: VisualDensity.standard,
    appBarTheme: AppBarTheme(
      backgroundColor: t.bgPrimary,
      foregroundColor: t.textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: text.titleLarge,
      systemOverlayStyle: brightness == Brightness.dark
          ? SystemUiOverlayStyle.light.copyWith(statusBarColor: const Color(0x00000000))
          : SystemUiOverlayStyle.dark.copyWith(statusBarColor: const Color(0x00000000)),
    ),
    cardTheme: CardThemeData(
      color: t.bgSecondary,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        side: BorderSide(color: t.border),
      ),
    ),
    dividerTheme: DividerThemeData(color: t.border, thickness: 1, space: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: minButton,
        shape: rounded,
        textStyle: text.labelLarge,
        padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: minButton,
        shape: rounded,
        foregroundColor: t.textPrimary,
        side: BorderSide(color: t.borderStrong),
        textStyle: text.labelLarge,
        padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(minimumSize: minButton, foregroundColor: t.accentHover, textStyle: text.labelLarge),
    ),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(minimumSize: minButton)),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: t.bgSecondary,
      contentPadding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.md),
      labelStyle: TextStyle(color: t.textSecondary),
      hintStyle: TextStyle(color: t.textMuted),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.sm), borderSide: BorderSide(color: t.border)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.sm), borderSide: BorderSide(color: t.border)),
      focusedBorder:
          OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.sm), borderSide: BorderSide(color: t.accent, width: 1.5)),
      errorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.sm), borderSide: BorderSide(color: t.danger)),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: t.bgTertiary,
      selectedColor: t.accentSubtle,
      side: BorderSide(color: t.border),
      labelStyle: text.labelMedium,
      shape: const StadiumBorder(),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: t.bgSecondary,
      indicatorColor: t.accentSubtle,
      elevation: 0,
      height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => text.labelSmall!.copyWith(color: s.contains(WidgetState.selected) ? t.accentHover : t.textMuted),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (s) => IconThemeData(color: s.contains(WidgetState.selected) ? t.accentHover : t.textMuted),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: t.bgSecondary,
      modalBackgroundColor: t.bgSecondary,
      showDragHandle: true,
      dragHandleColor: t.borderStrong,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.xl))),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: t.bgSecondary,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.lg)),
      titleTextStyle: text.titleLarge,
      contentTextStyle: text.bodyMedium,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: t.bgElevated,
      contentTextStyle: text.bodyMedium,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.sm)),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: t.accent, linearTrackColor: t.bgTertiary),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        backgroundColor: t.bgSecondary,
        selectedBackgroundColor: t.bgElevated,
        selectedForegroundColor: t.textPrimary,
        foregroundColor: t.textMuted,
        side: BorderSide(color: t.border),
      ),
    ),
  );
}

TextTheme _textTheme(AppTokens t) {
  TextStyle display(double size, FontWeight w, {double height = 1.15}) => TextStyle(
        fontFamily: Fonts.display,
        fontSize: size,
        fontWeight: w,
        height: height,
        letterSpacing: -0.2,
        color: t.textPrimary,
      );
  TextStyle body(double size, FontWeight w, Color c, {double height = 1.45}) =>
      TextStyle(fontFamily: Fonts.body, fontSize: size, fontWeight: w, height: height, color: c);

  return TextTheme(
    displayLarge: display(40, FontWeight.w800),
    displayMedium: display(32, FontWeight.w800),
    displaySmall: display(28, FontWeight.w800),
    headlineLarge: display(26, FontWeight.w800),
    headlineMedium: display(22, FontWeight.w800),
    headlineSmall: display(20, FontWeight.w700),
    titleLarge: display(18, FontWeight.w700),
    titleMedium: display(16, FontWeight.w700),
    titleSmall: body(14, FontWeight.w600, t.textPrimary),
    bodyLarge: body(16, FontWeight.w400, t.textPrimary),
    bodyMedium: body(14, FontWeight.w400, t.textPrimary),
    bodySmall: body(12.5, FontWeight.w400, t.textSecondary),
    labelLarge: body(15, FontWeight.w600, t.textPrimary, height: 1.2),
    labelMedium: body(13, FontWeight.w500, t.textSecondary, height: 1.2),
    labelSmall: body(11.5, FontWeight.w500, t.textMuted, height: 1.2),
  );
}

/// Numbers that line up (timers, counts, phone numbers): JetBrains Mono with
/// tabular figures, so a ticking timer never shifts its neighbours.
TextStyle monoStyle(BuildContext context, {double size = 14, FontWeight weight = FontWeight.w500, Color? color}) {
  final t = context.tokens;
  return TextStyle(
    fontFamily: Fonts.mono,
    fontSize: size,
    fontWeight: weight,
    color: color ?? t.textSecondary,
    fontFeatures: const [FontFeature.tabularFigures()],
    height: 1.2,
  );
}
