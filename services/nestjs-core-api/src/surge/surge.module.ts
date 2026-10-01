import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriverEntity } from '../database/entities/driver.entity';
import { HeatmapService } from './heatmap.service';
import { MapsController } from './maps.controller';
import { SurgeDensityRepository } from './surge-density.repository';
import { SurgePricingService } from './surge-pricing.service';
import { SurgeSupplyService } from './surge-supply.service';

@Module({
  imports: [TypeOrmModule.forFeature([DriverEntity]), AuthModule],
  controllers: [MapsController],
  providers: [
    SurgeDensityRepository,
    SurgeSupplyService,
    SurgePricingService,
    HeatmapService,
    JwtAuthGuard,
  ],
  exports: [SurgePricingService],
})
export class SurgeModule {}
