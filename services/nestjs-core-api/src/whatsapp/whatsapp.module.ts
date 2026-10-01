import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppInboxEntity } from '../database/entities/whatsapp-inbox.entity';
import { RidesModule } from '../rides/rides.module';
import { UsersModule } from '../users/users.module';
import { BookingLlmService } from './booking-llm.service';
import { BookingParserService } from './booking-parser.service';
import { GeocodingService } from './geocoding.service';
import { WhatsAppBookingProcessorService } from './whatsapp-booking-processor.service';
import { WhatsAppCloudService } from './whatsapp-cloud.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { WhatsAppSessionService } from './whatsapp-session.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsAppInboxEntity]), UsersModule, RidesModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppSignatureService,
    WhatsAppInboxService,
    WhatsAppCloudService,
    WhatsAppSessionService,
    BookingLlmService,
    BookingParserService,
    GeocodingService,
    WhatsAppBookingProcessorService,
  ],
})
export class WhatsAppModule {}
