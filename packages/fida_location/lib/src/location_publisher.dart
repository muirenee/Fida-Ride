abstract interface class LocationPublisher {
  Future<void> publishLocation({
    required double latitude,
    required double longitude,
    required double bearing,
  });
}
