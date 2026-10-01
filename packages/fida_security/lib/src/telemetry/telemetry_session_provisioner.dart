import 'package:fida_api/fida_api.dart';
import 'package:fida_security/src/attestation/device_attestation_service.dart';
import 'package:fida_security/src/telemetry/telemetry_signer.dart';

final class TelemetrySessionProvisioner {
  TelemetrySessionProvisioner({
    required FidaApiClient api,
    required DeviceAttestationService attestation,
  }) : _api = api,
       _attestation = attestation;

  final FidaApiClient _api;
  final DeviceAttestationService _attestation;

  Future<TelemetrySession> create() async {
    final Map<String, Object?> payload = <String, Object?>{
      'purpose': 'driver_online',
    };
    final AttestationTicket ticket = await _attestation.attest(
      action: AttestationAction.telemetrySession,
      protectedPayload: payload,
    );
    final Map<String, Object?> response = await _api.postJson(
      '/api/v1/auth/telemetry-session',
      body: payload,
      headers: ticket.asHeaders(),
    );
    return TelemetrySession.fromJson(response);
  }
}
