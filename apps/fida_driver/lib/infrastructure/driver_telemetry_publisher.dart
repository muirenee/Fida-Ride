import 'package:fida_api/fida_api.dart';
import 'package:fida_location/fida_location.dart';

typedef DriverStatusProvider = String Function();

final class DriverTelemetryPublisher implements LocationPublisher {
  DriverTelemetryPublisher({
    required TelemetryWebSocketClient telemetryClient,
    required String driverId,
    DriverStatusProvider? statusProvider,
  }) : _telemetryClient = telemetryClient,
       _driverId = driverId,
       _statusProvider = statusProvider ?? _defaultStatus;

  final TelemetryWebSocketClient _telemetryClient;
  final String _driverId;
  final DriverStatusProvider _statusProvider;

  static String _defaultStatus() => 'available';

  @override
  Future<void> publishLocation({
    required double latitude,
    required double longitude,
    required double bearing,
  }) {
    return _telemetryClient.publish(
      DriverTelemetryPacket(
        driverId: _driverId,
        latitude: latitude,
        longitude: longitude,
        bearing: bearing,
        status: _statusProvider(),
      ),
    );
  }
}
