import 'package:fida_driver/app/driver_app.dart';
import 'package:flutter/material.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  const String apiBaseUrl = String.fromEnvironment(
    'FIDA_API_BASE_URL',
    defaultValue: 'https://fidaride.netsource.co.rw',
  );
  const String telemetryUrl = String.fromEnvironment(
    'FIDA_TELEMETRY_WS_URL',
    defaultValue: 'wss://fidaride.netsource.co.rw/ws/driver',
  );

  runApp(const DriverApp(apiBaseUrl: apiBaseUrl, telemetryUrl: telemetryUrl));
}
