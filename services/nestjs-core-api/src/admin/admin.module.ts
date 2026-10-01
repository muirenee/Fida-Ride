import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthExceptionFilter } from './admin-auth.filter';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminSessionService } from './admin-session.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminAuthController, AdminController],
  providers: [
    AdminAuthService,
    AdminSessionService,
    AdminAuthExceptionFilter,
    AdminService,
    {
      provide: APP_GUARD,
      useClass: AdminAuthGuard,
    },
  ],
})
export class AdminModule {}
