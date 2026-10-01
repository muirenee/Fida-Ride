import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttestationModule } from '../attestation/attestation.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DriverEntity } from '../database/entities/driver.entity';
import { TripEntity } from '../database/entities/trip.entity';
import { SurgeModule } from '../surge/surge.module';
import { UsersModule } from '../users/users.module';
import { DispatchService } from './dispatch.service';
import { PricingService } from './pricing.service';
import { RidesController } from './rides.controller';
import { RidesService } from './rides.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripEntity, DriverEntity]),
    UsersModule,
    AuthModule,
    AttestationModule,
    SurgeModule,
  ],
  controllers: [RidesController],
  providers: [RidesService, PricingService, DispatchService, JwtAuthGuard],
  exports: [RidesService],
})
export class RidesModule {}
