import 'auth_service.dart';

/// Where a Firebase failure is being explained: the wording of a few codes
/// depends on what the person was doing.
enum AuthAction { signIn, passwordReset, invite }

/// A Firebase failure as a sentence for the agent, in the console's words
/// (`agencyInviteJoinCopy.credentialMessage`, the sign-in and reset pages).
/// Firebase's own messages are written for developers, so they are never
/// shown; an unrecognised code gets a plain retry line.
String authErrorMessage(AuthFailure failure, {AuthAction action = AuthAction.signIn}) {
  switch (failure.code) {
    case 'wrong-password':
    case 'invalid-credential':
    case 'invalid-login-credentials':
      return action == AuthAction.invite
          ? 'That password does not match this address. Try again, or use Google instead.'
          : 'That email and password don\'t match. Try again, or reset your password.';
    case 'user-not-found':
      return switch (action) {
        AuthAction.invite => 'That address has no password yet. Create one below.',
        _ => 'No account found with this email address',
      };
    case 'invalid-email':
      return action == AuthAction.passwordReset
          ? 'No account found with this email address'
          : 'That doesn\'t look like an email address. Check it and try again.';
    case 'user-disabled':
      return 'This account has been switched off. Ask your supervisor.';
    case 'too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'network-request-failed':
      return 'We could not reach the network. Check your connection and try again.';
    case 'weak-password':
      return 'That password is too easy to guess. Make it longer.';
    case 'email-already-in-use':
      return 'That address already has a password. Enter it and we will add this organisation to it.';
    case AuthFailure.cancelled:
      return 'The Google window closed before you finished. Try again.';
    case 'google-unavailable':
      return 'Google sign-in isn\'t available on this phone. Use your email and password instead.';
    case 'google-config':
    case 'google-no-token':
      return 'Google sign-in isn\'t set up for this app yet. Use your email and password instead.';
    case AuthFailure.notConfigured:
      return 'This build of the app can\'t sign anyone in. Install it from the store.';
    default:
      return 'That did not work. Try again.';
  }
}
