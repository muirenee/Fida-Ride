import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

const ADMIN_PERMISSIONS_KEY = 'admin_permissions';
const ADMIN_JWT_COOKIE_NAME = 'fida_admin_access';

export interface AdminPrincipal {
  sub: string;
  role: 'admin';
  permissions?: string[];
}

export interface AdminAuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  admin: AdminPrincipal;
}

export const RequireAdminPermissions = (...permissions: string[]) =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);

@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.config.get<string>('ADMIN_JWT_HS256_SECRET', '').trim();
    if (secret.length < 32) {
      throw new ServiceUnavailableException('Admin authentication is not configured');
    }

    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const token = this.extractToken(request.headers);
    if (!token) {
      throw new UnauthorizedException('Admin access token required');
    }

    let principal: AdminPrincipal;
    try {
      principal = await this.jwt.verifyAsync<AdminPrincipal>(token, {
        secret,
        algorithms: ['HS256'],
        issuer: this.config.get<string>('ADMIN_JWT_ISSUER', 'fida-ride-admin'),
        audience: this.config.get<string>('ADMIN_JWT_AUDIENCE', 'fida-admin'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired admin access token');
    }

    if (!principal.sub || principal.role !== 'admin') {
      throw new UnauthorizedException('Admin role required');
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(ADMIN_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const granted = new Set(principal.permissions ?? []);
    for (const permission of required) {
      if (!granted.has(permission) && !granted.has('admin:*')) {
        throw new ForbiddenException(`Missing admin permission: ${permission}`);
      }
    }

    request.admin = principal;
    return true;
  }

  private extractToken(headers: Record<string, string | string[] | undefined>): string | null {
    const rawAuthorization = headers.authorization;
    const authorization = Array.isArray(rawAuthorization)
      ? rawAuthorization[0]
      : rawAuthorization;
    const [scheme, bearer] = authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() === 'bearer' && bearer) {
      return bearer.trim();
    }

    const rawCookie = headers.cookie;
    const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    if (!cookie) return null;

    for (const part of cookie.split(';')) {
      const [name, ...valueParts] = part.trim().split('=');
      if (name !== ADMIN_JWT_COOKIE_NAME) continue;
      const value = valueParts.join('=').trim();
      if (!value) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }

    return null;
  }
}
