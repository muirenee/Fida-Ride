import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthPrincipal } from '../auth/jwt-auth.guard';
import { FraudDetectionService } from './fraud-detection.service';
import { ApiRiskMetadata } from './fraud.types';

interface FraudAwareRequest {
  user?: AuthPrincipal;
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: {
    remoteAddress?: string;
  };
}

@Injectable()
export class FraudDetectionInterceptor implements NestInterceptor {
  constructor(private readonly fraud: FraudDetectionService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<FraudAwareRequest>();
    const principal = request.user;
    if (!principal) return next.handle();

    await this.fraud.assertAccountAllowed(principal);
    const assessment = await this.fraud.assessApiRequest(
      principal,
      this.extractMetadata(request),
    );

    if (assessment && assessment.action !== 'observe') {
      throw new ForbiddenException(
        `Request blocked by automated security policy: ${assessment.action}`,
      );
    }

    return next.handle();
  }

  private extractMetadata(request: FraudAwareRequest): ApiRiskMetadata {
    const deviceId = headerValue(request.headers, 'x-fida-device-id')?.trim();
    const timestampRaw = headerValue(request.headers, 'x-fida-device-timestamp-ms')?.trim();
    const mockRaw = headerValue(request.headers, 'x-fida-mock-location')?.trim().toLowerCase();
    const requestId =
      headerValue(request.headers, 'x-request-id')?.trim() ||
      headerValue(request.headers, 'x-correlation-id')?.trim();

    let deviceTimestampMs: number | undefined;
    let deviceTimestampInvalid = false;
    if (timestampRaw) {
      const parsed = Number(timestampRaw);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        deviceTimestampMs = parsed;
      } else {
        deviceTimestampInvalid = true;
      }
    }

    let mockLocation: boolean | undefined;
    if (mockRaw) {
      if (mockRaw === 'true' || mockRaw === '1' || mockRaw === 'yes') mockLocation = true;
      else if (mockRaw === 'false' || mockRaw === '0' || mockRaw === 'no') mockLocation = false;
    }

    return {
      deviceId: deviceId && deviceId.length <= 256 ? deviceId : undefined,
      deviceTimestampMs,
      deviceTimestampInvalid,
      mockLocation,
      requestId: requestId?.slice(0, 128),
      method: request.method,
      path: (request.originalUrl ?? request.url)?.slice(0, 512),
      remoteIp: request.socket?.remoteAddress?.slice(0, 128),
    };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key];
  if (Array.isArray(value)) return value[0];
  return value;
}
