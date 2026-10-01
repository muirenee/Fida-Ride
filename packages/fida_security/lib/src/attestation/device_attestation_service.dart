import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:fida_api/fida_api.dart';
import 'package:fida_security/src/common/canonical_json.dart';
import 'package:fida_security/src/identity/installation_identity_service.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

enum AttestationAction {
  registerRider('register_rider'),
  registerDriver('register_driver'),
  bookRide('book_ride'),
  driverOnline('driver_online'),
  telemetrySession('telemetry_session');

  const AttestationAction(this.wireValue);
  final String wireValue;
}

final class AttestationTicket {
  const AttestationTicket({
    required this.ticket,
    required this.installationId,
    required this.action,
    required this.expiresAt,
  });

  final String ticket;
  final String installationId;
  final AttestationAction action;
  final DateTime expiresAt;

  Map<String, Object?> asHeaders() => <String, Object?>{
    'x-fida-installation-id': installationId,
    'x-fida-attestation-ticket': ticket,
  };
}

final class DeviceAttestationException implements Exception {
  const DeviceAttestationException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'DeviceAttestationException: $message';
}

final class DeviceAttestationService {
  DeviceAttestationService({
    required FidaApiClient api,
    required InstallationIdentityService identity,
    required int androidCloudProjectNumber,
    MethodChannel? channel,
    FlutterSecureStorage? secureStorage,
  }) : _api = api,
       _identity = identity,
       _androidCloudProjectNumber = androidCloudProjectNumber,
       _channel = channel ?? const MethodChannel('fida_security/attestation'),
       _storage = secureStorage ?? const FlutterSecureStorage();

  static const String _iosKeyIdStorageKey = 'fida.app_attest.key_id.v1';

  final FidaApiClient _api;
  final InstallationIdentityService _identity;
  final int _androidCloudProjectNumber;
  final MethodChannel _channel;
  final FlutterSecureStorage _storage;

  bool _androidPrepared = false;
  Future<void>? _prepareFuture;

  Future<void> initialize() async {
    await _identity.getOrCreate();
    if (Platform.isAndroid) {
      await _prepareAndroidIntegrity();
    }
  }

  Future<AttestationTicket> attest({
    required AttestationAction action,
    required Map<String, Object?> protectedPayload,
  }) async {
    final String installationId = await _identity.getOrCreate();
    final String requestHash = _sha256Base64Url(
      canonicalJson(protectedPayload),
    );
    final String platform = _platformName();

    final Map<String, Object?> challengeResponse = await _api.postJson(
      '/api/v1/attestation/challenge',
      body: <String, Object?>{
        'platform': platform,
        'installation_id': installationId,
        'action': action.wireValue,
        'request_hash': requestHash,
      },
    );

    final String challengeId = _requireString(
      challengeResponse,
      'challenge_id',
    );
    final String challenge = _requireString(challengeResponse, 'challenge');

    final String clientData = canonicalJson(<String, Object?>{
      'action': action.wireValue,
      'challenge': challenge,
      'challenge_id': challengeId,
      'installation_id': installationId,
      'request_hash': requestHash,
    });

    if (Platform.isAndroid) {
      return _verifyAndroid(
        action: action,
        installationId: installationId,
        challengeId: challengeId,
        requestHash: requestHash,
        clientData: clientData,
      );
    }

    if (Platform.isIOS) {
      return _verifyIos(
        action: action,
        installationId: installationId,
        challengeId: challengeId,
        requestHash: requestHash,
        clientData: clientData,
      );
    }

    throw const DeviceAttestationException(
      'Fida-Ride attestation is supported only on Android and iOS.',
    );
  }

  Future<AttestationTicket> _verifyAndroid({
    required AttestationAction action,
    required String installationId,
    required String challengeId,
    required String requestHash,
    required String clientData,
  }) async {
    await _prepareAndroidIntegrity();
    final String integrityRequestHash = _sha256Base64Url(clientData);

    try {
      final String? token = await _channel.invokeMethod<String>(
        'requestAndroidIntegrityToken',
        <String, Object?>{'requestHash': integrityRequestHash},
      );
      if (token == null || token.isEmpty) {
        throw const DeviceAttestationException(
          'Play Integrity returned an empty token.',
        );
      }

      final Map<String, Object?> response = await _api.postJson(
        '/api/v1/attestation/verify',
        body: <String, Object?>{
          'platform': 'android',
          'installation_id': installationId,
          'action': action.wireValue,
          'challenge_id': challengeId,
          'request_hash': requestHash,
          'integrity_request_hash': integrityRequestHash,
          'token': token,
        },
      );
      return _ticketFromResponse(response, action, installationId);
    } on PlatformException catch (error) {
      _androidPrepared = false;
      throw DeviceAttestationException(
        'Play Integrity failed: ${error.code}',
        error,
      );
    }
  }

