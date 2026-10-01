import 'dart:convert';

import 'package:crypto/crypto.dart';

final class TelemetrySession {
  TelemetrySession({
    required this.sessionId,
    required this.keyBytes,
    required this.expiresAt,
  }) {
    if (sessionId.isEmpty) throw ArgumentError.value(sessionId, 'sessionId');
    if (keyBytes.length != 32) {
      throw ArgumentError.value(
        keyBytes.length,
        'keyBytes.length',
        'Expected a 256-bit session key.',
      );
    }
  }

  factory TelemetrySession.fromJson(Map<String, Object?> json) {
    final Object? sessionIdValue = json['session_id'];
    final Object? sessionKeyValue = json['session_key'];
    final Object? expiresAtValue = json['expires_at'];

    if (sessionIdValue is! String || sessionIdValue.isEmpty) {
      throw const FormatException('Missing telemetry session_id.');
    }
    if (sessionKeyValue is! String || sessionKeyValue.isEmpty) {
      throw const FormatException('Missing telemetry session_key.');
    }
    if (expiresAtValue is! String) {
      throw const FormatException('Missing telemetry expires_at.');
    }

    final List<int> keyBytes;
    try {
      keyBytes = base64.decode(sessionKeyValue);
    } on FormatException catch (error) {
      throw FormatException('Invalid telemetry session_key encoding.', error);
    }

    final DateTime? expiresAt = DateTime.tryParse(expiresAtValue)?.toUtc();
    if (expiresAt == null) {
      throw const FormatException('Invalid telemetry expires_at.');
    }

    return TelemetrySession(
      sessionId: sessionIdValue,
      keyBytes: List<int>.unmodifiable(keyBytes),
      expiresAt: expiresAt,
    );
  }

  final String sessionId;
  final List<int> keyBytes;
  final DateTime expiresAt;

  bool get isExpired => !DateTime.now().toUtc().isBefore(expiresAt);
}

final class SignedTelemetryFields {
  const SignedTelemetryFields({
    required this.sessionId,
    required this.timestamp,
    required this.sequence,
    required this.signature,
  });

  final String sessionId;
  final int timestamp;
  final int sequence;
  final String signature;
}

final class TelemetrySigner {
  TelemetrySigner({required TelemetrySession session}) : _session = session;

  final TelemetrySession _session;
  int _sequence = 0;

  SignedTelemetryFields sign({
    required String driverId,
    required double latitude,
    required double longitude,
    required double bearing,
    required String status,
    DateTime? now,
  }) {
    if (_session.isExpired) {
      throw StateError('Telemetry signing session has expired.');
    }

    final int timestamp =
        (now ?? DateTime.now().toUtc()).millisecondsSinceEpoch;
    final int sequence = ++_sequence;
    final String canonical = canonicalTelemetryPayload(
      sessionId: _session.sessionId,
      driverId: driverId,
      latitude: latitude,
      longitude: longitude,
      bearing: bearing,
      status: status,
      timestamp: timestamp,
      sequence: sequence,
    );

    final Digest digest = Hmac(
      sha256,
      _session.keyBytes,
    ).convert(utf8.encode(canonical));
    return SignedTelemetryFields(
      sessionId: _session.sessionId,
      timestamp: timestamp,
      sequence: sequence,
      signature: digest.toString(),
    );
  }
}

String canonicalTelemetryPayload({
  required String sessionId,
  required String driverId,
  required double latitude,
  required double longitude,
  required double bearing,
  required String status,
  required int timestamp,
  required int sequence,
}) {
  if (sessionId.isEmpty || driverId.isEmpty || status.isEmpty) {
    throw ArgumentError(
      'Telemetry identity, session and status must be non-empty.',
    );
  }
  if (!latitude.isFinite || latitude < -90 || latitude > 90) {
    throw ArgumentError.value(latitude, 'latitude');
  }
  if (!longitude.isFinite || longitude < -180 || longitude > 180) {
    throw ArgumentError.value(longitude, 'longitude');
  }
  if (!bearing.isFinite || bearing < 0 || bearing >= 360) {
    throw ArgumentError.value(bearing, 'bearing');
  }
  if (timestamp <= 0 || sequence <= 0) {
    throw ArgumentError('Telemetry timestamp and sequence must be positive.');
  }

  return <String>[
    'v1',
    sessionId,
    driverId,
    latitude.toStringAsFixed(7),
    longitude.toStringAsFixed(7),
    bearing.toStringAsFixed(2),
    status,
    timestamp.toString(),
    sequence.toString(),
  ].join('\n');
}
