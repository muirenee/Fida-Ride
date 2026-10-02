import 'package:fida_api/fida_api.dart';
import 'package:fida_driver/infrastructure/driver_telemetry_publisher.dart';
import 'package:fida_location/fida_location.dart';
import 'package:fida_security/fida_security.dart';
import 'package:fida_ui/fida_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

final class DriverApp extends StatefulWidget {
  const DriverApp({
    super.key,
    required this.apiBaseUrl,
    required this.telemetryUrl,
  });

  final String apiBaseUrl;
  final String telemetryUrl;

  @override
  State<DriverApp> createState() => _DriverAppState();
}

final class _DriverAppState extends State<DriverApp> {
  DriverTelemetryPublisher? _telemetryPublisher;

  void _onAuthenticated(DriverTelemetryPublisher publisher) {
    setState(() => _telemetryPublisher = publisher);
  }

  @override
  Widget build(BuildContext context) {
    final DriverTelemetryPublisher? publisher = _telemetryPublisher;

    return MaterialApp(
      title: 'Fida Driver',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.green),
        useMaterial3: true,
      ),
      home: publisher == null
          ? _DriverSignInScreen(
              apiBaseUrl: widget.apiBaseUrl,
              telemetryUrl: widget.telemetryUrl,
              onAuthenticated: _onAuthenticated,
            )
          : BlocProvider<LocationBloc>(
              create: (BuildContext context) =>
                  LocationBloc(publisher: publisher)
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

typedef _AuthenticatedCallback = void Function(DriverTelemetryPublisher publisher);

final class _DriverSignInScreen extends StatefulWidget {
  const _DriverSignInScreen({
    required this.apiBaseUrl,
    required this.telemetryUrl,
    required this.onAuthenticated,
  });

  final String apiBaseUrl;
  final String telemetryUrl;
  final _AuthenticatedCallback onAuthenticated;

  @override
  State<_DriverSignInScreen> createState() => _DriverSignInScreenState();
}

final class _DriverSignInScreenState extends State<_DriverSignInScreen> {
  final TextEditingController _phoneController = TextEditingController(
    text: '+250',
  );
  final TextEditingController _codeController = TextEditingController();

  String? _challengeId;
  String? _devCode;
  String? _error;
  bool _busy = false;

  FidaApiClient get _publicApi => FidaApiClient(baseUrl: widget.apiBaseUrl);

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _requestCode() async {
    final String phone = _phoneController.text.trim();
    if (!_isE164(phone)) {
      setState(
        () => _error =
            'Enter the phone number in international format, for example +2507XXXXXXXX.',
      );
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final Map<String, Object?> response = await _publicApi.postJson(
        '/api/v1/auth/phone/request',
        body: <String, Object?>{'phone': phone},
      );
      final Object? challengeValue = response['challenge_id'];
      if (challengeValue is! String || challengeValue.isEmpty) {
        setState(() {
          _error =
              'No active driver account was found for this phone number. Register this driver first.';
        });
        return;
      }

      setState(() {
        _challengeId = challengeValue;
        final Object? devCodeValue = response['dev_code'];
        _devCode = devCodeValue is String ? devCodeValue : null;
        _codeController.clear();
      });
    } on FidaApiException catch (error) {
      setState(() => _error = error.message);
    } catch (error) {
      setState(() => _error = 'Unable to request a verification code: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verifyCode() async {
    final String? challengeId = _challengeId;
    final String code = _codeController.text.trim();
    if (challengeId == null) return;
    if (!RegExp(r'^\\d{6}$').hasMatch(code)) {
      setState(() => _error = 'Enter the 6-digit verification code.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final Map<String, Object?> authResponse = await _publicApi.postJson(
        '/api/v1/auth/phone/verify',
        body: <String, Object?>{
          'challenge_id': challengeId,
          'code': code,
        },
      );

      final String accessToken = _requiredString(authResponse, 'access_token');
      final String driverId = _requiredString(authResponse, 'driver_id');
      final String role = _requiredString(authResponse, 'role');
      if (role != 'driver') {
        throw const FormatException(
          'This phone number belongs to a rider account, not a driver account.',
        );
      }

      final FidaApiClient authenticatedApi = FidaApiClient(
        baseUrl: widget.apiBaseUrl,
        accessTokenProvider: () async => accessToken,
      );
      final Map<String, Object?> sessionResponse =
          await authenticatedApi.postJson(
            '/api/v1/auth/telemetry-session',
            body: <String, Object?>{'purpose': 'driver_online'},
          );
      final TelemetrySession session = TelemetrySession.fromJson(
        sessionResponse,
      );

      final TelemetryWebSocketClient telemetryClient =
          TelemetryWebSocketClient(
            endpoint: Uri.parse(widget.telemetryUrl),
            accessToken: accessToken,
          );
      final DriverTelemetryPublisher publisher = DriverTelemetryPublisher(
        telemetryClient: telemetryClient,
        telemetrySigner: TelemetrySigner(session: session),
        driverId: driverId,
      );

      if (!mounted) return;
      widget.onAuthenticated(publisher);
    } on FidaApiException catch (error) {
      setState(() => _error = error.message);
    } on FormatException catch (error) {
      setState(() => _error = error.message);
    } catch (error) {
      setState(() => _error = 'Unable to start the driver session: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _registerDriver() async {
    final String? phone = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(
        builder: (BuildContext context) =>
            _DriverRegistrationScreen(apiBaseUrl: widget.apiBaseUrl),
      ),
    );

    if (!mounted || phone == null) return;
    _phoneController.text = phone;
    _challengeId = null;
    _devCode = null;
    await _requestCode();
  }

  void _changeNumber() {
    setState(() {
      _challengeId = null;
      _devCode = null;
      _codeController.clear();
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final bool awaitingCode = _challengeId != null;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Icon(Icons.local_taxi, size: 56),
                  const SizedBox(height: 20),
                  Text(
                    awaitingCode ? 'Verify your phone' : 'Drive with Fida',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    awaitingCode
                        ? 'Enter the 6-digit code sent to ${_phoneController.text.trim()}.'
                        : 'Sign in with the phone number registered on your driver account.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 28),
                  if (!awaitingCode) ...<Widget>[
                    TextField(
                      controller: _phoneController,
                      keyboardType: TextInputType.phone,
                      autofillHints: const <String>[
                        AutofillHints.telephoneNumber,
                      ],
                      decoration: const InputDecoration(
                        labelText: 'Phone number',
                        hintText: '+2507XXXXXXXX',
                        border: OutlineInputBorder(),
                      ),
                      enabled: !_busy,
                      onSubmitted: (_) => _requestCode(),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _busy ? null : _requestCode,
                      child: _busy
                          ? const _ButtonProgress()
                          : const Text('Continue'),
                    ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: _busy ? null : _registerDriver,
                      child: const Text('Register a new driver'),
                    ),
                  ] else ...<Widget>[
                    TextField(
                      controller: _codeController,
                      keyboardType: TextInputType.number,
                      autofillHints: const <String>[AutofillHints.oneTimeCode],
                      maxLength: 6,
                      decoration: const InputDecoration(
                        labelText: 'Verification code',
                        border: OutlineInputBorder(),
                        counterText: '',
                      ),
                      enabled: !_busy,
                      onSubmitted: (_) => _verifyCode(),
                    ),
                    if (_devCode != null) ...<Widget>[
                      const SizedBox(height: 10),
                      Text(
                        'Development OTP: $_devCode',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ],
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _busy ? null : _verifyCode,
                      child: _busy
                          ? const _ButtonProgress()
                          : const Text('Verify and go online'),
                    ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: _busy ? null : _changeNumber,
                      child: const Text('Use another number'),
                    ),
                  ],
                  if (_error != null) ...<Widget>[
                    const SizedBox(height: 16),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final class _DriverRegistrationScreen extends StatefulWidget {
  const _DriverRegistrationScreen({required this.apiBaseUrl});

  final String apiBaseUrl;

  @override
  State<_DriverRegistrationScreen> createState() =>
      _DriverRegistrationScreenState();
}

final class _DriverRegistrationScreenState
    extends State<_DriverRegistrationScreen> {
  final TextEditingController _firstNameController = TextEditingController();
  final TextEditingController _lastNameController = TextEditingController();
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _phoneController = TextEditingController(
    text: '+250',
  );
  final TextEditingController _plateController = TextEditingController();

  String _vehicleType = 'moto';
  String? _error;
  bool _busy = false;

  static const Map<String, String> _vehicleTypes = <String, String>{
    'moto': 'Moto',
    'taxi': 'Taxi',
    'premium': 'Premium',
    'tuk_tuk': 'Tuk Tuk',
    'ev': 'Electric vehicle',
    'accessible': 'Accessible',
    'other': 'Other',
  };

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _plateController.dispose();
    super.dispose();
  }

  Future<void> _register() async {
    final String firstName = _firstNameController.text.trim();
    final String lastName = _lastNameController.text.trim();
    final String email = _emailController.text.trim();
    final String phone = _phoneController.text.trim();
    final String plate = _plateController.text.trim();

    if (firstName.isEmpty ||
        lastName.isEmpty ||
        !_isE164(phone) ||
        plate.length < 2) {
      setState(() {
        _error =
            'Enter first name, last name, a valid international phone number, and the vehicle plate.';
      });
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final FidaApiClient api = FidaApiClient(baseUrl: widget.apiBaseUrl);
      await api.postJson(
        '/api/v1/auth/register/driver',
        body: <String, Object?>{
          'first_name': firstName,
          'last_name': lastName,
          if (email.isNotEmpty) 'email': email,
          'phone': phone,
          'vehicle_type': _vehicleType,
          'license_plate': plate,
        },
      );

      if (!mounted) return;
      Navigator.of(context).pop<String>(phone);
    } on FidaApiException catch (error) {
      setState(() => _error = error.message);
    } catch (error) {
      setState(() => _error = 'Unable to register the driver: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Driver registration')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: <Widget>[
              TextField(
                controller: _firstNameController,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'First name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _lastNameController,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'Last name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(
                  labelText: 'Email (optional)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  labelText: 'Phone number',
                  hintText: '+2507XXXXXXXX',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _vehicleType,
                decoration: const InputDecoration(
                  labelText: 'Vehicle type',
                  border: OutlineInputBorder(),
                ),
                items: _vehicleTypes.entries
                    .map<DropdownMenuItem<String>>(
                      (MapEntry<String, String> item) =>
                          DropdownMenuItem<String>(
                            value: item.key,
                            child: Text(item.value),
                          ),
                    )
                    .toList(growable: false),
                onChanged: _busy
                    ? null
                    : (String? value) {
                        if (value != null) {
                          setState(() => _vehicleType = value);
                        }
                      },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _plateController,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Vehicle plate',
                  hintText: 'RAA 123 A',
                  border: OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _register,
                  child: _busy
                      ? const _ButtonProgress()
                      : const Text('Create driver account'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _ButtonProgress extends StatelessWidget {
  const _ButtonProgress();

  @override
  Widget build(BuildContext context) {
    return const SizedBox.square(
      dimension: 20,
      child: CircularProgressIndicator(strokeWidth: 2),
    );
  }
}

bool _isE164(String phone) => RegExp(r'^\\+[1-9]\\d{7,14}$').hasMatch(phone);

String _requiredString(Map<String, Object?> json, String key) {
  final Object? value = json[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('Server response is missing $key.');
  }
  return value;
}
