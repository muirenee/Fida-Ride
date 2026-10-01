import { Body, Controller, Get, Post, UseFilters } from '@nestjs/common';
import { AdminAuthExceptionFilter } from './admin-auth.filter';
import { RequireAdminPermissions } from './admin-auth.guard';
import { AdminService } from './admin.service';
import { UpsertGeofenceDto } from './dto/upsert-geofence.dto';

@Controller('admin')
@UseFilters(AdminAuthExceptionFilter)
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
