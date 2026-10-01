import 'package:fida_driver/infrastructure/driver_telemetry_publisher.dart';
import 'package:fida_location/fida_location.dart';
import 'package:fida_ui/fida_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

final class DriverApp extends StatelessWidget {
  const DriverApp({super.key, required this.telemetryPublisher});

  final DriverTelemetryPublisher telemetryPublisher;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fida Driver',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.green),
        useMaterial3: true,
      ),
      home: BlocProvider<LocationBloc>(
        create: (BuildContext context) =>
            LocationBloc(publisher: telemetryPublisher)
              ..add(const StartTracking()),
        child: const MapScreen(
          initialLatitude: -1.9441,
          initialLongitude: 30.0619,
          followTrackedLocation: true,
          showTrackingControl: true,
        ),
      ),
    );
  }
}
