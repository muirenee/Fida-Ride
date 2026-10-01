type Env = Record<string, unknown>;

function requiredString(env: Env, key: string): string {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(env: Env, key: string, fallback = ''): string {
  return String(env[key] ?? fallback).trim();
}

function integer(env: Env, key: string, fallback: number, min = 0): number {
  const raw = String(env[key] ?? fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return value;
}

function decimal(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = String(env[key] ?? fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

function boolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = String(env[key] ?? fallback).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

export function validateEnvironment(env: Env): Record<string, unknown> {
  const jwtSecret = requiredString(env, 'JWT_HS256_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_HS256_SECRET must contain at least 32 characters');
  }

  const otpSecret = requiredString(env, 'OTP_HMAC_SECRET');
  if (otpSecret.length < 32) {
    throw new Error('OTP_HMAC_SECRET must contain at least 32 characters');
  }

  const fraudEnabled = boolean(env, 'FRAUD_DETECTION_ENABLED', false);
  let fraudDeviceHmacSecret = optionalString(env, 'FRAUD_DEVICE_HMAC_SECRET');
  if (fraudEnabled) {
    fraudDeviceHmacSecret = requiredString(env, 'FRAUD_DEVICE_HMAC_SECRET');
    if (fraudDeviceHmacSecret.length < 32) {
      throw new Error('FRAUD_DEVICE_HMAC_SECRET must contain at least 32 characters');
    }
  }
  const fraudFlagThreshold = integer(env, 'FRAUD_FLAG_THRESHOLD', 70, 1);
  const fraudSuspendThreshold = integer(env, 'FRAUD_SUSPEND_THRESHOLD', 90, 1);
  if (fraudFlagThreshold >= fraudSuspendThreshold) {
    throw new Error('FRAUD_FLAG_THRESHOLD must be less than FRAUD_SUSPEND_THRESHOLD');
  }

  const whatsappEnabled = boolean(env, 'WHATSAPP_BOT_ENABLED', false);
  const whatsappLlmEnabled = boolean(env, 'WHATSAPP_BOOKING_LLM_ENABLED', false);

  let whatsappVerifyToken = optionalString(env, 'WHATSAPP_VERIFY_TOKEN');
  let whatsappAppSecret = optionalString(env, 'WHATSAPP_APP_SECRET');
  let whatsappAccessToken = optionalString(env, 'WHATSAPP_ACCESS_TOKEN');
  let whatsappPhoneNumberId = optionalString(env, 'WHATSAPP_PHONE_NUMBER_ID');
  let whatsappGraphApiVersion = optionalString(env, 'WHATSAPP_GRAPH_API_VERSION');
  let googleGeocodingApiKey = optionalString(env, 'GOOGLE_GEOCODING_API_KEY');
  let openAiApiKey = optionalString(env, 'OPENAI_API_KEY');
  let llmModel = optionalString(env, 'WHATSAPP_BOOKING_LLM_MODEL');

  if (whatsappEnabled) {
    whatsappVerifyToken = requiredString(env, 'WHATSAPP_VERIFY_TOKEN');
    whatsappAppSecret = requiredString(env, 'WHATSAPP_APP_SECRET');
    whatsappAccessToken = requiredString(env, 'WHATSAPP_ACCESS_TOKEN');
    whatsappPhoneNumberId = requiredString(env, 'WHATSAPP_PHONE_NUMBER_ID');
    whatsappGraphApiVersion = requiredString(env, 'WHATSAPP_GRAPH_API_VERSION');
    googleGeocodingApiKey = requiredString(env, 'GOOGLE_GEOCODING_API_KEY');
  }

  if (whatsappLlmEnabled) {
    openAiApiKey = requiredString(env, 'OPENAI_API_KEY');
    llmModel = requiredString(env, 'WHATSAPP_BOOKING_LLM_MODEL');
  }

  const surgeEnabled = boolean(env, 'SURGE_PRICING_ENABLED', false);
  const surgeRefreshIntervalMs = integer(env, 'SURGE_REFRESH_INTERVAL_MS', 10000, 1000);
  const surgeRefreshLockTtlMs = integer(env, 'SURGE_REFRESH_LOCK_TTL_MS', 30000, 1000);
  const surgeStartMultiplier = decimal(env, 'SURGE_START_MULTIPLIER', 1.2, 1, 5);
  const surgeMaxMultiplier = decimal(env, 'SURGE_MAX_MULTIPLIER', 3, 1, 5);
  if (surgeStartMultiplier > surgeMaxMultiplier) {
    throw new Error('SURGE_START_MULTIPLIER must be <= SURGE_MAX_MULTIPLIER');
  }
  if (surgeRefreshLockTtlMs < surgeRefreshIntervalMs) {
    throw new Error('SURGE_REFRESH_LOCK_TTL_MS must be >= SURGE_REFRESH_INTERVAL_MS');
  }

  return {
    ...env,
    NODE_ENV: String(env.NODE_ENV ?? 'development'),
    PORT: integer(env, 'PORT', 3000, 1),
    DB_HOST: String(env.DB_HOST ?? 'postgres'),
    DB_PORT: integer(env, 'DB_PORT', 5432, 1),
    DB_NAME: String(env.DB_NAME ?? env.POSTGRES_DB ?? 'fida_ride'),
    DB_USER: String(env.DB_USER ?? env.POSTGRES_USER ?? 'fida_ride'),
    DB_PASSWORD: requiredString(env, 'DB_PASSWORD'),
    REDIS_HOST: String(env.REDIS_HOST ?? 'redis'),
    REDIS_PORT: integer(env, 'REDIS_PORT_INTERNAL', 6379, 1),
    REDIS_PASSWORD: requiredString(env, 'REDIS_PASSWORD'),
    REDIS_DB: integer(env, 'CORE_REDIS_DB', 0, 0),
    JWT_HS256_SECRET: jwtSecret,
    JWT_ACCESS_TTL_SECONDS: integer(env, 'JWT_ACCESS_TTL_SECONDS', 900, 60),
    OTP_HMAC_SECRET: otpSecret,
    OTP_TTL_SECONDS: integer(env, 'OTP_TTL_SECONDS', 300, 60),
    OTP_MAX_ATTEMPTS: integer(env, 'OTP_MAX_ATTEMPTS', 5, 1),
    OTP_DEV_ECHO: boolean(env, 'OTP_DEV_ECHO', false),
    RIDE_BASE_FARE_RWF: String(env.RIDE_BASE_FARE_RWF ?? '1000'),
    RIDE_PER_KM_RWF: String(env.RIDE_PER_KM_RWF ?? '500'),
    DISPATCH_RADIUS_KM: String(env.DISPATCH_RADIUS_KM ?? '5'),
    DISPATCH_CANDIDATE_LIMIT: integer(env, 'DISPATCH_CANDIDATE_LIMIT', 100, 1),
    BIDDING_TTL_SECONDS: integer(env, 'BIDDING_TTL_SECONDS', 120, 30),
    BIDDING_ACCEPT_LOCK_TTL_MS: integer(env, 'BIDDING_ACCEPT_LOCK_TTL_MS', 10000, 1000),
    FRAUD_DETECTION_ENABLED: fraudEnabled,
    FRAUD_DEVICE_HMAC_SECRET: fraudDeviceHmacSecret,
    FRAUD_RISK_WINDOW_SECONDS: integer(env, 'FRAUD_RISK_WINDOW_SECONDS', 900, 60),
    FRAUD_DEVICE_BIND_TTL_SECONDS: integer(env, 'FRAUD_DEVICE_BIND_TTL_SECONDS', 120, 30),
    FRAUD_DEVICE_CLOCK_SKEW_MS: integer(env, 'FRAUD_DEVICE_CLOCK_SKEW_MS', 300000, 1000),
    FRAUD_ACCOUNT_STATE_CACHE_SECONDS: integer(env, 'FRAUD_ACCOUNT_STATE_CACHE_SECONDS', 60, 5),
    FRAUD_BLOCK_CACHE_TTL_SECONDS: integer(env, 'FRAUD_BLOCK_CACHE_TTL_SECONDS', 86400, 60),
    FRAUD_FLAG_THRESHOLD: fraudFlagThreshold,
    FRAUD_SUSPEND_THRESHOLD: fraudSuspendThreshold,
    FRAUD_WEIGHT_DEVICE_PARALLEL_ACCOUNT: integer(env, 'FRAUD_WEIGHT_DEVICE_PARALLEL_ACCOUNT', 45, 1),
    FRAUD_WEIGHT_DEVICE_CLOCK_SKEW: integer(env, 'FRAUD_WEIGHT_DEVICE_CLOCK_SKEW', 20, 1),
    FRAUD_WEIGHT_INVALID_DEVICE_TIMESTAMP: integer(env, 'FRAUD_WEIGHT_INVALID_DEVICE_TIMESTAMP', 15, 1),
    FRAUD_WEIGHT_MOCK_LOCATION: integer(env, 'FRAUD_WEIGHT_MOCK_LOCATION', 70, 1),
    FRAUD_WEIGHT_VELOCITY_JUMP: integer(env, 'FRAUD_WEIGHT_VELOCITY_JUMP', 50, 1),
    SURGE_PRICING_ENABLED: surgeEnabled,
    SURGE_REFRESH_INTERVAL_MS: surgeRefreshIntervalMs,
    SURGE_REFRESH_LOCK_TTL_MS: surgeRefreshLockTtlMs,
    SURGE_CACHE_TTL_SECONDS: integer(env, 'SURGE_CACHE_TTL_SECONDS', 45, 5),
    SURGE_DEMAND_WINDOW_SECONDS: integer(env, 'SURGE_DEMAND_WINDOW_SECONDS', 600, 30),
    SURGE_RATIO_THRESHOLD: decimal(env, 'SURGE_RATIO_THRESHOLD', 1.5, 0.1, 100),
    SURGE_START_MULTIPLIER: surgeStartMultiplier,
    SURGE_MAX_MULTIPLIER: surgeMaxMultiplier,
    SURGE_PROGRESSIVE_SLOPE: decimal(env, 'SURGE_PROGRESSIVE_SLOPE', 0.4, 0, 10),
    SURGE_DRIVER_PREFILTER_LIMIT: integer(env, 'SURGE_DRIVER_PREFILTER_LIMIT', 20000, 100),
    SURGE_DB_STATEMENT_TIMEOUT_MS: integer(env, 'SURGE_DB_STATEMENT_TIMEOUT_MS', 1500, 100),
    SURGE_DB_LOCK_TIMEOUT_MS: integer(env, 'SURGE_DB_LOCK_TIMEOUT_MS', 100, 10),
    SURGE_DB_IDLE_TX_TIMEOUT_MS: integer(env, 'SURGE_DB_IDLE_TX_TIMEOUT_MS', 3000, 500),
    WHATSAPP_BOT_ENABLED: whatsappEnabled,
    WHATSAPP_VERIFY_TOKEN: whatsappVerifyToken,
    WHATSAPP_APP_SECRET: whatsappAppSecret,
    WHATSAPP_ACCESS_TOKEN: whatsappAccessToken,
    WHATSAPP_PHONE_NUMBER_ID: whatsappPhoneNumberId,
    WHATSAPP_GRAPH_API_VERSION: whatsappGraphApiVersion,
    WHATSAPP_ALLOW_LEGACY_SHA1: boolean(env, 'WHATSAPP_ALLOW_LEGACY_SHA1', false),
    WHATSAPP_OUTBOUND_TIMEOUT_MS: integer(env, 'WHATSAPP_OUTBOUND_TIMEOUT_MS', 8000, 1000),
    WHATSAPP_WORKER_POLL_MS: integer(env, 'WHATSAPP_WORKER_POLL_MS', 500, 100),
    WHATSAPP_WORKER_BATCH_SIZE: integer(env, 'WHATSAPP_WORKER_BATCH_SIZE', 10, 1),
    WHATSAPP_WORKER_MAX_ATTEMPTS: integer(env, 'WHATSAPP_WORKER_MAX_ATTEMPTS', 5, 1),
    WHATSAPP_PROCESSING_LEASE_SECONDS: integer(env, 'WHATSAPP_PROCESSING_LEASE_SECONDS', 120, 30),
    WHATSAPP_SESSION_TTL_SECONDS: integer(env, 'WHATSAPP_SESSION_TTL_SECONDS', 1800, 60),
    WHATSAPP_BOOKING_MIN_CONFIDENCE: decimal(env, 'WHATSAPP_BOOKING_MIN_CONFIDENCE', 0.85, 0, 1),
    WHATSAPP_BOOKING_LLM_ENABLED: whatsappLlmEnabled,
    WHATSAPP_BOOKING_LLM_MODEL: llmModel,
    WHATSAPP_BOOKING_LLM_TIMEOUT_MS: integer(env, 'WHATSAPP_BOOKING_LLM_TIMEOUT_MS', 6000, 500),
    WHATSAPP_BOOKING_LLM_BYPASS_CONFIDENCE: decimal(
      env,
      'WHATSAPP_BOOKING_LLM_BYPASS_CONFIDENCE',
      0.92,
      0,
      1,
    ),
    OPENAI_API_KEY: openAiApiKey,
    GOOGLE_GEOCODING_API_KEY: googleGeocodingApiKey,
    GOOGLE_GEOCODING_REGION: optionalString(env, 'GOOGLE_GEOCODING_REGION', 'rw'),
    GOOGLE_GEOCODING_COUNTRY: optionalString(env, 'GOOGLE_GEOCODING_COUNTRY', 'RW'),
    GOOGLE_GEOCODING_BOUNDS: optionalString(env, 'GOOGLE_GEOCODING_BOUNDS'),
    GOOGLE_GEOCODING_TIMEOUT_MS: integer(env, 'GOOGLE_GEOCODING_TIMEOUT_MS', 5000, 500),
    GOOGLE_GEOCODING_MIN_CONFIDENCE: decimal(env, 'GOOGLE_GEOCODING_MIN_CONFIDENCE', 0.82, 0, 1),
  };
}
