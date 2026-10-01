import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HeatmapQueryDto } from './dto/heatmap-query.dto';
import { HeatmapService } from './heatmap.service';
import { HeatmapPoint } from './surge.types';

@Controller('maps')
@UseGuards(JwtAuthGuard)
export class MapsController {
  constructor(private readonly heatmaps: HeatmapService) {}

  @Get('heatmaps')
  async getHeatmaps(
    @Query() query: HeatmapQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<HeatmapPoint[]> {
    if (request.user.role !== 'driver') {
      throw new ForbiddenException('Driver access token required');
    }

    return this.heatmaps.get(query.vehicle_type);
  }
}
