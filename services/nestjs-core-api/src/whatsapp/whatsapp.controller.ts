import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { WhatsAppWebhookPayload } from './dto/whatsapp-webhook.dto';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';

interface RequestWithRawBody {
  rawBody?: Buffer;
}

@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly signature: WhatsAppSignatureService,
    private readonly inbox: WhatsAppInboxService,
  ) {}

  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.signature.verifyChallenge(mode, token, challenge);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Req() request: RequestWithRawBody,
    @Headers('x-hub-signature-256') signature256: string | undefined,
    @Headers('x-hub-signature') legacySignature: string | undefined,
    @Body() payload: WhatsAppWebhookPayload,
  ): Promise<{ received: true; queued: number }> {
    this.signature.assertValidWebhook(request.rawBody, signature256, legacySignature);
    const queued = await this.inbox.enqueue(payload);
    return { received: true, queued };
  }
}
