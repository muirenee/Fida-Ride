import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { createSign, randomBytes, randomUUID } from 'node:crypto';
import { verifyAssertion, verifyAttestation } from 'node-app-attest';
import { RedisService } from '../redis/redis.service';
import {
  AttestationAction,
  AttestationChallengeDto,
  AttestationPlatform,
  AttestationVerifyDto,
} from './dto/attestation.dto';
import { canonicalJson, safeEqualString, sha256Base64Url } from './attestation.util';

interface ChallengeRecord {
  platform: AttestationPlatform;
  installationId: string;
  action: AttestationAction;
  requestHash: string;
  challenge: string;
}

interface TicketRecord {
  installationId: string;
  action: AttestationAction;
  requestHash: string;
  platform: AttestationPlatform;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

interface GoogleTokenPayloadExternal {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    timestampMillis?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
  };
  accountDetails?: {
    appLicensingVerdict?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
  };
}

interface GoogleDecodeResponse {
  tokenPayloadExternal?: GoogleTokenPayloadExternal;
}

interface AppleAttestationRow {
  key_id: string;
  public_key: string;
  bundle_id: string;
  sign_count: string;
}

@Injectable()
export class AttestationVerificationService {
  private readonly logger = new Logger(AttestationVerificationService.name);
  private googleAccessToken?: { token: string; expiresAtMs: number };

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly db: DataSource,
  ) {}

  async issueChallenge(dto: AttestationChallengeDto): Promise<{
    challenge_id: string;
    challenge: string;
    expires_in_seconds: number;
  }> {
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString('base64url');
    const ttl = this.config.getOrThrow<number>('ATTESTATION_CHALLENGE_TTL_SECONDS');
    const record: ChallengeRecord = {
      platform: dto.platform,
      installationId: dto.installation_id,
      action: dto.action,
      requestHash: dto.request_hash,
      challenge,
    };
    await this.redis.setEx(this.challengeKey(challengeId), ttl, JSON.stringify(record));
    return {
      challenge_id: challengeId,
      challenge,
      expires_in_seconds: ttl,
    };
  }

  async verify(dto: AttestationVerifyDto): Promise<{
    ticket: string;
    expires_at: string;
  }> {
    const challenge = await this.consumeChallenge(dto.challenge_id);
    this.assertChallengeMatches(challenge, dto);

    const clientData = canonicalJson({
      action: challenge.action,
      challenge: challenge.challenge,
      challenge_id: dto.challenge_id,
      installation_id: challenge.installationId,
      request_hash: challenge.requestHash,
    });

    if (dto.platform === 'android') {
      await this.verifyAndroid(dto, clientData);
    } else {
      await this.verifyIos(dto, clientData);
    }

    return this.issueTicket({
      installationId: challenge.installationId,
      action: challenge.action,
      requestHash: challenge.requestHash,
      platform: challenge.platform,
    });
  }

  async consumeTicket(input: {
    ticket: string;
    installationId: string;
    action: AttestationAction;
    requestHash: string;
  }): Promise<boolean> {
    const raw = await this.consumeRedisRecord(this.ticketKey(input.ticket));
    if (!raw) return false;

    let record: TicketRecord;
    try {
      record = JSON.parse(raw) as TicketRecord;
    } catch {
      return false;
    }

    return (
      safeEqualString(record.installationId, input.installationId) &&
      record.action === input.action &&
      safeEqualString(record.requestHash, input.requestHash)
    );
  }

  private async verifyAndroid(dto: AttestationVerifyDto, clientData: string): Promise<void> {
    const token = dto.token;
    const suppliedIntegrityHash = dto.integrity_request_hash;
    if (!token || !suppliedIntegrityHash) {
      throw new UnauthorizedException('Play Integrity token and request hash are required.');
    }

    const expectedIntegrityHash = sha256Base64Url(clientData);
    if (!safeEqualString(expectedIntegrityHash, suppliedIntegrityHash)) {
      throw new UnauthorizedException('Play Integrity request binding mismatch.');
    }

    const expectedPackageName = this.androidPackageForAction(dto.action);
    const accessToken = await this.getGoogleAccessToken();
    const response = await fetch(
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(expectedPackageName)}:decodeIntegrityToken`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ integrity_token: token }),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('ATTESTATION_PROVIDER_TIMEOUT_MS'),
        ),
      },
    );

    if (!response.ok) {
      this.logger.warn(`Google Play Integrity decode rejected with HTTP ${response.status}`);
      throw new UnauthorizedException('Play Integrity verification failed.');
    }

    const decoded = (await response.json()) as GoogleDecodeResponse;
    const payload = decoded.tokenPayloadExternal;
    if (!payload) throw new UnauthorizedException('Play Integrity payload is missing.');

    const requestDetails = payload.requestDetails;
    const timestampMillis = Number(requestDetails?.timestampMillis ?? Number.NaN);
    const maxAgeMs = this.config.getOrThrow<number>('PLAY_INTEGRITY_MAX_AGE_MS');
    const now = Date.now();
    if (
      requestDetails?.requestPackageName !== expectedPackageName ||
      requestDetails.requestHash !== expectedIntegrityHash ||
      !Number.isFinite(timestampMillis) ||
      Math.abs(now - timestampMillis) > maxAgeMs
    ) {
      throw new UnauthorizedException('Play Integrity request details are invalid or stale.');
    }

    if (payload.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
      throw new UnauthorizedException('Android application integrity was not recognized by Google Play.');
    }

    if (
      this.config.getOrThrow<boolean>('PLAY_INTEGRITY_REQUIRE_LICENSED') &&
      payload.accountDetails?.appLicensingVerdict !== 'LICENSED'
    ) {
      throw new UnauthorizedException('Android application is not licensed by Google Play.');
    }

    const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    if (!deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) {
      throw new UnauthorizedException('Android device integrity requirement failed.');
    }
    if (
      this.config.getOrThrow<boolean>('PLAY_INTEGRITY_REQUIRE_STRONG') &&
      !deviceVerdicts.includes('MEETS_STRONG_INTEGRITY')
    ) {
      throw new UnauthorizedException('Android strong device integrity requirement failed.');
    }
  }

  private async verifyIos(dto: AttestationVerifyDto, expectedClientData: string): Promise<void> {
    if (!dto.mode || !dto.key_id || !dto.client_data) {
      throw new UnauthorizedException('App Attest mode, key ID and client data are required.');
    }

    let clientData: Buffer;
    try {
      clientData = Buffer.from(dto.client_data, 'base64');
    } catch {
      throw new UnauthorizedException('App Attest client data encoding is invalid.');
    }
    if (!safeEqualString(clientData.toString('utf8'), expectedClientData)) {
      throw new UnauthorizedException('App Attest request binding mismatch.');
    }

    const expectedBundle = this.appleBundleForAction(dto.action);
    const teamIdentifier = this.config.getOrThrow<string>('APPLE_APP_ATTEST_TEAM_ID');
    const allowDevelopmentEnvironment =
      this.config.getOrThrow<boolean>('APPLE_APP_ATTEST_ALLOW_DEVELOPMENT');

    if (dto.mode === 'attestation') {
      if (!dto.attestation) {
        throw new UnauthorizedException('App Attest attestation object is required.');
      }

      let result: { publicKey: string };
      try {
        result = verifyAttestation({
          attestation: Buffer.from(dto.attestation, 'base64'),
          challenge: clientData,
          keyId: dto.key_id,
          bundleIdentifier: expectedBundle,
          teamIdentifier,
          allowDevelopmentEnvironment,
        });
      } catch (error) {
        this.logger.warn(
          `Apple App Attest verification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new UnauthorizedException('Apple App Attest verification failed.');
      }

      await this.persistAppleAttestation({
        installationId: dto.installation_id,
        keyId: dto.key_id,
        publicKey: result.publicKey,
        bundleId: expectedBundle,
      });
      return;
    }

    if (!dto.assertion) {
      throw new UnauthorizedException('App Attest assertion object is required.');
    }

    await this.db.transaction(async (manager) => {
      const rows = await manager.query<AppleAttestationRow[]>(
        `
          SELECT key_id, public_key, bundle_id, sign_count::text
          FROM core.device_attestations
          WHERE installation_id = $1
            AND platform = 'ios'
            AND status = 'active'
          FOR UPDATE
        `,
        [dto.installation_id],
      );
      const row = rows[0];
      if (!row || row.key_id !== dto.key_id || row.bundle_id !== expectedBundle) {
        throw new UnauthorizedException('Unknown or mismatched App Attest key.');
      }

      const previousSignCount = Number(row.sign_count);
      if (!Number.isSafeInteger(previousSignCount) || previousSignCount < 0) {
        throw new UnauthorizedException('Stored App Attest counter is invalid.');
      }

      let result: { signCount: number };
      try {
        result = verifyAssertion({
          assertion: Buffer.from(dto.assertion as string, 'base64'),
          payload: clientData,
          publicKey: row.public_key,
          bundleIdentifier: row.bundle_id,
          teamIdentifier,
          signCount: previousSignCount,
        });
      } catch (error) {
        this.logger.warn(
          `Apple App Attest assertion failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new UnauthorizedException('Apple App Attest assertion verification failed.');
      }

      if (!Number.isSafeInteger(result.signCount) || result.signCount <= previousSignCount) {
        throw new UnauthorizedException('App Attest assertion counter did not advance.');
      }

      await manager.query(
        `
          UPDATE core.device_attestations
          SET sign_count = $2,
              last_verified_at = NOW(),
              updated_at = NOW()
          WHERE installation_id = $1
            AND platform = 'ios'
        `,
        [dto.installation_id, result.signCount],
      );
    });
  }

  private async persistAppleAttestation(input: {
    installationId: string;
    keyId: string;
    publicKey: string;
    bundleId: string;
  }): Promise<void> {
    await this.db.transaction(async (manager: EntityManager) => {
      const ownerRows = await manager.query<Array<{ installation_id: string }>>(
        `SELECT installation_id::text FROM core.device_attestations WHERE key_id = $1 FOR UPDATE`,
        [input.keyId],
      );
      const existingOwner = ownerRows[0]?.installation_id;
      if (existingOwner && existingOwner !== input.installationId) {
        throw new UnauthorizedException('App Attest key is already associated with another installation.');
      }

      await manager.query(
        `
          INSERT INTO core.device_attestations (
            installation_id,
            platform,
            key_id,
            public_key,
            bundle_id,
            sign_count,
            status,
            last_verified_at
          ) VALUES ($1, 'ios', $2, $3, $4, 0, 'active', NOW())
          ON CONFLICT (installation_id, platform)
          DO UPDATE SET
            key_id = EXCLUDED.key_id,
            public_key = EXCLUDED.public_key,
            bundle_id = EXCLUDED.bundle_id,
            sign_count = 0,
            status = 'active',
            last_verified_at = NOW(),
            updated_at = NOW()
        `,
        [input.installationId, input.keyId, input.publicKey, input.bundleId],
      );
    });
  }

  private async issueTicket(record: TicketRecord): Promise<{
    ticket: string;
    expires_at: string;
  }> {
    const ttl = this.config.getOrThrow<number>('ATTESTATION_TICKET_TTL_SECONDS');
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.setEx(this.ticketKey(ticket), ttl, JSON.stringify(record));
    return {
      ticket,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  private async consumeChallenge(challengeId: string): Promise<ChallengeRecord> {
    const raw = await this.consumeRedisRecord(this.challengeKey(challengeId));
    if (!raw) throw new UnauthorizedException('Attestation challenge is invalid, expired, or already used.');
    try {
      return JSON.parse(raw) as ChallengeRecord;
    } catch {
      throw new UnauthorizedException('Attestation challenge is corrupt.');
    }
  }

  private async consumeRedisRecord(key: string): Promise<string | null> {
    const lockToken = randomUUID();
    const lockKey = `lock:${key}`;
    const acquired = await this.redis.acquireLock(lockKey, lockToken, 5000);
    if (!acquired) return null;
    try {
      const raw = await this.redis.get(key);
      if (raw) await this.redis.del(key);
      return raw;
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private assertChallengeMatches(challenge: ChallengeRecord, dto: AttestationVerifyDto): void {
    if (
      challenge.platform !== dto.platform ||
      challenge.action !== dto.action ||
      !safeEqualString(challenge.installationId, dto.installation_id) ||
      !safeEqualString(challenge.requestHash, dto.request_hash)
    ) {
      throw new UnauthorizedException('Attestation challenge binding mismatch.');
    }
  }

  private androidPackageForAction(action: AttestationAction): string {
    return this.isDriverAction(action)
      ? this.config.getOrThrow<string>('ANDROID_DRIVER_PACKAGE_NAME')
      : this.config.getOrThrow<string>('ANDROID_RIDER_PACKAGE_NAME');
  }

  private appleBundleForAction(action: AttestationAction): string {
    return this.isDriverAction(action)
      ? this.config.getOrThrow<string>('APPLE_DRIVER_BUNDLE_ID')
      : this.config.getOrThrow<string>('APPLE_RIDER_BUNDLE_ID');
  }

  private isDriverAction(action: AttestationAction): boolean {
    return action === 'register_driver' || action === 'driver_online' || action === 'telemetry_session';
  }

  private async getGoogleAccessToken(): Promise<string> {
    const cached = this.googleAccessToken;
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;

    const credentials = this.googleCredentials();
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/playintegrity',
        aud: 'https://oauth2.googleapis.com/token',
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    ).toString('base64url');
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(credentials.private_key).toString('base64url');
    const assertion = `${unsigned}.${signature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(
        this.config.getOrThrow<number>('ATTESTATION_PROVIDER_TIMEOUT_MS'),
      ),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException('Unable to authenticate to Google Play Integrity service.');
    }
    const tokenResponse = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!tokenResponse.access_token) {
      throw new ServiceUnavailableException('Google OAuth response did not include an access token.');
    }
    const expiresIn = Number(tokenResponse.expires_in ?? 3600);
    this.googleAccessToken = {
      token: tokenResponse.access_token,
      expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
    };
    return tokenResponse.access_token;
  }

  private googleCredentials(): ServiceAccountCredentials {
    const raw = this.config.getOrThrow<string>('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON');
    let parsed: Partial<ServiceAccountCredentials>;
    try {
      parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
    } catch {
      throw new ServiceUnavailableException('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON is invalid JSON.');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new ServiceUnavailableException('Google Play Integrity service account credentials are incomplete.');
    }
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
    };
  }

  private challengeKey(challengeId: string): string {
    return `attestation:challenge:${challengeId}`;
  }

  private ticketKey(ticket: string): string {
    return `attestation:ticket:${ticket}`;
  }
}
