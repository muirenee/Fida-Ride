import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'nestjs-core-api' };
  }
}
