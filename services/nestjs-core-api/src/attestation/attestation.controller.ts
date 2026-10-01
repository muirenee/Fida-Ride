import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AttestationVerificationService } from './attestation-verification.service';
import { AttestationChallengeDto, AttestationVerifyDto } from './dto/attestation.dto';

@Controller('attestation')
export class AttestationController {
  constructor(private readonly attestation: AttestationVerificationService) {}

  @Post('challenge')
  @HttpCode(HttpStatus.CREATED)
  challenge(@Body() dto: AttestationChallengeDto) {
    return this.attestation.issueChallenge(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: AttestationVerifyDto) {
    return this.attestation.verify(dto);
  }
}
