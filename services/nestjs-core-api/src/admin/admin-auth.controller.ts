import { Body, Controller, Post, Req, Res, UseFilters } from '@nestjs/common';
import { AdminAuthExceptionFilter } from './admin-auth.filter';
import { PublicAdminRoute } from './admin-auth.guard';
import { AdminAuthenticatedRequest } from './admin-auth.types';
import { AdminAuthService } from './admin-auth.service';
import { AdminSessionService } from './admin-session.service';
import { AdminLoginDto } from './dto/admin-login.dto';

const ADMIN_COOKIE_NAME = 'fida_admin_access';
const ADMIN_COOKIE_PATH = '/admin';

interface AdminHttpRequest extends AdminAuthenticatedRequest {
  socket?: { remoteAddress?: string };
}

interface HeaderResponse {
  setHeader(name: string, value: string | string[]): void;
}

@Controller('admin/auth')
@UseFilters(AdminAuthExceptionFilter)
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: AdminSessionService,
  ) {}

  @Post('login')
  @PublicAdminRoute()
  async login(
    @Body() dto: AdminLoginDto,
    @Req() request: AdminHttpRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<{
    authenticated: true;
    role: string;
    permissions: string[];
    expires_in_seconds: number;
  }> {
    this.auth.assertSecureTransport(request.headers);

    const result = await this.auth.login(dto, {
      ip: this.clientIp(request),
      userAgent: this.firstHeader(request.headers['user-agent']) ?? 'unknown',
    });

    response.setHeader('Set-Cookie', this.issueCookie(result.accessToken, result.expiresInSeconds));
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Pragma', 'no-cache');

    return {
      authenticated: true,
      role: result.principal.role,
      permissions: result.principal.permissions,
      expires_in_seconds: result.expiresInSeconds,
    };
  }

  @Post('logout')
  async logout(
    @Req() request: AdminHttpRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<{ authenticated: false }> {
    response.setHeader('Set-Cookie', this.clearCookie());
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Pragma', 'no-cache');

    const sessionId = request.admin?.sid;
    if (sessionId) await this.sessions.revoke(sessionId);

    return { authenticated: false };
  }

  private issueCookie(token: string, maxAgeSeconds: number): string {
    return [
      `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Max-Age=${maxAgeSeconds}`,
      `Path=${ADMIN_COOKIE_PATH}`,
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ].join('; ');
  }

  private clearCookie(): string {
    return [
      `${ADMIN_COOKIE_NAME}=`,
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      `Path=${ADMIN_COOKIE_PATH}`,
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ].join('; ');
  }

  private clientIp(request: AdminHttpRequest): string {
    const forwarded = this.firstHeader(request.headers['x-forwarded-for']);
    const candidate = forwarded?.split(',')[0]?.trim();
    return (candidate || request.socket?.remoteAddress || 'unknown').slice(0, 128);
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
