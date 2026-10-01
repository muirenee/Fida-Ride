import 'package:fida_api/fida_api.dart';
import 'package:fida_driver/app/driver_app.dart';
import 'package:fida_driver/infrastructure/driver_telemetry_publisher.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const String telemetryUrl = String.fromEnvironment(
    'FIDA_TELEMETRY_WS_URL',
    defaultValue: 'ws://10.0.2.2:8080/ws/driver',
  );
  const String accessToken = String.fromEnvironment('FIDA_ACCESS_TOKEN');
  const String driverId = String.fromEnvironment('FIDA_DRIVER_ID');

  if (accessToken.isEmpty || driverId.isEmpty) {
    runApp(const _MissingSessionApp());
    return;
  }

  final TelemetryWebSocketClient telemetryClient = TelemetryWebSocketClient(
    endpoint: Uri.parse(telemetryUrl),
    accessToken: accessToken,
  );

  final DriverTelemetryPublisher publisher = DriverTelemetryPublisher(
    telemetryClient: telemetryClient,
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
              'Driver session is not configured. Authenticate first or provide '
              'FIDA_ACCESS_TOKEN and FIDA_DRIVER_ID as --dart-define values for local development.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      ),
    );
  }
}
