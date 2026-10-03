import 'package:fida_ui/fida_ui.dart';
import 'package:flutter/material.dart';

final class RiderHomeScreen extends StatefulWidget {
  const RiderHomeScreen({super.key});

  @override
  State<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

final class _RiderHomeScreenState extends State<RiderHomeScreen> {
  double? _destinationLatitude;
  double? _destinationLongitude;
  bool _selectingDestination = false;
  String _vehicleType = 'moto';

  bool get _hasDestination =>
      _destinationLatitude != null && _destinationLongitude != null;

  void _startMapSelection() {
    Navigator.of(context).pop();
    setState(() => _selectingDestination = true);
  }

  void _selectDestination(double latitude, double longitude) {
    if (!_selectingDestination) return;
    setState(() {
      _destinationLatitude = latitude;
      _destinationLongitude = longitude;
      _selectingDestination = false;
    });
  }

  void _clearDestination() {
    setState(() {
      _destinationLatitude = null;
      _destinationLongitude = null;
      _selectingDestination = false;
    });
  }

  Future<void> _openDestinationSheet() {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: false,
      backgroundColor: Colors.white,
      builder: (BuildContext context) {
        final EdgeInsets insets = MediaQuery.viewInsetsOf(context);
        return Padding(
          padding: EdgeInsets.fromLTRB(20, 12, 20, 20 + insets.bottom),
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Align(
                  alignment: Alignment.center,
                  child: Container(
                    width: 42,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0xFFD7D7D7),
                      borderRadius: BorderRadius.circular(100),
                    ),
                  ),
                ),
                const SizedBox(height: 22),
                const Text(
                  'Where to?',
                  style: TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.7,
                  ),
                ),
                const SizedBox(height: 18),
                const _LocationField(
                  icon: Icons.radio_button_checked,
                  iconColor: Color(0xFF17A85B),
                  title: 'Current location',
                  subtitle: 'Using your device location',
                ),
                const SizedBox(height: 10),
                const _LocationField(
                  icon: Icons.search,
                  iconColor: Colors.black,
                  title: 'Search destination',
                  subtitle: 'Address search is coming next',
                ),
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: _startMapSelection,
                  icon: const Icon(Icons.add_location_alt_outlined),
                  label: const Text('Choose destination on map'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                    minimumSize: const Size.fromHeight(54),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  'For this test build, tap the map to pin your destination. Address search and saved places will be connected to the geocoding service in the next step.',
                  style: TextStyle(
                    color: Colors.grey.shade600,
                    fontSize: 12,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: MapScreen(
              initialLatitude: -1.9441,
              initialLongitude: 30.0619,
              followTrackedLocation: true,
              showTrackingControl: false,
              destinationLatitude: _destinationLatitude,
              destinationLongitude: _destinationLongitude,
              onMapTap: _selectDestination,
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(
                children: <Widget>[
                  _RoundActionButton(
                    icon: Icons.menu_rounded,
                    onPressed: () {},
                    semanticLabel: 'Menu',
                  ),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 10,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(24),
                      boxShadow: const <BoxShadow>[
                        BoxShadow(
                          color: Color(0x22000000),
                          blurRadius: 16,
                          offset: Offset(0, 5),
                        ),
                      ],
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.shield_outlined, size: 18),
                        SizedBox(width: 7),
                        Text(
                          'Fida Ride',
                          style: TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_selectingDestination)
            Positioned(
              left: 16,
              right: 16,
              top: MediaQuery.paddingOf(context).top + 74,
              child: Material(
                color: Colors.black,
                borderRadius: BorderRadius.circular(14),
                elevation: 8,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 13,
                  ),
                  child: Row(
                    children: <Widget>[
                      const Expanded(
                        child: Text(
                          'Tap the map to set your destination',
                          style: TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        onPressed: () =>
                            setState(() => _selectingDestination = false),
                        icon: const Icon(Icons.close, color: Colors.white),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: _HomePanel(
              hasDestination: _hasDestination,
              destinationLatitude: _destinationLatitude,
              destinationLongitude: _destinationLongitude,
              vehicleType: _vehicleType,
              onVehicleTypeChanged: (String value) {
                setState(() => _vehicleType = value);
              },
              onDestinationPressed: _openDestinationSheet,
              onClearDestination: _clearDestination,
            ),
          ),
        ],
      ),
    );
  }
}

final class _HomePanel extends StatelessWidget {
  const _HomePanel({
    required this.hasDestination,
    required this.destinationLatitude,
    required this.destinationLongitude,
    required this.vehicleType,
    required this.onVehicleTypeChanged,
    required this.onDestinationPressed,
    required this.onClearDestination,
  });

  final bool hasDestination;
  final double? destinationLatitude;
  final double? destinationLongitude;
  final String vehicleType;
  final ValueChanged<String> onVehicleTypeChanged;
  final VoidCallback onDestinationPressed;
  final VoidCallback onClearDestination;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      elevation: 18,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Align(
                alignment: Alignment.center,
                child: Container(
                  width: 42,
                  height: 4,
                  decoration: BoxDecoration(
                    color: const Color(0xFFD8D8D8),
                    borderRadius: BorderRadius.circular(100),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              if (!hasDestination) ...<Widget>[
                const Text(
                  'Where are you going?',
                  style: TextStyle(
                    fontSize: 23,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.6,
                  ),
                ),
                const SizedBox(height: 13),
                InkWell(
                  onTap: onDestinationPressed,
                  borderRadius: BorderRadius.circular(16),
                  child: Ink(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 15,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF3F3F3),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: const Row(
                      children: <Widget>[
                        Icon(Icons.search, size: 24),
                        SizedBox(width: 11),
                        Expanded(
                          child: Text(
                            'Where to?',
                            style: TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        Icon(Icons.arrow_forward_ios_rounded, size: 16),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: <Widget>[
                    const Icon(
                      Icons.my_location,
                      color: Color(0xFF17A85B),
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      'Pickup: Current location',
                      style: TextStyle(
                        color: Colors.grey.shade700,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ] else ...<Widget>[
                Row(
                  children: <Widget>[
                    const Expanded(
                      child: Text(
                        'Choose your ride',
                        style: TextStyle(
                          fontSize: 23,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.6,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: onClearDestination,
                      child: const Text('Change'),
                    ),
                  ],
                ),
                Text(
                  'Pinned destination  •  '
                  '${destinationLatitude!.toStringAsFixed(5)}, '
                  '${destinationLongitude!.toStringAsFixed(5)}',
                  style: TextStyle(
                    color: Colors.grey.shade600,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: _RideOption(
                        value: 'moto',
                        label: 'Moto',
                        icon: Icons.two_wheeler,
                        selected: vehicleType == 'moto',
                        onTap: onVehicleTypeChanged,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _RideOption(
                        value: 'taxi',
                        label: 'Taxi',
                        icon: Icons.local_taxi,
                        selected: vehicleType == 'taxi',
                        onTap: onVehicleTypeChanged,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _RideOption(
                        value: 'premium',
                        label: 'Premium',
                        icon: Icons.directions_car_filled,
                        selected: vehicleType == 'premium',
                        onTap: onVehicleTypeChanged,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                FilledButton(
                  onPressed: onDestinationPressed,
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                    minimumSize: const Size.fromHeight(54),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: const Text(
                    'Continue',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

final class _RideOption extends StatelessWidget {
  const _RideOption({
    required this.value,
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String value;
  final String label;
  final IconData icon;
  final bool selected;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onTap(value),
      borderRadius: BorderRadius.circular(14),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: selected ? Colors.black : const Color(0xFFF4F4F4),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, color: selected ? Colors.white : Colors.black),
            const SizedBox(height: 5),
            Text(
              label,
              style: TextStyle(
                color: selected ? Colors.white : Colors.black,
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _LocationField extends StatelessWidget {
  const _LocationField({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      decoration: BoxDecoration(
        color: const Color(0xFFF4F4F4),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, color: iconColor, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

final class _RoundActionButton extends StatelessWidget {
  const _RoundActionButton({
    required this.icon,
    required this.onPressed,
    required this.semanticLabel,
  });

  final IconData icon;
  final VoidCallback onPressed;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: Colors.white,
        shape: const CircleBorder(),
        elevation: 5,
        child: IconButton(
          onPressed: onPressed,
          icon: Icon(icon),
        ),
      ),
    );
  }
}
