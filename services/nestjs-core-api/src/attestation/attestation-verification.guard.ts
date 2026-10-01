import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AttestationVerificationService } from './attestation-verification.service';
import { canonicalJson, sha256Base64Url } from './attestation.util';
import { AttestationAction } from './dto/attestation.dto';
import { ATTESTATION_ACTION_METADATA } from './require-attestation.decorator';

interface AttestationAwareRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class AttestationVerificationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly attestation: AttestationVerificationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<AttestationAction>(
      ATTESTATION_ACTION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;

    if (!this.config.getOrThrow<boolean>('ATTESTATION_ENFORCEMENT_ENABLED')) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AttestationAwareRequest>();
    const installationId = headerValue(request.headers, 'x-fida-installation-id')?.trim();
    const ticket = headerValue(request.headers, 'x-fida-attestation-ticket')?.trim();
    if (!installationId || !ticket) {
      throw new UnauthorizedException('A verified device attestation ticket is required.');
    }

    const requestHash = sha256Base64Url(canonicalJson(request.body ?? {}));
    const verified = await this.attestation.consumeTicket({
      ticket,
      installationId,
      action,
      requestHash,
    });
    if (!verified) {
      throw new ForbiddenException('Device attestation ticket is invalid, expired, replayed, or request-bound incorrectly.');
    }
    return true;
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}
