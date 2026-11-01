import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../app/providers.dart';
import 'auth_service.dart';
import 'firebase_auth_service.dart';

/// The app's [AuthService]: Firebase when the build carries its config
/// (`main.dart` initialises Firebase in exactly that case), otherwise one that
/// signs nobody in. Tests override it with `FakeAuthService`.
final authServiceProvider = Provider<AuthService>((ref) {
  final env = ref.watch(envProvider);
  if (!env.hasFirebase) return const UnconfiguredAuthService();
  return FirebaseAuthService(FirebaseAuth.instance, GoogleSignIn.instance, env);
});
