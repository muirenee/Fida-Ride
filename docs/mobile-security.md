# Fida-Ride Mobile Security Architecture

## Trust boundaries

Fida-Ride uses layered controls rather than trusting a client-provided device flag:

1. A random app-installation UUID is generated once and stored with the operating system secure-storage facility. It is not an IMEI, MAC address, serial number, advertising ID, or other hardware identifier.
2. High-risk actions request a fresh server challenge and platform attestation proof.
3. The Core API verifies the platform proof and issues a short-lived, one-time Fida attestation ticket bound to the exact action, installation UUID, and canonical request-body hash.
4. Driver activation creates a short-lived 256-bit telemetry HMAC session held in Redis. The raw session key is returned once over the authenticated TLS API response and should remain memory-only on the client.
5. Every GPS frame is signed over a versioned canonical representation including session ID, coordinates, bearing, status, server-bounded client timestamp, and a monotonic sequence.
6. The Go telemetry service verifies active-session ownership, HMAC, freshness and replay sequence before velocity fraud detection and before GEOADD/presence publication.

HMAC protects message authenticity and integrity while the session key remains secret. It does not make a fully compromised process trustworthy; Play Integrity/App Attest, short session TTLs, replay protection, velocity analysis and server-side account controls provide the additional layers.

## Flutter package

Shared security code lives in `packages/fida_security`.

### Installation identity

`InstallationIdentityService` stores `fida.installation.uuid.v1` using `flutter_secure_storage`. The identifier is random and scoped to this app installation.

### Protected action flow

```text
Flutter action payload
      |
      | canonical SHA-256 request hash
      v
POST /api/v1/attestation/challenge
      |
      +--> Android: Play Integrity Standard request(requestHash)
      |
      +--> iOS: App Attest attestation/assertion over SHA-256(clientData)
      |
      v
POST /api/v1/attestation/verify
      |
      v
one-time Fida attestation ticket
      |
      v
protected API endpoint
```

The ticket is consumed once and is rejected when its action, installation ID, or request-body hash differs.

## Android Play Integrity

Production prerequisites:

- Register/link the Android Rider and Driver apps in Google Play Console.
- Enable Play Integrity and link the Google Cloud project used by Standard Integrity requests.
- Provision a backend service account authorized to call the Play Integrity decode API; put its JSON only in the production secret store as `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON`.
- Supply the numeric Google Cloud project number to `DeviceAttestationService` in the mobile runtime configuration.
- Configure the real application IDs in `ANDROID_RIDER_PACKAGE_NAME` and `ANDROID_DRIVER_PACKAGE_NAME`.

The backend requires, by default:

- matching package name;
- matching request hash;
- fresh token timestamp;
- `PLAY_RECOGNIZED` app verdict;
- `LICENSED` licensing verdict;
- `MEETS_DEVICE_INTEGRITY` device verdict.

`MEETS_STRONG_INTEGRITY` is optional because requiring it can reduce device coverage. Turn it on only after measuring production compatibility.

## Apple App Attest

Production prerequisites:

- Enable the App Attest capability for the Rider and Driver App IDs in Apple Developer configuration.
- Add the App Attest entitlement to each iOS application target with the production environment for App Store/TestFlight builds.
- Set `APPLE_APP_ATTEST_TEAM_ID`, `APPLE_RIDER_BUNDLE_ID` and `APPLE_DRIVER_BUNDLE_ID` to the real identifiers.
- Keep `APPLE_APP_ATTEST_ALLOW_DEVELOPMENT=false` in production.

The first protected action on a new installation generates an App Attest key and sends an attestation object. The backend verifies it locally, then stores the public key and counter in `core.device_attestations`. Subsequent protected actions use App Attest assertions; the backend locks the attestation row, verifies the assertion against the stored public key, and requires the sign counter to advance before committing it.

A rejected local App Attest key is deleted from secure storage. The client must start a new protected-action attempt so that a fresh server challenge is used; consumed challenges are never replayed.

## Telemetry session and HMAC envelope

An authenticated, attested driver calls:

```http
POST /api/v1/auth/telemetry-session
Authorization: Bearer <driver JWT>
X-Fida-Installation-Id: <installation UUID>
X-Fida-Attestation-Ticket: <one-time ticket>
Content-Type: application/json

{"purpose":"driver_online"}
```

Response:

```json
{
  "session_id": "uuid",
  "session_key": "base64-encoded-32-byte-key",
  "expires_at": "2026-10-01T13:00:00.000Z"
}
```

The Redis active-session pointer invalidates prior sessions immediately. Session keys are not stored in PostgreSQL.

A signed telemetry frame is:

```json
{
  "driver_id": "driver-uuid",
  "latitude": -1.9441,
  "longitude": 30.0619,
  "bearing": 125.0,
  "status": "available",
  "session_id": "session-uuid",
  "timestamp": 1790845010000,
  "sequence": 1,
  "signature": "64-lowercase-hex-characters"
}
```

The HMAC input is UTF-8 text with newline separators:

```text
v1
<session_id>
<driver_id>
<latitude fixed to 7 decimals>
<longitude fixed to 7 decimals>
<bearing fixed to 2 decimals>
<status>
<timestamp milliseconds>
<sequence>
```

The Go service validates timestamp skew, active session, 256-bit key, HMAC-SHA256 using constant-time comparison, and an atomic Redis monotonic sequence before accepting a location.

## Deployment order

1. Apply `database/migrations/schema-v7-device-attestation.sql`.
2. Deploy NestJS and Go with attestation enforcement still disabled.
3. Configure production Google/Apple identifiers and secrets.
4. Build signed production Rider/Driver clients with Play Integrity/App Attest enabled.
5. Validate attestation in a closed test environment.
6. Set `ATTESTATION_ENFORCEMENT_ENABLED=true` and restart the Core API.
7. Keep `TELEMETRY_ALLOW_INSECURE_DRIVER_ID=false` in production.

Do not enable production attestation enforcement before production-signed mobile clients can successfully obtain tickets, or registration/booking/driver-online operations will intentionally fail closed.
