import { Module } from '@nestjs/common';
import { AttestationController } from './attestation.controller';
import { AttestationVerificationGuard } from './attestation-verification.guard';
import { AttestationVerificationService } from './attestation-verification.service';

@Module({
  controllers: [AttestationController],
  providers: [AttestationVerificationService, AttestationVerificationGuard],
  exports: [AttestationVerificationService, AttestationVerificationGuard],
})
export class AttestationModule {}
