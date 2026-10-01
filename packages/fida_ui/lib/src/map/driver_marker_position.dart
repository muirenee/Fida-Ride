final class DriverMarkerPosition {
  const DriverMarkerPosition({
    required this.driverId,
    required this.latitude,
    required this.longitude,
    this.bearing = 0,
  });

  final String driverId;
  final double latitude;
  final double longitude;
  final double bearing;
}
