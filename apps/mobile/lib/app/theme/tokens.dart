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
///
/// Contrast (WCAG AA, 4.5:1 for text): a few values are darker here than in
/// global.css, where the web's pair failed on a phone. Each state colour is
/// read as text on its own subtle tint (the call bands, the queued break, the
/// banners), so in the light theme [success], [warning], [danger] and [ember]
/// are one step deeper than the web's while their tints keep the web's values:
/// worst case over [bgPrimary]/[bgSecondary] is 4.5:1 or more. White on a
/// filled [danger] was 3.0:1 in the dark theme, so filled destructive buttons
/// use [dangerDeep] (as filled ember buttons use [emberDeep]); the dark
/// [accent] is a shade deeper so white on the primary button passes too.
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
    required this.dangerDeep,
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

  /// The danger FILL, for white text on it: [danger] is tuned as text on the
  /// background and is too light a ground for [onAccent] in the dark theme.
  final Color dangerDeep;
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
    // global.css #7c5cfc gives white text 4.38:1; this is 4.74:1.
    accent: Color(0xFF7656F6),
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
    // White on it 5.04:1 (on `danger` 3.01:1).
    dangerDeep: Color(0xFFC83C3C),
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
    // Text on its tint: 4.57:1 (global.css #bd4f05: 3.95:1). The tints keep
    // the web's values.
    ember: Color(0xFFAD4804),
    emberDeep: Color(0xFFA33F04),
    emberSubtle: Color(0x1ABD4F05),
    // 4.74:1 on its tint (#0f9b80: 2.90:1).
    success: Color(0xFF077461),
    successSubtle: Color(0x1A0F9B80),
    // 4.67:1 on its tint (#b8801c: 2.86:1).
    warning: Color(0xFF8C5F0E),
    warningSubtle: Color(0x1AB8801C),
    // 4.57:1 on its tint (#d03f4b: 3.82:1); white on it 5.59:1.
    danger: Color(0xFFBE3440),
    dangerDeep: Color(0xFFBE3440),
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
      dangerDeep: c(dangerDeep, other.dangerDeep),
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

/// The agent station's states (the redesign's AS1, `docs/agent-station/design-spec.md` §1): one
/// state, one screen, one colour. The same colour means the same thing on the console and here.
enum StationTone {
  /// Start of day, Finish work: ink.
  start,

  /// Ready: green.
  ready,

  /// Call coming: blue.
  coming,

  /// On call: deep blue.
  onCall,

  /// What happened?: brand purple.
  happened,

  /// On break, and the app's own pause: amber, dark text.
  onBreak,

  /// Break over time, time over: red-orange.
  over,

  /// Internet problem, call problem, microphone blocked: red.
  problem,

  /// No calls right now, open on another device: slate.
  quiet,
}

/// One state's four colours (`--ma-st-<name>` in `docs/agent-station/mockups/tokens.css`).
@immutable
class StateColors {
  const StateColors({required this.band, required this.ink, required this.soft, required this.deep});

  /// The full-width band's fill.
  final Color band;

  /// Text and icons on [band].
  final Color ink;

  /// A pale tint for tiles and chips.
  final Color soft;

  /// The state's colour as text on the page (AA on [AppTokens.bgSecondary] and on [soft]).
  final Color deep;

  @override
  bool operator ==(Object other) =>
      other is StateColors && other.band == band && other.ink == ink && other.soft == soft && other.deep == deep;
  @override
  int get hashCode => Object.hash(band, ink, soft, deep);
}

/// The station's state colours, mirrored by hand from `docs/agent-station/mockups/tokens.css`
/// (light, and its `.ma-dark` block). The bands keep their fills in dark; only the tints and the
/// text-on-page colours change. [go] is "go forward" (Start work, Save & next call), [stop] is
/// "stop" (End call, Finish work), each with the darker edge the mock-ups draw under the button.
///
/// Read with `context.stateTokens`.
@immutable
class StateTokens extends ThemeExtension<StateTokens> {
  const StateTokens({
    required this.start,
    required this.ready,
    required this.coming,
    required this.onCall,
    required this.happened,
    required this.onBreak,
    required this.over,
    required this.problem,
    required this.quiet,
    required this.go,
    required this.goEdge,
    required this.stop,
    required this.stopEdge,
    required this.onAction,
  });

  final StateColors start;
  final StateColors ready;
  final StateColors coming;
  final StateColors onCall;
  final StateColors happened;
  final StateColors onBreak;
  final StateColors over;
  final StateColors problem;
  final StateColors quiet;
  final Color go;
  final Color goEdge;
  final Color stop;
  final Color stopEdge;

  /// Text on [go] and [stop].
  final Color onAction;

