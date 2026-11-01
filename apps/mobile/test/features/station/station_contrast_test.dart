import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';

/// WCAG AA for the colour pairs the station draws text with: a state colour on
/// its own tint (the call bands, the queued break, the banners, the action
/// error), and white on a filled button. Body-size text, so 4.5:1 throughout.
void main() {
  double ratio(Color a, Color b) {
    final la = a.computeLuminance();
    final lb = b.computeLuminance();
    final hi = la > lb ? la : lb;
    final lo = la > lb ? lb : la;
    return (hi + 0.05) / (lo + 0.05);
  }

  for (final (name, t) in [('light', AppTokens.light), ('dark', AppTokens.dark)]) {
    group('$name theme', () {
      // A tint is translucent: what the eye sees is it over the page or a card.
      for (final base in [('page', t.bgPrimary), ('card', t.bgSecondary)]) {
        for (final (state, fg, tint) in [
          ('warning', t.warning, t.warningSubtle),
          ('success', t.success, t.successSubtle),
          ('danger', t.danger, t.dangerSubtle),
          ('ember', t.ember, t.emberSubtle),
        ]) {
          test('$state text on its tint over the ${base.$1} is at least 4.5:1', () {
            final ground = Color.alphaBlend(tint, base.$2);
            expect(ratio(fg, ground), greaterThanOrEqualTo(4.5), reason: '$state on ${base.$1}');
          });
        }
      }

      for (final (fill, color) in [('dangerDeep', t.dangerDeep), ('emberDeep', t.emberDeep), ('accent', t.accent)]) {
        test('white on $fill is at least 4.5:1', () {
          expect(ratio(t.onAccent, color), greaterThanOrEqualTo(4.5));
        });
      }
    });
  }
}
