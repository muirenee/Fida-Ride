import 'dart:async';

import 'package:fida_location/src/location_publisher.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:geolocator/geolocator.dart';

sealed class LocationEvent {
  const LocationEvent();
}

final class StartTracking extends LocationEvent {
  const StartTracking();
}

final class LocationUpdated extends LocationEvent {
  const LocationUpdated(this.lat, this.lng, this.bearing);

  final double lat;
  final double lng;
  final double bearing;
}

final class StopTracking extends LocationEvent {
  const StopTracking();
}

final class _LocationStreamFailed extends LocationEvent {
  const _LocationStreamFailed(this.message);

  final String message;
}

sealed class LocationState {
  const LocationState();
}

final class LocationInitial extends LocationState {
  const LocationInitial();
}

final class LocationTrackingActive extends LocationState {
  const LocationTrackingActive({
    required this.lat,
    required this.lng,
    required this.bearing,
    required this.updatedAt,
  });

  final double lat;
  final double lng;
  final double bearing;
  final DateTime updatedAt;
}

final class LocationTrackingFailure extends LocationState {
  const LocationTrackingFailure(this.message);

  final String message;
}

final class LocationBloc extends Bloc<LocationEvent, LocationState> {
  LocationBloc({
    LocationPublisher? publisher,
    LocationSettings? locationSettings,
  })  : _publisher = publisher,
        _locationSettings = locationSettings ??
            const LocationSettings(
              accuracy: LocationAccuracy.bestForNavigation,
              distanceFilter: 5,
            ),
        super(const LocationInitial()) {
    on<StartTracking>(_onStartTracking);
    on<LocationUpdated>(_onLocationUpdated);
    on<StopTracking>(_onStopTracking);
    on<_LocationStreamFailed>(_onLocationStreamFailed);
  }

  final LocationPublisher? _publisher;
  final LocationSettings _locationSettings;
  StreamSubscription<Position>? _positionSubscription;

  Future<void> _onStartTracking(
    StartTracking event,
    Emitter<LocationState> emit,
  ) async {
    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        emit(const LocationTrackingFailure('Location services are disabled.'));
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }

      if (permission == LocationPermission.denied) {
        emit(const LocationTrackingFailure('Location permission was denied.'));
        return;
      }

      if (permission == LocationPermission.deniedForever) {
        emit(
          const LocationTrackingFailure(
            'Location permission is permanently denied. Enable it in system settings.',
          ),
        );
        return;
      }

      await _positionSubscription?.cancel();
      _positionSubscription = Geolocator.getPositionStream(
        locationSettings: _locationSettings,
      ).listen(
        (Position position) {
          final double heading = position.heading.isFinite && position.heading >= 0
              ? position.heading
              : 0.0;
          add(
            LocationUpdated(
              position.latitude,
              position.longitude,
              heading,
            ),
          );
        },
        onError: (Object error, StackTrace stackTrace) {
          add(_LocationStreamFailed(error.toString()));
        },
        cancelOnError: false,
      );
    } catch (error) {
      emit(LocationTrackingFailure(error.toString()));
    }
  }

  Future<void> _onLocationUpdated(
    LocationUpdated event,
    Emitter<LocationState> emit,
  ) async {
    emit(
      LocationTrackingActive(
        lat: event.lat,
        lng: event.lng,
        bearing: _normalizeBearing(event.bearing),
        updatedAt: DateTime.now().toUtc(),
      ),
    );

    final LocationPublisher? publisher = _publisher;
    if (publisher == null) return;

    try {
      await publisher.publishLocation(
        latitude: event.lat,
        longitude: event.lng,
        bearing: _normalizeBearing(event.bearing),
      );
    } catch (error) {
      emit(LocationTrackingFailure('Location publish failed: $error'));
    }
  }

  Future<void> _onStopTracking(
    StopTracking event,
    Emitter<LocationState> emit,
  ) async {
    await _positionSubscription?.cancel();
    _positionSubscription = null;
    emit(const LocationInitial());
  }

  Future<void> _onLocationStreamFailed(
    _LocationStreamFailed event,
    Emitter<LocationState> emit,
  ) async {
    emit(LocationTrackingFailure(event.message));
  }

  double _normalizeBearing(double bearing) {
    if (!bearing.isFinite) return 0.0;
    final double normalized = bearing % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  @override
  Future<void> close() async {
    await _positionSubscription?.cancel();
    return super.close();
  }
}
