final class DriverTelemetryPacket {
  const DriverTelemetryPacket({
    required this.driverId,
    required this.latitude,
    required this.longitude,
    required this.bearing,
    required this.status,
  });

  final String driverId;
  final double latitude;
  final double longitude;
  final double bearing;
  final String status;

  Map<String, Object> toJson() => <String, Object>{
    'driver_id': driverId,
    'latitude': latitude,
    'longitude': longitude,
    'bearing': bearing,
    'status': status,
  };
}
