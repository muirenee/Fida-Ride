import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { BiddingModule } from './bidding/bidding.module';
import { validateEnvironment } from './config/env.validation';
import { DriverEntity } from './database/entities/driver.entity';
import { TripEntity } from './database/entities/trip.entity';
import { UserEntity } from './database/entities/user.entity';
import { WhatsAppInboxEntity } from './database/entities/whatsapp-inbox.entity';
import { FraudModule } from './fraud/fraud.module';
import { HealthController } from './health.controller';
import { RedisModule } from './redis/redis.module';
import { RidesModule } from './rides/rides.module';
import { UsersModule } from './users/users.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('DB_HOST'),
        port: config.getOrThrow<number>('DB_PORT'),
        database: config.getOrThrow<string>('DB_NAME'),
        username: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        entities: [UserEntity, DriverEntity, TripEntity, WhatsAppInboxEntity],
        synchronize: false,
        logging: false,
        extra: {
          max: 30,
          min: 2,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        },
      }),
    }),
    RedisModule,
    FraudModule,
    UsersModule,
    AuthModule,
    RidesModule,
    BiddingModule,
    WhatsAppModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