  StateColors of(StationTone tone) => switch (tone) {
        StationTone.start => start,
        StationTone.ready => ready,
        StationTone.coming => coming,
        StationTone.onCall => onCall,
        StationTone.happened => happened,
        StationTone.onBreak => onBreak,
        StationTone.over => over,
        StationTone.problem => problem,
        StationTone.quiet => quiet,
      };

  static const light = StateTokens(
    start: StateColors(band: Color(0xFF2D3047), ink: Color(0xFFFFFFFF), soft: Color(0xFFECEEF4), deep: Color(0xFF2D3047)),
    ready: StateColors(band: Color(0xFF077461), ink: Color(0xFFFFFFFF), soft: Color(0xFFE1F4EF), deep: Color(0xFF06614F)),
    coming: StateColors(band: Color(0xFF0A6FAE), ink: Color(0xFFFFFFFF), soft: Color(0xFFE2F1FB), deep: Color(0xFF085C91)),
    onCall: StateColors(band: Color(0xFF1D4FB8), ink: Color(0xFFFFFFFF), soft: Color(0xFFE6EDFB), deep: Color(0xFF1A45A0)),
    happened: StateColors(band: Color(0xFF6A4DE4), ink: Color(0xFFFFFFFF), soft: Color(0xFFEFEBFD), deep: Color(0xFF5A40CE)),
    onBreak: StateColors(band: Color(0xFFF0B548), ink: Color(0xFF2E1D00), soft: Color(0xFFFDF3DC), deep: Color(0xFF7A4F06)),
    over: StateColors(band: Color(0xFFC2410C), ink: Color(0xFFFFFFFF), soft: Color(0xFFFDE9DF), deep: Color(0xFFA33608)),
    problem: StateColors(band: Color(0xFFBE3440), ink: Color(0xFFFFFFFF), soft: Color(0xFFFBE6E8), deep: Color(0xFFA82A36)),
    quiet: StateColors(band: Color(0xFF4A5165), ink: Color(0xFFFFFFFF), soft: Color(0xFFECEEF2), deep: Color(0xFF3D4356)),
    go: Color(0xFF077461),
    goEdge: Color(0xFF05574A),
    stop: Color(0xFFBE3440),
    stopEdge: Color(0xFF942631),
    onAction: Color(0xFFFFFFFF),
  );

  static const dark = StateTokens(
    start: StateColors(band: Color(0xFF2D3047), ink: Color(0xFFFFFFFF), soft: Color(0xFF23253A), deep: Color(0xFFC9CBE0)),
    ready: StateColors(band: Color(0xFF077461), ink: Color(0xFFFFFFFF), soft: Color(0xFF0E2B26), deep: Color(0xFF3FCF9E)),
    coming: StateColors(band: Color(0xFF0A6FAE), ink: Color(0xFFFFFFFF), soft: Color(0xFF0D2636), deep: Color(0xFF56B8F0)),
    onCall: StateColors(band: Color(0xFF1D4FB8), ink: Color(0xFFFFFFFF), soft: Color(0xFF131F3D), deep: Color(0xFF8FB0FF)),
    happened: StateColors(band: Color(0xFF6A4DE4), ink: Color(0xFFFFFFFF), soft: Color(0xFF1F1A3A), deep: Color(0xFFB9A8FF)),
    onBreak: StateColors(band: Color(0xFFF0B548), ink: Color(0xFF2E1D00), soft: Color(0xFF32270F), deep: Color(0xFFE8A63F)),
    over: StateColors(band: Color(0xFFC2410C), ink: Color(0xFFFFFFFF), soft: Color(0xFF36190C), deep: Color(0xFFFF9A6B)),
    problem: StateColors(band: Color(0xFFBE3440), ink: Color(0xFFFFFFFF), soft: Color(0xFF371418), deep: Color(0xFFEF6B6B)),
    quiet: StateColors(band: Color(0xFF4A5165), ink: Color(0xFFFFFFFF), soft: Color(0xFF1F2128), deep: Color(0xFFB4B4C2)),
    go: Color(0xFF077461),
    goEdge: Color(0xFF05574A),
    stop: Color(0xFFBE3440),
    stopEdge: Color(0xFF942631),
    onAction: Color(0xFFFFFFFF),
  );

  @override
  StateTokens copyWith() => this;

  /// Theme changes snap: a band is one state's colour or the other's, never a blend.
  @override
  StateTokens lerp(covariant StateTokens? other, double t) => other == null || t < 0.5 ? this : other;
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

  /// The station's state colours ([StateTokens]). Always present: both [ThemeData]s carry them.
  StateTokens get stateTokens => Theme.of(this).extension<StateTokens>()!;
}
