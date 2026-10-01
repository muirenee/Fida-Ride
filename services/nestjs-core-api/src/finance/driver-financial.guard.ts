import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { DriverFinancialService } from './driver-financial.service';

@Injectable()
export class DriverFinancialGuard implements CanActivate {
  constructor(private readonly financial: DriverFinancialService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.user;

    if (principal.role !== 'driver' || !principal.driver_id) {
      throw new ForbiddenException('Driver account required');
    }

    await this.financial.assertCanGoOnline(principal.driver_id);
    return true;
  }
}
