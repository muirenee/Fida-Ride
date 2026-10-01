final class DriverTelemetryPacket {
  const DriverTelemetryPacket({
    required this.driverId,
    required this.latitude,
    required this.longitude,
    required this.bearing,
    required this.status,
    required this.sessionId,
    required this.timestamp,
    required this.sequence,
    required this.signature,
  });

  final String driverId;
  final double latitude;
  final double longitude;
  final double bearing;
  final String status;
  final String sessionId;

  /// Unix epoch milliseconds, signed as part of the telemetry envelope.
  final int timestamp;
  final int sequence;
  final String signature;

  Map<String, Object> toJson() => <String, Object>{
    'driver_id': driverId,
    'latitude': latitude,
    'longitude': longitude,
    'bearing': bearing,
    'status': status,
    'session_id': sessionId,
    'timestamp': timestamp,
    'sequence': sequence,
    'signature': signature,
  };
}
