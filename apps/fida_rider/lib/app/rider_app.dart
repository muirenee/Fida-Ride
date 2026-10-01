import 'package:fida_location/fida_location.dart';
import 'package:fida_ui/fida_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

final class RiderApp extends StatelessWidget {
  const RiderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fida Ride',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.green),
        useMaterial3: true,
      ),
      home: BlocProvider<LocationBloc>(
        create: (BuildContext context) =>
            LocationBloc()..add(const StartTracking()),
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
