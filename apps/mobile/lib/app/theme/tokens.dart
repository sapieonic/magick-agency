import 'package:flutter/material.dart';

/// The product's design tokens, mirrored from `packages/web-ui/src/global.css`
/// so the app and the web console read as one product.
///
/// Read them with `context.tokens` (see [AppTokensContext]). Screens never use
/// a literal colour: a literal reads in one theme only.
///
/// The rule the web console set for the two brand hues holds here too:
/// [accent] is what the product is CALLED (identity, navigation, the primary
/// action), [ember] is what the platform is DOING (ringing, the available
/// pulse, reconnecting). Ember always moves; [warning] never does. Under
/// reduced motion an ember indicator keeps a static ring, so "in flight" and
/// "needs attention" stay distinguishable without animation.
@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.bgPrimary,
    required this.bgSecondary,
    required this.bgTertiary,
    required this.bgElevated,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.accent,
    required this.accentHover,
    required this.accentSubtle,
    required this.ember,
    required this.emberDeep,
    required this.emberSubtle,
    required this.success,
    required this.successSubtle,
    required this.warning,
    required this.warningSubtle,
    required this.danger,
    required this.dangerSubtle,
    required this.info,
    required this.infoSubtle,
    required this.border,
    required this.borderStrong,
    required this.borderFocus,
    required this.onAccent,
  });

  final Color bgPrimary;
  final Color bgSecondary;
  final Color bgTertiary;
  final Color bgElevated;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color accent;
  final Color accentHover;
  final Color accentSubtle;
  final Color ember;
  final Color emberDeep;
  final Color emberSubtle;
  final Color success;
  final Color successSubtle;
  final Color warning;
  final Color warningSubtle;
  final Color danger;
  final Color dangerSubtle;
  final Color info;
  final Color infoSubtle;
  final Color border;
  final Color borderStrong;
  final Color borderFocus;

  /// Text and icons on an [accent], [ember] or [danger] fill.
  final Color onAccent;

  /// Dark is the product's default look (`color-scheme: dark` in global.css).
  static const dark = AppTokens(
    bgPrimary: Color(0xFF0C0C11),
    bgSecondary: Color(0xFF131318),
    bgTertiary: Color(0xFF1A1A21),
    bgElevated: Color(0xFF212128),
    textPrimary: Color(0xFFF1F1F5),
    textSecondary: Color(0xFFB4B4C2),
    textMuted: Color(0xFF8A8A9C),
    accent: Color(0xFF7C5CFC),
    accentHover: Color(0xFF9B82FF),
    accentSubtle: Color(0x1F7C5CFC),
    ember: Color(0xFFFA8231),
    // The ember FILL: `--ember` is tuned as text on dark and is too light a
    // ground for white text, so filled buttons use the deep stop (global.css).
    emberDeep: Color(0xFFC65100),
    emberSubtle: Color(0x21FA8231),
    success: Color(0xFF3FCF9E),
    successSubtle: Color(0x1F3FCF9E),
    warning: Color(0xFFE8A63F),
    warningSubtle: Color(0x1FE8A63F),
    danger: Color(0xFFEF6B6B),
    dangerSubtle: Color(0x1FEF6B6B),
    info: Color(0xFF56B8F0),
    infoSubtle: Color(0x1F56B8F0),
    border: Color(0x14FFFFFF),
    borderStrong: Color(0x24FFFFFF),
    borderFocus: Color(0x807C5CFC),
    onAccent: Color(0xFFFFFFFF),
  );

  static const light = AppTokens(
    bgPrimary: Color(0xFFF5F6F8),
    bgSecondary: Color(0xFFFFFFFF),
    bgTertiary: Color(0xFFEBECF0),
    bgElevated: Color(0xFFFAFAFC),
    textPrimary: Color(0xFF17172B),
    textSecondary: Color(0xFF4A5165),
    textMuted: Color(0xFF697084),
    accent: Color(0xFF6A4DE4),
    accentHover: Color(0xFF5A40CE),
    accentSubtle: Color(0x1A6A4DE4),
    ember: Color(0xFFBD4F05),
    emberDeep: Color(0xFFA33F04),
    emberSubtle: Color(0x1ABD4F05),
    success: Color(0xFF0F9B80),
    successSubtle: Color(0x1A0F9B80),
    warning: Color(0xFFB8801C),
    warningSubtle: Color(0x1AB8801C),
    danger: Color(0xFFD03F4B),
    dangerSubtle: Color(0x17D03F4B),
    info: Color(0xFF0B8FD4),
    infoSubtle: Color(0x1A0B8FD4),
    border: Color(0x29545E7E),
    borderStrong: Color(0x3D545E7E),
    borderFocus: Color(0x5C6A4DE4),
    onAccent: Color(0xFFFFFFFF),
  );

  @override
  AppTokens copyWith() => this;

  @override
  AppTokens lerp(covariant AppTokens? other, double t) {
    if (other == null) return this;
    Color c(Color a, Color b) => Color.lerp(a, b, t)!;
    return AppTokens(
      bgPrimary: c(bgPrimary, other.bgPrimary),
      bgSecondary: c(bgSecondary, other.bgSecondary),
      bgTertiary: c(bgTertiary, other.bgTertiary),
      bgElevated: c(bgElevated, other.bgElevated),
      textPrimary: c(textPrimary, other.textPrimary),
      textSecondary: c(textSecondary, other.textSecondary),
      textMuted: c(textMuted, other.textMuted),
      accent: c(accent, other.accent),
      accentHover: c(accentHover, other.accentHover),
      accentSubtle: c(accentSubtle, other.accentSubtle),
      ember: c(ember, other.ember),
      emberDeep: c(emberDeep, other.emberDeep),
      emberSubtle: c(emberSubtle, other.emberSubtle),
      success: c(success, other.success),
      successSubtle: c(successSubtle, other.successSubtle),
      warning: c(warning, other.warning),
      warningSubtle: c(warningSubtle, other.warningSubtle),
      danger: c(danger, other.danger),
      dangerSubtle: c(dangerSubtle, other.dangerSubtle),
      info: c(info, other.info),
      infoSubtle: c(infoSubtle, other.infoSubtle),
      border: c(border, other.border),
      borderStrong: c(borderStrong, other.borderStrong),
      borderFocus: c(borderFocus, other.borderFocus),
      onAccent: c(onAccent, other.onAccent),
    );
  }
}

/// Spacing and radii (global.css `--radius*`), in logical pixels.
abstract final class Space {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;

  /// The minimum touch target (Material and Apple HIG agree on ~48/44).
  static const double touch = 48;
}

abstract final class Radii {
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 20;
  static const double pill = 999;
}

/// Font families bundled in `assets/fonts`.
abstract final class Fonts {
  static const display = 'PlusJakartaSans';
  static const body = 'Inter';
  static const mono = 'JetBrainsMono';
}

extension AppTokensContext on BuildContext {
  /// The current theme's tokens. Always present: both [ThemeData]s carry them.
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}
