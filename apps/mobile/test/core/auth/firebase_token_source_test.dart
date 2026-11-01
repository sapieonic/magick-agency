import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/firebase_token_source.dart';
import 'package:mocktail/mocktail.dart';

class _Auth extends Mock implements FirebaseAuth {}

class _User extends Mock implements User {}

void main() {
  late _Auth auth;
  late _User user;

  setUp(() {
    auth = _Auth();
    user = _User();
    when(() => auth.currentUser).thenReturn(user);
  });

  test('a signed-in user gives its token', () async {
    when(() => user.getIdToken(false)).thenAnswer((_) async => 'tok');
    expect(await FirebaseIdTokenSource(auth).idToken(), 'tok');
  });

  test('no user is no token', () async {
    when(() => auth.currentUser).thenReturn(null);
    expect(await FirebaseIdTokenSource(auth).idToken(), isNull);
  });

  for (final code in FirebaseIdTokenSource.signInEndedCodes) {
    test('$code: the sign-in is over, so no token (the gate signs out), not a retried error', () async {
      when(() => user.getIdToken(true)).thenThrow(FirebaseAuthException(code: code));
      expect(await FirebaseIdTokenSource(auth).idToken(forceRefresh: true), isNull);
    });
  }

  test('a network failure is still an error (the API layer reads it as offline and retries)', () async {
    when(() => user.getIdToken(false)).thenThrow(FirebaseAuthException(code: 'network-request-failed'));
    expect(FirebaseIdTokenSource(auth).idToken(), throwsA(isA<FirebaseAuthException>()));
  });
}
