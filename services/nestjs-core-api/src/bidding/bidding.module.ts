import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RedisModule } from '../redis/redis.module';
import { BiddingController } from './bidding.controller';
import { BiddingService } from './bidding.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [BiddingController],
  providers: [BiddingService, JwtAuthGuard],
})
export class BiddingModule {}
