type Env = Record<string, unknown>;

function requiredString(env: Env, key: string): string {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function integer(env: Env, key: string, fallback: number, min = 0): number {
  const raw = String(env[key] ?? fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
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
  };
}
