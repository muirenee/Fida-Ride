import 'package:fida_location/fida_location.dart';
import 'package:fida_rider/app/rider_home_screen.dart';
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
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF17A85B)),
        scaffoldBackgroundColor: Colors.white,
        useMaterial3: true,
      ),
      home: BlocProvider<LocationBloc>(
        create: (BuildContext context) =>
            LocationBloc()..add(const StartTracking()),
        child: const RiderHomeScreen(),
      ),
    );
  }
}
