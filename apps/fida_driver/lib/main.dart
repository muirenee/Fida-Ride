import 'dart:convert';

import 'package:fida_api/fida_api.dart';
import 'package:fida_driver/app/driver_app.dart';
import 'package:fida_driver/infrastructure/driver_telemetry_publisher.dart';
import 'package:fida_security/fida_security.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const String telemetryUrl = String.fromEnvironment(
    'FIDA_TELEMETRY_WS_URL',
    defaultValue: 'ws://10.0.2.2:8080/ws/driver',
  );
  const String accessToken = String.fromEnvironment('FIDA_ACCESS_TOKEN');
  const String driverId = String.fromEnvironment('FIDA_DRIVER_ID');
  const String telemetrySessionId = String.fromEnvironment(
    'FIDA_TELEMETRY_SESSION_ID',
  );
  const String telemetrySessionKey = String.fromEnvironment(
    'FIDA_TELEMETRY_SESSION_KEY',
  );
  const String telemetrySessionExpiresAt = String.fromEnvironment(
    'FIDA_TELEMETRY_SESSION_EXPIRES_AT',
  );

  final DateTime? expiresAt = DateTime.tryParse(telemetrySessionExpiresAt)
      ?.toUtc();
  List<int>? keyBytes;
  try {
    if (telemetrySessionKey.isNotEmpty) {
      keyBytes = base64.decode(telemetrySessionKey);
    }
  } on FormatException {
    keyBytes = null;
  }

  if (accessToken.isEmpty ||
      driverId.isEmpty ||
      telemetrySessionId.isEmpty ||
      keyBytes == null ||
      keyBytes.length != 32 ||
      expiresAt == null) {
    runApp(const _MissingSessionApp());
    return;
  }

  final TelemetrySession telemetrySession = TelemetrySession(
    sessionId: telemetrySessionId,
    keyBytes: keyBytes,
    expiresAt: expiresAt,
  );

  final TelemetryWebSocketClient telemetryClient = TelemetryWebSocketClient(
    endpoint: Uri.parse(telemetryUrl),
    accessToken: accessToken,
  );

  final DriverTelemetryPublisher publisher = DriverTelemetryPublisher(
    telemetryClient: telemetryClient,
    telemetrySigner: TelemetrySigner(session: telemetrySession),
    driverId: driverId,
  );

  runApp(DriverApp(telemetryPublisher: publisher));
}

final class _MissingSessionApp extends StatelessWidget {
  const _MissingSessionApp();

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Driver security session is not configured. Authenticate and obtain a rotating telemetry session first. '
              'For local development provide FIDA_ACCESS_TOKEN, FIDA_DRIVER_ID, FIDA_TELEMETRY_SESSION_ID, '
              'FIDA_TELEMETRY_SESSION_KEY and FIDA_TELEMETRY_SESSION_EXPIRES_AT.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      ),
    );
  }
}
