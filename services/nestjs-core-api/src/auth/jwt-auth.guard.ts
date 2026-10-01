import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthPrincipal {
  sub: string;
  user_id: string;
  role: 'rider' | 'driver';
  driver_id?: string;
  phone?: string;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user: AuthPrincipal;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    const [scheme, token] = raw?.split(' ') ?? [];

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Bearer token required');
    }

    try {
      const payload = await this.jwt.verifyAsync<AuthPrincipal>(token, { algorithms: ['HS256'] });
      if (!payload.sub || !payload.user_id || !payload.role) throw new Error('invalid claims');
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
