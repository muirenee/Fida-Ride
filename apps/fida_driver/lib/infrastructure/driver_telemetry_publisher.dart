import 'package:fida_api/fida_api.dart';
import 'package:fida_location/fida_location.dart';
import 'package:fida_security/fida_security.dart';

typedef DriverStatusProvider = String Function();

final class DriverTelemetryPublisher implements LocationPublisher {
  DriverTelemetryPublisher({
    required TelemetryWebSocketClient telemetryClient,
    required TelemetrySigner telemetrySigner,
    required String driverId,
    DriverStatusProvider? statusProvider,
  }) : _telemetryClient = telemetryClient,
       _telemetrySigner = telemetrySigner,
       _driverId = driverId,
       _statusProvider = statusProvider ?? _defaultStatus;

  final TelemetryWebSocketClient _telemetryClient;
  final TelemetrySigner _telemetrySigner;
  final String _driverId;
  final DriverStatusProvider _statusProvider;

  static String _defaultStatus() => 'available';

  @override
  Future<void> publishLocation({
    required double latitude,
    required double longitude,
    required double bearing,
  }) {
    final String status = _statusProvider();
    final SignedTelemetryFields signed = _telemetrySigner.sign(
      driverId: _driverId,
      latitude: latitude,
      longitude: longitude,
      bearing: bearing,
      status: status,
    );

    return _telemetryClient.publish(
      DriverTelemetryPacket(
        driverId: _driverId,
        latitude: latitude,
        longitude: longitude,
        bearing: bearing,
        status: status,
        sessionId: signed.sessionId,
        timestamp: signed.timestamp,
        sequence: signed.sequence,
        signature: signed.signature,
      ),
    );
  }
}