  Future<AttestationTicket> _verifyIos({
    required AttestationAction action,
    required String installationId,
    required String challengeId,
    required String requestHash,
    required String clientData,
  }) async {
    final bool supported =
        await _channel.invokeMethod<bool>('iosIsAppAttestSupported') ?? false;
    if (!supported) {
      throw const DeviceAttestationException(
        'Apple App Attest is unavailable on this device.',
      );
    }

    String? keyId = await _readIosKeyId();
    final List<int> clientDataBytes = utf8.encode(clientData);
    final String clientDataBase64 = base64.encode(clientDataBytes);
    final String clientDataHashBase64 = base64.encode(
      sha256.convert(clientDataBytes).bytes,
    );

    try {
      if (keyId == null || keyId.isEmpty) {
        keyId = await _channel.invokeMethod<String>('iosGenerateKey');
        if (keyId == null || keyId.isEmpty) {
          throw const DeviceAttestationException(
            'App Attest key generation returned no key identifier.',
          );
        }

        final String? attestation = await _channel.invokeMethod<String>(
          'iosAttestKey',
          <String, Object?>{
            'keyId': keyId,
            'clientDataHashBase64': clientDataHashBase64,
          },
        );
        if (attestation == null || attestation.isEmpty) {
          throw const DeviceAttestationException(
            'App Attest returned an empty attestation object.',
          );
        }

        final Map<String, Object?> response = await _api.postJson(
          '/api/v1/attestation/verify',
          body: <String, Object?>{
            'platform': 'ios',
            'mode': 'attestation',
            'installation_id': installationId,
            'action': action.wireValue,
            'challenge_id': challengeId,
            'request_hash': requestHash,
            'key_id': keyId,
            'client_data': clientDataBase64,
            'attestation': attestation,
          },
        );

        await _writeIosKeyId(keyId);
        return _ticketFromResponse(response, action, installationId);
      }

      final String? assertion = await _channel.invokeMethod<String>(
        'iosGenerateAssertion',
        <String, Object?>{
          'keyId': keyId,
          'clientDataHashBase64': clientDataHashBase64,
        },
      );
      if (assertion == null || assertion.isEmpty) {
        throw const DeviceAttestationException(
          'App Attest returned an empty assertion.',
        );
      }

      final Map<String, Object?> response = await _api.postJson(
        '/api/v1/attestation/verify',
        body: <String, Object?>{
          'platform': 'ios',
          'mode': 'assertion',
          'installation_id': installationId,
          'action': action.wireValue,
          'challenge_id': challengeId,
          'request_hash': requestHash,
          'key_id': keyId,
          'client_data': clientDataBase64,
          'assertion': assertion,
        },
      );
      return _ticketFromResponse(response, action, installationId);
    } on FidaApiException catch (error) {
      if (error.statusCode == HttpStatus.unauthorized) {
        // The server challenge has already been consumed. Reset the local key,
        // then fail closed so the caller starts a completely fresh attestation
        // attempt with a new challenge instead of replaying this one.
        await _deleteIosKeyId();
        throw DeviceAttestationException(
          'App Attest key was rejected and reset. Retry the protected action to obtain a fresh challenge.',
          error,
        );
      }
      throw DeviceAttestationException(
        'App Attest server verification failed.',
        error,
      );
    } on PlatformException catch (error) {
      throw DeviceAttestationException(
        'App Attest failed: ${error.code}',
        error,
      );
    }
  }

  Future<void> _prepareAndroidIntegrity() {
    if (_androidPrepared) return Future<void>.value();
    final Future<void>? current = _prepareFuture;
    if (current != null) return current;

    late final Future<void> future;
    future = _channel
        .invokeMethod<void>('prepareAndroidIntegrity', <String, Object?>{
          'cloudProjectNumber': _androidCloudProjectNumber,
        })
        .then<void>((_) {
          _androidPrepared = true;
        })
        .whenComplete(() {
          if (identical(_prepareFuture, future)) _prepareFuture = null;
        });
    _prepareFuture = future;
    return future;
  }

  AttestationTicket _ticketFromResponse(
    Map<String, Object?> response,
    AttestationAction action,
    String installationId,
  ) {
    final String ticket = _requireString(response, 'ticket');
    final String expiresAtRaw = _requireString(response, 'expires_at');
    final DateTime? expiresAt = DateTime.tryParse(expiresAtRaw)?.toUtc();
    if (expiresAt == null) {
      throw const DeviceAttestationException(
        'Attestation server returned an invalid expiry.',
      );
    }
    return AttestationTicket(
      ticket: ticket,
      installationId: installationId,
      action: action,
      expiresAt: expiresAt,
    );
  }

  Future<String?> _readIosKeyId() => _storage.read(
    key: _iosKeyIdStorageKey,
    iOptions: const IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  Future<void> _writeIosKeyId(String keyId) => _storage.write(
    key: _iosKeyIdStorageKey,
    value: keyId,
    iOptions: const IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  Future<void> _deleteIosKeyId() => _storage.delete(
    key: _iosKeyIdStorageKey,
    iOptions: const IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  String _platformName() {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    throw const DeviceAttestationException('Unsupported attestation platform.');
  }

  static String _sha256Base64Url(String value) => base64Url
      .encode(sha256.convert(utf8.encode(value)).bytes)
      .replaceAll('=', '');

  static String _requireString(Map<String, Object?> json, String key) {
    final Object? value = json[key];
    if (value is! String || value.isEmpty) {
      throw DeviceAttestationException('Attestation response is missing $key.');
    }
    return value;
  }
}
