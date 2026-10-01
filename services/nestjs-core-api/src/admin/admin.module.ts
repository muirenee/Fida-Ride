import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminJwtGuard } from './admin-auth.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminJwtGuard, AdminService],
})
export class AdminModule {}
