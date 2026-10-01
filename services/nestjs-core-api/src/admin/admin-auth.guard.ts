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
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  AdminAuthenticatedRequest,
  AdminJwtPrincipal,
  AdminRole,
} from './admin-auth.types';
import { AdminSessionService } from './admin-session.service';

const ADMIN_PERMISSIONS_KEY = 'admin_permissions';
const ADMIN_PUBLIC_ROUTE_KEY = 'admin_public_route';
const ADMIN_JWT_COOKIE_NAME = 'fida_admin_access';
const ADMIN_WILDCARD_PERMISSION = 'admin:*';

const ADMIN_ROLES = new Set<AdminRole>([
  'super_admin',
  'operations_admin',
  'finance_admin',
  'security_admin',
  'support_admin',
]);

export const RequireAdminPermissions = (...permissions: string[]) =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);

export const PublicAdminRoute = () => SetMetadata(ADMIN_PUBLIC_ROUTE_KEY, true);

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly sessions: AdminSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    if (!this.isAdminPath(request)) return true;

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(ADMIN_PUBLIC_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isPublic) return true;

    const secret = this.config.get<string>('ADMIN_JWT_HS256_SECRET', '').trim();
    if (secret.length < 32) {
      throw new ServiceUnavailableException('Administrative authentication unavailable');
    }

    const token = this.extractCookie(request.headers.cookie);
    if (!token) throw new UnauthorizedException('Administrative authentication required');

    let principal: AdminJwtPrincipal;
    try {
      principal = await this.jwt.verifyAsync<AdminJwtPrincipal>(token, {
        secret,
        algorithms: ['HS256'],
        issuer: this.config.getOrThrow<string>('ADMIN_JWT_ISSUER'),
        audience: this.config.getOrThrow<string>('ADMIN_JWT_AUDIENCE'),
      });
    } catch {
      throw new UnauthorizedException('Administrative authentication required');
    }

    if (!this.validPrincipal(principal)) {
      throw new UnauthorizedException('Administrative authentication required');
    }

    const active = await this.sessions.validate(principal);
    if (!active) throw new UnauthorizedException('Administrative session is no longer active');

    const required =
      this.reflector.getAllAndOverride<string[]>(ADMIN_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const granted = new Set(principal.permissions);

    for (const permission of required) {
      if (!granted.has(permission) && !granted.has(ADMIN_WILDCARD_PERMISSION)) {
        throw new ForbiddenException('Administrative permission denied');
      }
    }

    request.admin = principal;
    return true;
  }

  private validPrincipal(principal: AdminJwtPrincipal): boolean {
    return (
      typeof principal.sub === 'string' &&
      principal.sub.length > 0 &&
      principal.sub.length <= 128 &&
      ADMIN_ROLES.has(principal.role) &&
      typeof principal.sid === 'string' &&
      principal.sid.length > 0 &&
      principal.sid.length <= 128 &&
      typeof principal.jti === 'string' &&
      principal.jti.length > 0 &&
      principal.jti.length <= 128 &&
      Array.isArray(principal.permissions) &&
      principal.permissions.length <= 128 &&
      principal.permissions.every(
        (permission) => typeof permission === 'string' && permission.length > 0 && permission.length <= 128,
      )
    );
  }

  private isAdminPath(request: AdminAuthenticatedRequest): boolean {
    const raw = request.originalUrl ?? request.path ?? '';
    const path = raw.split('?')[0] ?? '';
    return /(?:^|\/)admin(?:\/|$)/u.test(path);
  }

  private extractCookie(rawCookie: string | string[] | undefined): string | null {
    const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    if (!cookie || cookie.length > 16_384) return null;

    for (const part of cookie.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      if (name !== ADMIN_JWT_COOKIE_NAME) continue;

      const value = part.slice(separator + 1).trim();
      if (!value || value.length > 8_192) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }

    return null;
  }
}
