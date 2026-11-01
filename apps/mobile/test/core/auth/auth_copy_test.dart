import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/auth_copy.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';

void main() {
  String msg(String code, [AuthAction action = AuthAction.signIn]) => authErrorMessage(AuthFailure(code), action: action);

  test('a wrong password reads differently on the sign-in and invite pages', () {
    for (final code in ['wrong-password', 'invalid-credential', 'invalid-login-credentials']) {
      expect(msg(code), 'That email and password don\'t match. Try again, or reset your password.');
      expect(msg(code, AuthAction.invite), 'That password does not match this address. Try again, or use Google instead.');
    }
  });

  test('user-not-found: no account on sign-in and reset; "create one" on the invite', () {
    expect(msg('user-not-found'), 'No account found with this email address');
    expect(msg('user-not-found', AuthAction.passwordReset), 'No account found with this email address');
    expect(msg('user-not-found', AuthAction.invite), 'That address has no password yet. Create one below.');
    expect(msg('invalid-email', AuthAction.passwordReset), 'No account found with this email address');
  });

  test('the console\'s copy for throttling, network, weak password and an existing password', () {
    expect(msg('too-many-requests'), 'Too many attempts. Wait a minute and try again.');
    expect(msg('network-request-failed'), 'We could not reach the network. Check your connection and try again.');
    expect(msg('weak-password', AuthAction.invite), 'That password is too easy to guess. Make it longer.');
    expect(
      msg('email-already-in-use', AuthAction.invite),
      'That address already has a password. Enter it and we will add this workspace to it.',
    );
  });

  test('Google outcomes and an unconfigured build have their own sentences', () {
    expect(msg(AuthFailure.cancelled), 'The Google window closed before you finished. Try again.');
    expect(msg('google-unavailable'), contains('Use your email and password'));
    expect(msg('google-config'), contains('isn\'t set up'));
    expect(msg(AuthFailure.notConfigured), contains('can\'t sign anyone in'));
  });

  test('an unknown code never shows the SDK\'s developer message', () {
    expect(authErrorMessage(const AuthFailure('internal-error', 'Firebase: Error (auth/internal-error).')),
        'That did not work. Try again.');
  });
}
