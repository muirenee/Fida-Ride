import 'dart:async';

import 'package:fida_location/fida_location.dart';
import 'package:fida_ui/src/map/driver_marker_position.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

final class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    required this.initialLatitude,
    required this.initialLongitude,
    this.activeDrivers = const <String, DriverMarkerPosition>{},
    this.followTrackedLocation = true,
    this.showTrackingControl = true,
  });

  final double initialLatitude;
  final double initialLongitude;
  final Map<String, DriverMarkerPosition> activeDrivers;
  final bool followTrackedLocation;
  final bool showTrackingControl;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

final class _MapScreenState extends State<MapScreen>
    with SingleTickerProviderStateMixin {
  final Completer<GoogleMapController> _mapController =
      Completer<GoogleMapController>();

  late final AnimationController _markerAnimationController;
  LatLng? _displayedLocation;
  LatLng? _animationStart;
  LatLng? _animationTarget;
  double _displayedBearing = 0;

  @override
  void initState() {
    super.initState();
    _markerAnimationController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 350),
    )..addListener(_onMarkerAnimationTick);
  }

  @override
  void dispose() {
    _markerAnimationController
      ..removeListener(_onMarkerAnimationTick)
      ..dispose();
    super.dispose();
  }

  void _onMarkerAnimationTick() {
    final LatLng? start = _animationStart;
    final LatLng? target = _animationTarget;
    if (start == null || target == null) return;

    final double t = Curves.easeOut.transform(_markerAnimationController.value);
    setState(() {
      _displayedLocation = LatLng(
        start.latitude + ((target.latitude - start.latitude) * t),
        start.longitude + ((target.longitude - start.longitude) * t),
      );
    });
  }

  Future<void> _animateTrackedLocation(LocationTrackingActive state) async {
    final LatLng target = LatLng(state.lat, state.lng);
    _animationStart = _displayedLocation ?? target;
    _animationTarget = target;
    _displayedBearing = state.bearing;

    await _markerAnimationController.forward(from: 0);

    if (widget.followTrackedLocation && _mapController.isCompleted) {
      final GoogleMapController controller = await _mapController.future;
      await controller.animateCamera(CameraUpdate.newLatLng(target));
    }
  }

  Set<Marker> _markers() {
    final Set<Marker> markers = widget.activeDrivers.values
        .map<Marker>(
          (DriverMarkerPosition driver) => Marker(
            markerId: MarkerId('driver:${driver.driverId}'),
            position: LatLng(driver.latitude, driver.longitude),
            rotation: driver.bearing,
            flat: true,
            anchor: const Offset(0.5, 0.5),
            icon: BitmapDescriptor.defaultMarkerWithHue(
              BitmapDescriptor.hueAzure,
            ),
          ),
        )
        .toSet();

    final LatLng? current = _displayedLocation;
    if (current != null) {
      markers.add(
        Marker(
          markerId: const MarkerId('tracked-device'),
          position: current,
          rotation: _displayedBearing,
          flat: true,
          anchor: const Offset(0.5, 0.5),
          zIndexInt: 100,
          icon: BitmapDescriptor.defaultMarkerWithHue(
            BitmapDescriptor.hueGreen,
          ),
        ),
      );
    }

    return markers;
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<LocationBloc, LocationState>(
      listenWhen: (LocationState previous, LocationState current) =>
          current is LocationTrackingActive,
      listener: (BuildContext context, LocationState state) {
        if (state is LocationTrackingActive) {
          unawaited(_animateTrackedLocation(state));
        }
      },
      builder: (BuildContext context, LocationState state) {
        return Scaffold(
          body: Stack(
            children: <Widget>[
              GoogleMap(
                initialCameraPosition: CameraPosition(
                  target: LatLng(
                    widget.initialLatitude,
                    widget.initialLongitude,
                  ),
                  zoom: 15,
                ),
                markers: _markers(),
                compassEnabled: true,
                mapToolbarEnabled: false,
                myLocationButtonEnabled: false,
                zoomControlsEnabled: false,
                onMapCreated: (GoogleMapController controller) {
                  if (!_mapController.isCompleted) {
                    _mapController.complete(controller);
                  }
                },
              ),
              if (state is LocationTrackingFailure)
                SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Material(
                      elevation: 4,
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(state.message),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          floatingActionButton: widget.showTrackingControl
              ? FloatingActionButton(
                  onPressed: () {
                    if (state is LocationTrackingActive) {
                      context.read<LocationBloc>().add(const StopTracking());
                    } else {
                      context.read<LocationBloc>().add(const StartTracking());
                    }
                  },
                  child: Icon(
                    state is LocationTrackingActive
                        ? Icons.location_disabled
                        : Icons.my_location,
                  ),
                )
              : null,
        );
      },
    );
  }
}
