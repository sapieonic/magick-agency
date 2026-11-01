import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/firebase_auth_service.dart';
import 'package:magick_agency_agent/core/auth/firebase_token_source.dart';
import 'package:mocktail/mocktail.dart';

import 'support/harness.dart';

class _Auth extends Mock implements FirebaseAuth {}

class _User extends Mock implements User {}

class _Google extends Mock implements GoogleSignIn {}

/// The gate reads ID tokens through [FirebaseAuthService], not the API
/// client: what it answers decides between "signed out" and "offline, retry".
void main() {
  late _Auth auth;
  late _User user;
  late FirebaseAuthService service;

  setUp(() {
    auth = _Auth();
    user = _User();
    when(() => auth.currentUser).thenReturn(user);
    service = FirebaseAuthService(auth, _Google(), testEnv);
  });

  test('a signed-in user gives its token; nobody signed in gives none', () async {
    when(() => user.getIdToken(false)).thenAnswer((_) async => 'tok');
    expect(await service.idToken(), 'tok');
    when(() => auth.currentUser).thenReturn(null);
    expect(await service.idToken(), isNull);
  });

  for (final code in FirebaseIdTokenSource.signInEndedCodes) {
    test('$code: the sign-in is over, so no token (the gate signs out)', () async {
      when(() => user.getIdToken(true)).thenThrow(FirebaseAuthException(code: code));
      expect(await service.idToken(forceRefresh: true), isNull);
    });
  }

  test('offline (network-request-failed) is a network error, never "signed out"', () async {
    when(() => user.getIdToken(false)).thenThrow(FirebaseAuthException(code: 'network-request-failed'));
    await expectLater(service.idToken(), throwsA(isA<ApiNetworkError>()));
  });

  test('any other failure to mint is a network error too', () async {
    when(() => user.getIdToken(false)).thenThrow(FirebaseException(plugin: 'firebase_auth', code: 'internal-error'));
    await expectLater(service.idToken(), throwsA(isA<ApiNetworkError>()));
  });
}
