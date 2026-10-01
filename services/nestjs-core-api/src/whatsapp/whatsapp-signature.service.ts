import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class WhatsAppSignatureService {
  constructor(private readonly config: ConfigService) {}

  verifyChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    this.assertEnabled();
    const expectedToken = this.config.getOrThrow<string>('WHATSAPP_VERIFY_TOKEN');

    if (mode !== 'subscribe' || !token || !challenge || !this.safeStringEquals(token, expectedToken)) {
      throw new ForbiddenException('WhatsApp webhook verification failed');
    }

    return challenge;
  }

  assertValidWebhook(
    rawBody: Buffer | undefined,
    signature256: string | undefined,
    legacySignature: string | undefined,
  ): void {
    this.assertEnabled();
    if (!rawBody) throw new UnauthorizedException('Webhook raw body is unavailable');

    const appSecret = this.config.getOrThrow<string>('WHATSAPP_APP_SECRET');
    if (signature256 && this.verifyHmac(rawBody, signature256, appSecret, 'sha256')) return;

    const allowLegacySha1 = this.config.get<boolean>('WHATSAPP_ALLOW_LEGACY_SHA1', false);
    if (allowLegacySha1 && legacySignature && this.verifyHmac(rawBody, legacySignature, appSecret, 'sha1')) {
      return;
    }

    throw new UnauthorizedException('Invalid WhatsApp webhook signature');
  }

  private assertEnabled(): void {
    if (!this.config.get<boolean>('WHATSAPP_BOT_ENABLED', false)) {
      throw new ServiceUnavailableException('WhatsApp booking bot is disabled');
    }
  }

  private verifyHmac(
    rawBody: Buffer,
    providedSignature: string,
    secret: string,
    algorithm: 'sha1' | 'sha256',
  ): boolean {
    const prefix = `${algorithm}=`;
    if (!providedSignature.startsWith(prefix)) return false;

    const providedHex = providedSignature.slice(prefix.length).trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(providedHex)) return false;

    const expectedHex = createHmac(algorithm, secret).update(rawBody).digest('hex');
    const expected = Buffer.from(expectedHex, 'hex');
    const provided = Buffer.from(providedHex, 'hex');

    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private safeStringEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
