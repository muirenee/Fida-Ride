export type FraudAction = 'observe' | 'flagged' | 'suspended';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';

export type FraudReasonCode =
  | 'device_parallel_accounts'
  | 'device_clock_skew'
  | 'device_timestamp_invalid'
  | 'mock_location_reported'
  | 'telemetry_velocity_jump';

export interface FraudSignal {
  code: FraudReasonCode;
  weight: number;
  metadata?: Record<string, unknown>;
}

export interface ApiRiskMetadata {
  deviceId?: string;
  deviceTimestampMs?: number;
  deviceTimestampInvalid?: boolean;
  mockLocation?: boolean;
  requestId?: string;
  method?: string;
  path?: string;
  remoteIp?: string;
}

export interface TelemetryVelocityJumpEvent {
  event: 'telemetry_velocity_jump';
  driver_id: string;
  speed_kph: number;
  distance_meters: number;
  elapsed_ms: number;
  previous: {
    latitude: number;
    longitude: number;
    observed_at_ms: number;
  };
  current: {
    latitude: number;
    longitude: number;
    observed_at_ms: number;
  };
  observed_at: string;
}

export interface FraudAssessmentResult {
  riskScore: number;
  confidence: number;
  action: FraudAction;
  signals: FraudSignal[];
}
