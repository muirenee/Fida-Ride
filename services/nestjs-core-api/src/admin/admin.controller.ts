import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  AdminJwtGuard,
  RequireAdminPermissions,
} from './admin-auth.guard';
import { AdminService } from './admin.service';
import { UpsertGeofenceDto } from './dto/upsert-geofence.dto';

@Controller('admin')
@UseGuards(AdminJwtGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('metrics')
  @RequireAdminPermissions('admin:dashboard:read')
  metrics() {
    return this.admin.dashboardMetrics();
  }

  @Post('geofences')
  @RequireAdminPermissions('admin:geofences:write')
  upsertGeofence(@Body() dto: UpsertGeofenceDto) {
    return this.admin.upsertGeofence(dto);
  }
}
