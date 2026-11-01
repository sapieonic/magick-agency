import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';

/// The invite page's words and small rules, in the console's wording
/// (`utils/agencyInviteJoinCopy.ts`) so an invitation reads the same in the
/// app and on the web.

String roleLabel(AgencyInvite invite) => switch (invite.role) {
      Role.agent => 'Agent',
      Role.viewer => 'Viewer',
      Role.operator => 'Operator',
      Role.accountAdmin => 'Account admin',
      Role.tenantAdmin => 'Workspace admin',
      Role.tenantOwner => 'Workspace owner',
      // A role the server added after this build: show it as itself.
      Role.unknown => invite.roleRaw,
    };

/// "an Agent", "an Operator", "a Viewer".
String withArticle(String label) => '${RegExp('^[AEIOUaeiou]').hasMatch(label) ? 'an' : 'a'} $label';

/// Compared trimmed and case-insensitively, and nothing more: the server
/// matches the exact string, so Gmail's dot and `+tag` equivalences are NOT
/// normalised away here.
bool sameAddress(String? a, String b) => a != null && a.trim().toLowerCase() == b.trim().toLowerCase();

/// How a password being created is doing, while it is typed.
@immutable
class PasswordAssessment {
  const PasswordAssessment({required this.score, required this.blocker, required this.hint});

  /// 0–4, for the meter.
  final int score;

  /// Why it cannot be submitted, or null when it can.
  final String? blocker;

  /// Advice; never a reason to refuse.
  final String hint;

  @override
  bool operator ==(Object other) =>
      other is PasswordAssessment && other.score == score && other.blocker == blocker && other.hint == hint;
  @override
  int get hashCode => Object.hash(score, blocker, hint);
}

const strengthLabels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/// Eight characters, stated up front and checked before the network, and
/// not the bit of the address before the @ (pre-filled, on screen, and the
/// likeliest thing anybody types). Everything else is advice.
PasswordAssessment assessPassword(String password, String email) {
  final local = email.split('@').first;
  if (password.isEmpty) {
    return const PasswordAssessment(score: 0, blocker: 'Choose a password.', hint: 'At least 8 characters.');
  }
  if (password.length < 8) {
    return PasswordAssessment(
      score: 0,
      blocker: 'At least 8 characters — ${8 - password.length} to go.',
      hint: 'At least 8 characters.',
    );
  }
  if (local.length >= 3 && password.toLowerCase().contains(local.toLowerCase())) {
    return const PasswordAssessment(
      score: 1,
      blocker: 'That contains your own address. Pick something unrelated to it.',
      hint: 'Pick something unrelated to your address.',
    );
  }
  final score = (password.length >= 12 ? 1 : 0) +
      (RegExp('[a-z]').hasMatch(password) && RegExp('[A-Z]').hasMatch(password) ? 1 : 0) +
      (RegExp(r'\d').hasMatch(password) ? 1 : 0) +
      (RegExp('[^A-Za-z0-9]').hasMatch(password) ? 1 : 0);
  final hint = score >= 3
      ? 'Strong enough. You will not be asked for it again on this device.'
      : password.length < 12
          ? 'Longer is the easiest way to make this stronger — try three unrelated words.'
          : 'Add a number or a symbol to make this stronger.';
  return PasswordAssessment(score: score < 1 ? 1 : score, blocker: null, hint: hint);
}

/// A screen for an invitation that cannot be used.
@immutable
class UnavailableCopy {
  const UnavailableCopy({required this.title, required this.body, required this.offersSignIn});
  final String title;
  final String body;

  /// Signing in is the whole remedy (already used, already set up).
  final bool offersSignIn;
}

/// Each reason gets its own words and its own way out: an expired invite
/// needs a resend, a claimed one means they already did this, a revoked one
/// was a decision, a not-found one is usually a link broken across two lines.
UnavailableCopy unavailableCopy(InviteStatus status) => switch (status) {
      InviteStatus.expired => const UnavailableCopy(
          title: 'This invitation has expired',
          body: 'Invitations are only good for a few days. Ask your supervisor to send a new one — it will arrive at '
              'the same address and work the same way.',
          offersSignIn: false,
        ),
      InviteStatus.claimed => const UnavailableCopy(
          title: 'This invitation has already been used',
          body: 'The workspace is set up and waiting for you. Sign in with the account you created and your station '
              'will open.',
          offersSignIn: true,
        ),
      InviteStatus.revoked => const UnavailableCopy(
          title: 'This invitation is no longer valid',
          body: 'It was withdrawn before it was used. Your supervisor will know why, and can send a new one if it was '
              'withdrawn by mistake.',
          offersSignIn: false,
        ),
      InviteStatus.identityAlreadyBound => const UnavailableCopy(
          title: 'You are already set up',
          body: 'This address already has an account, so there is nothing left to accept. Sign in and your station '
              'will open. If signing in does not work, ask your supervisor to send a new invitation.',
          offersSignIn: true,
        ),
      // not_found, and anything this build does not know.
      _ => const UnavailableCopy(
          title: 'We cannot find that invitation',
          body: 'Links like this are long, and email programs often break them across two lines. Go back to the '
              'message and copy the whole link, or ask your supervisor to send it again.',
          offersSignIn: false,
        ),
    };

const unreachableTitle = 'We could not open your invitation';
const unreachableBody =
    'The link looks fine — we just could not reach us to read it. This is usually the connection rather than the '
    'invitation.';

/// An invitation for a seat the app does not serve (it is for agents only).
const wrongAppTitle = 'Open this invitation on a computer';
String wrongAppBody(String role) =>
    'This invitation is for ${withArticle(role)} seat, which is set up in the web console rather than this app. '
    'Open the link from the email on a computer to accept it.';
