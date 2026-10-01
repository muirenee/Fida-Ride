import { SetMetadata } from '@nestjs/common';
import { AttestationAction } from './dto/attestation.dto';

export const ATTESTATION_ACTION_METADATA = 'fida:attestation-action';

export const RequireAttestation = (action: AttestationAction) =>
  SetMetadata(ATTESTATION_ACTION_METADATA, action);
