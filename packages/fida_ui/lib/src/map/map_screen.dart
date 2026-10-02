import 'dart:async';
import 'dart:math' as math;

import 'package:fida_location/fida_location.dart';
import 'package:fida_ui/src/map/driver_marker_position.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

const String _defaultTileUrlTemplate = String.fromEnvironment(
  'FIDA_MAP_TILE_URL',
  defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
);

final class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    required this.initialLatitude,
    required this.initialLongitude,
    this.activeDrivers = const <String, DriverMarkerPosition>{},
    this.followTrackedLocation = true,
    this.showTrackingControl = true,
    this.tileUrlTemplate = _defaultTileUrlTemplate,
    this.destinationLatitude,
    this.destinationLongitude,
    this.onMapTap,
  });

  final double initialLatitude;
  final double initialLongitude;
  final Map<String, DriverMarkerPosition> activeDrivers;
  final bool followTrackedLocation;
  final bool showTrackingControl;
  final String tileUrlTemplate;
  final double? destinationLatitude;
  final double? destinationLongitude;
  final void Function(double latitude, double longitude)? onMapTap;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

final class _MapScreenState extends State<MapScreen>
    with SingleTickerProviderStateMixin {
  final MapController _mapController = MapController();

  late final AnimationController _markerAnimationController;
  LatLng? _displayedLocation;
  LatLng? _animationStart;
  LatLng? _animationTarget;
  double _displayedBearing = 0;
  bool _mapReady = false;

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
    _mapController.dispose();
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

    if (widget.followTrackedLocation && _mapReady) {
      _mapController.move(target, _mapController.camera.zoom);
    }
  }

  List<Marker> _markers() {
    final List<Marker> markers = widget.activeDrivers.values
        .map<Marker>(
          (DriverMarkerPosition driver) => Marker(
            point: LatLng(driver.latitude, driver.longitude),
            width: 44,
            height: 44,
            rotate: true,
            child: Transform.rotate(
              angle: driver.bearing * math.pi / 180,
              child: const Icon(
                Icons.navigation,
                color: Colors.blue,
                size: 34,
              ),
            ),
          ),
        )
        .toList(growable: true);

    final LatLng? current = _displayedLocation;
    if (current != null) {
      markers.add(
        Marker(
          point: current,
          width: 48,
          height: 48,
          rotate: true,
          child: Transform.rotate(
            angle: _displayedBearing * math.pi / 180,
            child: const DecoratedBox(
              decoration: BoxDecoration(
                color: Colors.green,
                shape: BoxShape.circle,
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: Colors.black26,
                    blurRadius: 6,
                    offset: Offset(0, 2),
                  ),
                ],
              ),
              child: Icon(
                Icons.navigation,
                color: Colors.white,
                size: 28,
              ),
            ),
          ),
        ),
      );
    }

    final double? destinationLatitude = widget.destinationLatitude;
    final double? destinationLongitude = widget.destinationLongitude;
    if (destinationLatitude != null && destinationLongitude != null) {
      markers.add(
        Marker(
          point: LatLng(destinationLatitude, destinationLongitude),
          width: 48,
          height: 48,
          child: const Icon(
            Icons.location_pin,
            color: Colors.black,
            size: 44,
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
              FlutterMap(
                mapController: _mapController,
                options: MapOptions(
                  initialCenter: LatLng(
                    widget.initialLatitude,
                    widget.initialLongitude,
                  ),
                  initialZoom: 15,
                  minZoom: 3,
                  maxZoom: 19,
                  onMapReady: () {
                    _mapReady = true;
                  },
                  onTap: (TapPosition _, LatLng point) {
                    widget.onMapTap?.call(point.latitude, point.longitude);
                  },
                ),
                children: <Widget>[
                  TileLayer(
                    urlTemplate: widget.tileUrlTemplate,
                    userAgentPackageName: 'com.fidalix.fida_ride',
                    maxZoom: 19,
                  ),
                  MarkerLayer(markers: _markers()),
                  const RichAttributionWidget(
                    showFlutterMapAttribution: false,
                    attributions: <SourceAttribution>[
                      TextSourceAttribution('OpenStreetMap contributors'),
                    ],
                  ),
                ],
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
