import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FraudDetectionInterceptor } from './fraud-detection.interceptor';
import { FraudDetectionService } from './fraud-detection.service';
import { FraudTelemetryConsumerService } from './fraud-telemetry-consumer.service';

@Global()
@Module({
  providers: [
    FraudDetectionService,
    FraudTelemetryConsumerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: FraudDetectionInterceptor,
    },
  ],
  exports: [FraudDetectionService],
})
export class FraudModule {}
