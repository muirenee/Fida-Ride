import 'dart:convert';

import 'package:fida_security/fida_security.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('telemetry signer matches Go HMAC vector', () {
    final TelemetrySession session = TelemetrySession(
      sessionId: 'session-1',
      keyBytes: List<int>.generate(32, (int index) => index),
      expiresAt: DateTime.utc(2030),
    );
    final TelemetrySigner signer = TelemetrySigner(session: session);

    final SignedTelemetryFields signed = signer.sign(
      driverId: 'driver-1',
      latitude: -1.9441,
      longitude: 30.0619,
      bearing: 125,
      status: 'available',
      now: DateTime.fromMillisecondsSinceEpoch(1790845010000, isUtc: true),
    );

    expect(signed.sequence, 1);
    expect(signed.timestamp, 1790845010000);
    expect(
      signed.signature,
      '08a4960abb7583d9d4f4a78d7d9f435ecabd96f7ac9b6df367cbc61974ce6701',
    );
  });

  test('telemetry session parses server response', () {
    final TelemetrySession session = TelemetrySession.fromJson(
      <String, Object?>{
        'session_id': 'session-1',
        'session_key': base64.encode(List<int>.filled(32, 7)),
        'expires_at': '2030-01-01T00:00:00Z',
      },
    );

    expect(session.sessionId, 'session-1');
    expect(session.keyBytes, hasLength(32));
    expect(session.isExpired, isFalse);
  });
}
